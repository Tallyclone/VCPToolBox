const assert = require("assert");
const Database = require("better-sqlite3");
const { runMigrations } = require("../core/migrations");
const { processOperation } = require("../core/operationProcessor");
const { checksumConfigDto } = require("../core/configService");
const { exportBaseline, importBootstrap } = require("../core/bootstrapService");

function createRuntime() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const logger = { info() {}, warn() {}, error() {} };
  runMigrations(db, logger);
  return { dbContext: { db }, config: { maxLimit: 5000 }, logger };
}

function ownerConfig(itemType, itemId, profile, dto) {
  const folder = itemType === "group" ? "AgentGroups" : "Agents";
  const entityId = `${folder}/${encodeURIComponent(itemId)}/config.json`;
  const payload = {
    dto_version: 1,
    schema: `${itemType}_config`,
    entity_id: entityId,
    relative_path: entityId,
    profile,
    projection_fields: Object.keys(dto),
    deleted_fields: [],
    safe_projection_json: dto,
  };
  payload.checksum = checksumConfigDto(payload);
  return payload;
}

function applyConfig(db, payload, operationId) {
  return processOperation(db, {
    operation_id: operationId,
    device_id: "owner-export-source",
    entity_type: payload.schema,
    entity_id: payload.entity_id,
    action: "update",
    payload,
  });
}

function assertEncodedOwnerDeletion() {
  const runtime = createRuntime();
  const db = runtime.dbContext.db;
  try {
    for (const itemType of ["agent", "group"]) {
      for (const itemId of ["owner space", "owner name%20"]) {
        const prefix = `${itemType}:${itemId}`;
        processOperation(db, {
          operation_id: `${prefix}:delete`,
          device_id: "owner-export-source",
          entity_type: "item",
          entity_id: itemId,
          item_type: itemType,
          item_id: itemId,
          action: "delete",
        });
        for (const profile of ["bootstrap", "runtime"]) {
          const payload = ownerConfig(itemType, itemId, profile, {
            name: "Offline owner",
            topics: [{ id: "offline-topic", name: "Offline topic" }],
          });
          const operationId = `${prefix}:${profile}:offline`;
          const result = applyConfig(db, payload, operationId);
          assert.strictEqual(result.ok, true);
          assert.strictEqual(result.deleted, true);
          assert.strictEqual(result.conflict, true);
          assert.strictEqual(result.resolution, "delete_wins");
          const replay = applyConfig(db, payload, operationId);
          assert.strictEqual(replay.idempotent, true);
          assert.strictEqual(replay.deleted, true);
          assert.strictEqual(replay.seq, result.seq);
        }
      }
    }
    // Tombstone-only owners must not be recreated under an encoded alias.
    for (const table of ["items", "topics", "config_entities"]) {
      assert.strictEqual(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    assert.deepStrictEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
}

function seedOwner(db, itemType, itemId) {
  for (const profile of ["bootstrap", "runtime"]) {
    applyConfig(db, ownerConfig(itemType, itemId, profile, {
      name: `${profile} ${itemType}`,
      topics: [],
    }), `seed:${itemType}:${profile}`);
  }
  const topics = [
    { id: "ui-state", name: "UI state", createdAt: 0, locked: false, unread: 0, creatorSource: "" },
    { id: "legacy-time", name: "Legacy time", created_at: "2001-02-03T04:05:06.000Z", timestamp: 123 },
    { id: "epoch-time", name: "Epoch time", timestamp: 0 },
    { id: "server-time", name: "Server time" },
  ];
  for (const topic of topics) {
    // Raw API owner IDs must retain their literal %20 suffix.
    const result = processOperation(db, {
      operation_id: `topic:${itemType}:${topic.id}`,
      device_id: "owner-export-source",
      entity_type: "topic",
      entity_id: topic.id,
      item_type: itemType,
      item_id: itemId,
      topic_id: topic.id,
      action: "upsert",
      payload: { topic: { ...topic, internalOnly: "kept in standalone topics" } },
    });
    assert.strictEqual(result.ok, true);
  }
  processOperation(db, {
    operation_id: `message:${itemType}`,
    device_id: "owner-export-source",
    entity_type: "message",
    entity_id: "message",
    item_type: itemType,
    item_id: itemId,
    topic_id: "ui-state",
    action: "create",
    payload: { message: { id: "message", role: "user", content: `hello ${itemType}` } },
  });
}

function assertExportImportRoundTrip() {
  const source = createRuntime();
  const target = createRuntime();
  const sourceDb = source.dbContext.db;
  const targetDb = target.dbContext.db;
  const owners = [["agent", "agent owner%20"], ["group", "group owner%20"]];
  try {
    for (const [itemType, itemId] of owners) seedOwner(sourceDb, itemType, itemId);
    const exported = exportBaseline(source, { kind: "all" });
    assert.strictEqual(exported.baseline.configs.length, 4);
    assert.strictEqual(exported.baseline.topics.length, 8);
    assert.strictEqual(exported.baseline.messages.length, 2);
    for (const [itemType, itemId] of owners) {
      const richTopics = exported.baseline.topics.filter((topic) => topic.item_type === itemType);
      assert.ok(richTopics.every((topic) => topic.item_id === itemId));
      assert.ok(richTopics.every((topic) => topic.order_version > 0));
      assert.ok(richTopics.every((topic) => topic.metadata.internalOnly === "kept in standalone topics"));
      const serverTimestamp = sourceDb.prepare(
        "SELECT created_at FROM topics WHERE item_type = ? AND item_id = ? AND id = 'server-time'"
      ).get(itemType, itemId).created_at;
      const expectedTopics = [
        { id: "server-time", name: "Server time", createdAt: serverTimestamp },
        { id: "epoch-time", name: "Epoch time", createdAt: 0 },
        { id: "legacy-time", name: "Legacy time", createdAt: "2001-02-03T04:05:06.000Z" },
        { id: "ui-state", name: "UI state", createdAt: 0, locked: false, unread: 0, creatorSource: "" },
      ];
      for (const config of exported.baseline.configs.filter((row) => row.schema === `${itemType}_config`)) {
        assert.deepStrictEqual(config.safe_projection_json.topics, expectedTopics);
        assert.strictEqual(config.checksum, checksumConfigDto(config));
      }
    }

    // Use the exported configs as-is: bootstrap/runtime rows share entity IDs.
    // Their generated import operation IDs must still be distinct.
    const imported = importBootstrap(target, {
      ...exported.baseline,
      device_id: "owner-export-target",
      mode: "bootstrap_primary",
    });
    assert.strictEqual(imported.ok, true);
    assert.strictEqual(imported.authoritative_configs.length, 4);
    assert.strictEqual(targetDb.prepare("SELECT COUNT(*) AS count FROM config_entities").get().count, 4);
    assert.strictEqual(targetDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 2);
    const reexported = exportBaseline(target, { kind: "all" });
    for (const config of exported.baseline.configs) {
      const restored = reexported.baseline.configs.find((row) =>
        row.schema === config.schema && row.entity_id === config.entity_id && row.profile === config.profile
      );
      assert.ok(restored);
      assert.deepStrictEqual(restored.safe_projection_json, config.safe_projection_json);
      assert.strictEqual(restored.checksum, config.checksum);
    }
    for (const [itemType, itemId] of owners) {
      assert.deepStrictEqual(targetDb.prepare(
        "SELECT item_id, deleted FROM items WHERE item_type = ?"
      ).all(itemType), [{ item_id: itemId, deleted: 0 }]);
      assert.strictEqual(targetDb.prepare(
        "SELECT COUNT(*) AS count FROM topics WHERE item_type = ? AND item_id = ? AND deleted = 0"
      ).get(itemType, itemId).count, 4);
      const message = targetDb.prepare(
        "SELECT raw_json FROM messages WHERE item_type = ? AND item_id = ? AND id = 'message'"
      ).get(itemType, itemId);
      assert.strictEqual(JSON.parse(message.raw_json).content, `hello ${itemType}`);
    }
    assert.deepStrictEqual(targetDb.pragma("foreign_key_check"), []);
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}

function assertImportOperationIds() {
  const runtime = createRuntime();
  const db = runtime.dbContext.db;
  try {
    const configs = ["bootstrap", "runtime", "manual"].map((profile) => ({
      dto_version: 1,
      schema: "settings",
      relative_path: "settings.json",
      profile,
      projection_fields: ["userName"],
      safe_projection_json: { userName: profile },
    }));
    configs[0].operation_id = "explicit-bootstrap-config";
    configs[2] = { operation_id: "explicit-manual-config", payload: configs[2] };
    const imported = importBootstrap(runtime, { device_id: "relative-path-device", configs });
    assert.strictEqual(imported.ok, true);
    assert.deepStrictEqual(db.prepare(
      "SELECT profile, operation_id FROM config_entities ORDER BY profile"
    ).all(), [
      { profile: "bootstrap", operation_id: "explicit-bootstrap-config" },
      { profile: "manual", operation_id: "explicit-manual-config" },
      { profile: "runtime", operation_id: "bootstrap.config.relative-path-device.settings.runtime.settings.json" },
    ]);
  } finally {
    db.close();
  }
}

assertEncodedOwnerDeletion();
assertExportImportRoundTrip();
assertImportOperationIds();
console.log("config owner/export smoke test passed");
