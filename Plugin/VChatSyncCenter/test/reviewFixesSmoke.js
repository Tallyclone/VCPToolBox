const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase, closeDatabase } = require("../core/db");
const { processOperation, registerDevice } = require("../core/operationProcessor");
const { getChanges, getLatestSeq } = require("../core/changeLog");
const { getGeneration } = require("../core/centerMeta");
const { importBootstrap, exportBaseline } = require("../core/bootstrapService");
const { checksumConfigDto, configSnapshotFromRow } = require("../core/configSnapshot");
const {
  createDatabaseBackup,
  restoreDatabaseBackup,
  pruneBackups,
  parseInterval,
  startBackupScheduler,
  stopBackupScheduler,
  getBackupStatus,
  runScheduledBackup,
} = require("../core/backupService");

const logger = { warn() {}, info() {}, error() {} };

function makeRuntime(root, extraConfig = {}) {
  const config = {
    dbPath: path.join(root, "center.db"),
    attachmentDir: path.join(root, "attachments"),
    backupDir: path.join(root, "backups"),
    maxLimit: 5000,
    enabled: true,
    backupInterval: "6h",
    backupRetentionDays: 30,
    ...extraConfig,
  };
  const runtime = { config, logger, dbContext: null };
  runtime.dbContext = ensureDatabase(config, logger);
  return runtime;
}

function messageOp(id, itemId, topicId, messageId, action = "create", content = id) {
  return {
    operation_id: id, device_id: "device-a",
    entity_type: "message", entity_id: messageId, action,
    item_type: "agent", item_id: itemId, topic_id: topicId,
    payload: { message: { id: messageId, role: "user", content } },
  };
}

function topicOp(id, itemId, topicId) {
  return {
    operation_id: id, device_id: "device-a",
    entity_type: "topic", entity_id: topicId, action: "upsert",
    item_type: "agent", item_id: itemId, topic_id: topicId,
    payload: { topic: { id: topicId, name: topicId } },
  };
}

// Issue 1 (Center side): a create conflict is reported with a stable code and
// the version an update must be based on, both on first submit and replay.
function testCreateConflictResponse(runtime) {
  const db = runtime.dbContext.db;
  processOperation(db, topicOp("t1", "a1", "topic"));
  processOperation(db, messageOp("m-first", "a1", "topic", "m1", "create", "first"));
  const conflict = processOperation(db, messageOp("m-dup", "a1", "topic", "m1", "create", "second"));
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.code, "MESSAGE_CREATE_CONFLICT");
  assert.strictEqual(conflict.version, 1);
  assert.strictEqual(conflict.deleted, false);
  const replay = processOperation(db, messageOp("m-dup", "a1", "topic", "m1", "create", "second"));
  assert.strictEqual(replay.idempotent, true);
  assert.strictEqual(replay.code, "MESSAGE_CREATE_CONFLICT");
  assert.strictEqual(replay.version, 1);
  const update = processOperation(db, { ...messageOp("m-upd", "a1", "topic", "m1", "update", "second"), base_version: 1 });
  assert.strictEqual(update.ok, true);
  assert.strictEqual(update.version, 2);
}

// Issue 7: a retried import with the same session id returns the completed
// result instead of "center is not empty".
function testBootstrapImportReplay(root) {
  const runtime = makeRuntime(root);
  try {
    registerDevice(runtime.dbContext.db, { device_id: "device-a" });
    const manifest = {
      mode: "bootstrap_primary", device_id: "device-a", session_id: "session-1",
      configs: [{
        payload: {
          dto_version: 1, schema: "agent_config", entity_id: "Agents/a1/config.json",
          relative_path: "Agents/a1/config.json", profile: "bootstrap",
          projection_fields: ["name", "topics"], deleted_fields: [],
          safe_projection_json: { name: "A", topics: [{ id: "topic", name: "Topic" }] },
        },
      }],
      messages: [{ item_type: "agent", item_id: "a1", topic_id: "topic", id: "m1",
        message: { id: "m1", role: "user", content: "hello" }, local_order: 0 }],
    };
    const first = importBootstrap(runtime, manifest);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.imported.messages, 1);
    assert(first.generation);
    const seqAfterFirst = getLatestSeq(runtime.dbContext.db);
    const replay = importBootstrap(runtime, manifest);
    assert.strictEqual(replay.ok, true);
    assert.strictEqual(replay.idempotent, true);
    assert.strictEqual(replay.session_id, "session-1");
    assert.strictEqual(replay.latest_seq, first.latest_seq);
    assert.deepStrictEqual(replay.imported, first.imported);
    assert.strictEqual(replay.authoritative_configs.length, first.authoritative_configs.length);
    assert.strictEqual(getLatestSeq(runtime.dbContext.db), seqAfterFirst, "replay must not import twice");
    assert.throws(
      () => importBootstrap(runtime, { ...manifest, session_id: "session-2" }),
      (error) => error.code === "BOOTSTRAP_CENTER_NOT_EMPTY" && error.statusCode === 409
    );
    assert.strictEqual(exportBaseline(runtime, { kind: "configs" }).generation, first.generation);
  } finally {
    closeDatabase(runtime.dbContext);
  }
}

// Issue 6: restoring a backup rotates the generation so clients detect that
// sequence numbers may be reused.
async function testRestoreRotatesGeneration(root) {
  const runtime = makeRuntime(root);
  try {
    const db = () => runtime.dbContext.db;
    registerDevice(db(), { device_id: "device-a" });
    const before = getGeneration(db());
    processOperation(db(), topicOp("t1", "a1", "topic"));
    const backup = await createDatabaseBackup(runtime, { label: "test" });
    assert.strictEqual(backup.backup.generation, before);
    processOperation(db(), messageOp("m1", "a1", "topic", "m1"));
    const restored = await restoreDatabaseBackup(runtime, { name: backup.backup.name, allow_seq_downgrade: true });
    assert.strictEqual(restored.clients_must_rebootstrap, true);
    assert.notStrictEqual(restored.generation, before);
    assert.strictEqual(getGeneration(db()), restored.generation);
    assert.strictEqual(restored.previous_generation, before);
    // Reused sequence numbers are now distinguishable by generation.
    processOperation(db(), messageOp("m1-after-restore", "a1", "topic", "m1"));
    const events = getChanges(db(), 0);
    assert(events.some((event) => event.operation_id === "m1-after-restore"));
  } finally {
    closeDatabase(runtime.dbContext);
  }
}

// Issue 5: automatic backups are scheduled from the configured interval and
// retention prunes old backups while keeping the newest and pre-restore ones.
async function testBackupSchedulerAndRetention(root) {
  assert.strictEqual(parseInterval("6h"), 6 * 60 * 60 * 1000);
  assert.strictEqual(parseInterval("90m"), 90 * 60 * 1000);
  assert.strictEqual(parseInterval("1d"), 24 * 60 * 60 * 1000);
  assert.strictEqual(parseInterval("0"), 0);
  assert.strictEqual(parseInterval("off"), 0);
  assert.strictEqual(parseInterval("soon"), null);

  const runtime = makeRuntime(root, { backupInterval: "6h", backupRetentionDays: 1 });
  try {
    const disabledStatus = getBackupStatus(runtime);
    assert.strictEqual(disabledStatus.enabled, false, "status must not claim backups run before the scheduler starts");
    startBackupScheduler(runtime);
    const status = getBackupStatus(runtime);
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.interval_ms, 6 * 60 * 60 * 1000);
    assert(status.scheduler.next_run_at);
    const run = await runScheduledBackup(runtime, "test");
    assert.strictEqual(run.ok, true);
    assert.strictEqual(getBackupStatus(runtime).scheduler.runs, 1);

    // Age two backups beyond retention; the newest and pre-restore copies stay.
    const old1 = await createDatabaseBackup(runtime, { label: "old-one" });
    const old2 = await createDatabaseBackup(runtime, { label: "pre-restore" });
    const newest = await createDatabaseBackup(runtime, { label: "newest" });
    const ancient = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const item of [old1.backup, old2.backup, run.backup]) {
      fs.utimesSync(item.path, ancient, ancient);
    }
    const pruned = pruneBackups(runtime.config);
    assert.deepStrictEqual(pruned.removed.sort(), [old1.backup.name, run.backup.name].sort());
    assert(fs.existsSync(old2.backup.path), "pre-restore backups are never pruned");
    assert(fs.existsSync(newest.backup.path));
    stopBackupScheduler(runtime);
    assert.strictEqual(getBackupStatus(runtime).enabled, false);

    const invalid = makeRuntime(path.join(root, "invalid"), { backupInterval: "soon" });
    try {
      startBackupScheduler(invalid);
      assert.strictEqual(getBackupStatus(invalid).enabled, false);
      assert.strictEqual(getBackupStatus(invalid).interval_valid, false);
    } finally {
      stopBackupScheduler(invalid);
      closeDatabase(invalid.dbContext);
    }
  } finally {
    stopBackupScheduler(runtime);
    closeDatabase(runtime.dbContext);
  }
}

// Issue 11: deleting a group member updates the cumulative config snapshot
// stored under the Adapter's relative-path entity id, with the shared checksum.
function testGroupMemberDeleteUpdatesSnapshot(root) {
  const runtime = makeRuntime(root);
  try {
    const db = runtime.dbContext.db;
    registerDevice(db, { device_id: "device-a" });
    const entityId = "AgentGroups/g1/config.json";
    const dto = { id: "g1", name: "Group", members: ["alice", "bob"], memberTags: { alice: ["x"], bob: ["y"] } };
    const payload = {
      dto_version: 1, schema: "group_config", entity_id: entityId, relative_path: entityId,
      profile: "bootstrap", projection_fields: ["id", "name", "members", "memberTags"], deleted_fields: [],
      safe_projection_json: dto,
    };
    payload.checksum = checksumConfigDto(payload);
    assert.strictEqual(processOperation(db, {
      operation_id: "g1-create", device_id: "device-a", entity_type: "group_config",
      entity_id: entityId, action: "create", payload,
    }).ok, true);
    const result = processOperation(db, {
      operation_id: "g1-remove-alice", device_id: "device-a", entity_type: "group_member",
      entity_id: "alice", action: "delete", item_type: "group", item_id: "g1",
      payload: { group_id: "g1", member_id: "alice" },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.existed, true, "the snapshot under the relative-path id must be found");
    const row = db.prepare("SELECT * FROM config_entities WHERE schema = 'group_config' AND entity_id = ?").get(entityId);
    const snapshot = configSnapshotFromRow(row);
    assert.deepStrictEqual(snapshot.safe_projection_json.members, ["bob"]);
    assert.deepStrictEqual(snapshot.safe_projection_json.memberTags, { bob: ["y"] });
    assert.strictEqual(row.checksum, checksumConfigDto(snapshot), "checksum must use the shared DTO algorithm");
    const exported = exportBaseline(runtime, { kind: "configs" }).baseline.configs
      .find((entry) => entry.entity_id === entityId);
    assert.deepStrictEqual(exported.safe_projection_json.members, ["bob"]);
    assert.strictEqual(exported.checksum, checksumConfigDto(exported));
    // Legacy bare-id rows are still matched.
    const legacyPayload = { ...payload, entity_id: "g2", relative_path: "AgentGroups/g2/config.json",
      safe_projection_json: { ...dto, id: "g2" } };
    legacyPayload.checksum = checksumConfigDto(legacyPayload);
    processOperation(db, { operation_id: "g2-create", device_id: "device-a", entity_type: "group_config",
      entity_id: "g2", action: "create", payload: legacyPayload });
    const legacy = processOperation(db, {
      operation_id: "g2-remove-bob", device_id: "device-a", entity_type: "group_member",
      entity_id: "bob", action: "delete", item_type: "group", item_id: "g2", payload: {},
    });
    assert.strictEqual(legacy.existed, true);
  } finally {
    closeDatabase(runtime.dbContext);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vchat-center-review-fixes-"));
  try {
    const conflictRuntime = makeRuntime(path.join(root, "conflict"));
    try {
      registerDevice(conflictRuntime.dbContext.db, { device_id: "device-a" });
      testCreateConflictResponse(conflictRuntime);
    } finally {
      closeDatabase(conflictRuntime.dbContext);
    }
    testBootstrapImportReplay(path.join(root, "import"));
    await testRestoreRotatesGeneration(path.join(root, "restore"));
    await testBackupSchedulerAndRetention(path.join(root, "backup"));
    testGroupMemberDeleteUpdatesSnapshot(path.join(root, "group"));
    console.log("center review fixes smoke test passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
