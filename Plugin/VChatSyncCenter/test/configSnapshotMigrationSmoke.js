const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const Database = require("better-sqlite3");
const { runMigrations } = require("../core/migrations");
const { appendChange, getLatestSeq } = require("../core/changeLog");
const { applyConfigDelete, applyEntityDelete } = require("../core/deleteService");
const { checksumConfigDto, configSnapshotFromRow } = require("../core/configSnapshot");

// Fingerprints from the released v14 schema, not regenerated from current code.
const V14_CHECKSUMS = [
  "4253e46b297f6bdc725568d06ae857f78aae59e6fb2e3c77ea29eeed18e8280e",
  "03ca1f7bf95624bcf3d478daabc5843ab6fad615e88df7c83a5d91a89223bff2",
  "e750edf2b2548c0d3e4e6f56a3295ca25f9f811377fb3ef2544b3ec1e7b72c21",
  "e274492371527bec8fffa3c59441dfd0e96075b3243875a630e6767b1450da4c",
  "58a8186b7fc4e2072248ea354879aae647ae8d7e753f057c247a97b69d8c65e2",
  "4b9e1dfc508af69ce19c51cf2a5d56bba3c2de509bdf40cd338e2dd9b09156d9",
  "8a4431fa488e883881b875b2997a04df0b9786e8e9acd003538985ba28f80ef4",
  "1b2e5076de849cb0cb0d39894c46a3e0cfef8191c144bc0addbb03affe120e9e",
  "b87a819c0e562837a2bd45409b255daf6f6ca5af95d450180651054894248efc",
  "30c6c32199fc61ec73480c3f9252905130ae1efce13a95f3523379bcfda4f79c",
  "f3405dfbf1273f84a1d53432cafa577d48391d6d1481658c2c3f1148aabe4484",
  "03f344220d98ccfc10670374bb0ca7743be04111e672d0ea1d44be391ad21fe3",
  "45657e69f5ee05f98a85dead811dad2e46f2f93c0e20ca4510771ea81376eed6",
  "4a18a40172e8679b2302b80e5758ac9859e0a97518b90cb44154f94f57611485",
];

function compileModule(filename, source, overrides = {}) {
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const normalRequire = Module.createRequire(filename);
  compiled.require = (request) =>
    Object.prototype.hasOwnProperty.call(overrides, request)
      ? overrides[request]
      : normalRequire(request);
  compiled._compile(source, filename);
  return compiled.exports;
}

// Compile variants in memory so the test does not edit migration source files.
function migrationVariant(lineEnding, legacy = false) {
  const snapshotFile = require.resolve("../core/configSnapshot");
  const snapshot = compileModule(
    snapshotFile,
    fs.readFileSync(snapshotFile, "utf8").replace(/\r?\n/g, lineEnding)
  );
  const migrationFile = require.resolve("../core/migrations");
  let source = fs.readFileSync(migrationFile, "utf8").replace(/\r?\n/g, lineEnding);
  if (legacy) source += "\nwhile (MIGRATIONS.length && MIGRATIONS[MIGRATIONS.length - 1].version > 14) MIGRATIONS.pop();\n";
  return compileModule(migrationFile, source, { "./configSnapshot": snapshot });
}

function main() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const logger = { info() {} };
  migrationVariant("\n", true).runMigrations(db, logger);
  const checksums = () => db
    .prepare("SELECT checksum FROM schema_migrations WHERE version <= 14 ORDER BY version")
    .all().map((row) => row.checksum);
  assert.deepStrictEqual(checksums(), V14_CHECKSUMS);

  let sequence = 0;
  function legacyWrite(entityId, profile, fields, dto, deleted = [], options = {}) {
    const operationId = `legacy-config-${++sequence}`;
    const historyEntityId = options.historyEntityId || entityId;
    const schema = options.schema || "agent_config";
    const payload = {
      dto_version: 1,
      schema,
      entity_id: historyEntityId,
      profile: options.omitHistoryProfile ? undefined : profile,
      projection_fields: fields,
      deleted_fields: deleted,
      safe_projection_json: dto,
    };
    payload.checksum = checksumConfigDto(payload);
    db.prepare(`
INSERT INTO config_entities(schema, entity_id, profile, projection_fields_json, dto_version,
  safe_projection_json, checksum, operation_id, device_id, version, deleted)
VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'migration-device', 1, 0)
ON CONFLICT(schema, entity_id, profile) DO UPDATE SET
  projection_fields_json = excluded.projection_fields_json,
  safe_projection_json = excluded.safe_projection_json, checksum = excluded.checksum,
  operation_id = excluded.operation_id, version = config_entities.version + 1
`).run(schema, entityId, profile, JSON.stringify(fields), JSON.stringify(dto), payload.checksum, operationId);
    if (options.recordHistory === false) return;
    appendChange(db, {
      operation_id: operationId,
      device_id: "migration-device",
      entity_type: schema,
      entity_id: historyEntityId,
      action: "update",
      payload,
    });
  }

  const entityId = "Agents/upgrade/config.json";
  legacyWrite(entityId, "bootstrap", ["name", "systemPrompt"], { name: "base", systemPrompt: "base prompt" });
  legacyWrite(entityId, "runtime", ["name", "advancedSystemPrompt.hiddenBlocks"], {
    name: "first", advancedSystemPrompt: { hiddenBlocks: ["hidden"] },
  });
  legacyWrite(entityId, "runtime", ["name"], { name: "latest" });
  legacyWrite(entityId, "runtime", ["systemPrompt"], {}, ["systemPrompt"]);
  legacyWrite(entityId, "manual", ["name"], { name: "manual" });

  const nestedId = "Agents/nested/config.json";
  legacyWrite(nestedId, "runtime", ["advancedSystemPrompt"], {}, ["advancedSystemPrompt"]);
  legacyWrite(nestedId, "runtime", ["advancedSystemPrompt.hiddenBlocks"], {
    advancedSystemPrompt: { hiddenBlocks: ["restored"] },
  });
  legacyWrite(nestedId, "runtime", ["advancedSystemPrompt.hiddenBlocks"], {}, ["advancedSystemPrompt.hiddenBlocks"]);

  const prefixedId = "Agents/prefixed/config.json";
  legacyWrite(prefixedId, "bootstrap", ["name"], { name: "plain bootstrap" }, [], { omitHistoryProfile: true });
  legacyWrite(prefixedId, "runtime", ["name"], { name: "legacy prefix" }, [], {
    historyEntityId: `runtime:${prefixedId}`, omitHistoryProfile: true,
  });
  legacyWrite(prefixedId, "runtime", ["advancedSystemPrompt.hiddenBlocks"], {
    advancedSystemPrompt: { hiddenBlocks: ["latest"] },
  });
  legacyWrite(prefixedId, "manual", ["name"], { name: "manual prefix" }, [], {
    historyEntityId: `manual:${prefixedId}`, omitHistoryProfile: true,
  });

  const noHistoryId = "Agents/no-history/config.json";
  legacyWrite(noHistoryId, "runtime", ["name"], { name: "no history" }, [], { recordHistory: false });
  const noHistoryBefore = db.prepare("SELECT * FROM config_entities WHERE entity_id = ?").get(noHistoryId);

  const groupId = "legacy-group";
  const groupOptions = { schema: "group_config" };
  legacyWrite(groupId, "runtime", ["name"], { name: "old group" }, [], groupOptions);
  legacyWrite(groupId, "runtime", ["members", "memberTags"], {
    members: ["member-1", "member-2"],
    memberTags: { "member-1": ["remove"], "member-2": ["keep"] },
  }, [], groupOptions);
  applyEntityDelete(db, {
    operation_id: "legacy-member-delete",
    device_id: "migration-device",
    entity_type: "group_member",
    item_type: "group",
    item_id: groupId,
    entity_id: "member-1",
    action: "delete",
  });
  legacyWrite(groupId, "runtime", ["name"], { name: "latest group" }, [], groupOptions);

  const deletedId = "Agents/deleted/config.json";
  legacyWrite(deletedId, "runtime", ["name"], { name: "do not resurrect" });
  applyConfigDelete(db, {
    operation_id: "delete-before-upgrade",
    device_id: "migration-device",
    entity_type: "agent_config",
    entity_id: deletedId,
    action: "delete",
  });
  const deletedBefore = db.prepare("SELECT * FROM config_entities WHERE entity_id = ?").get(deletedId);
  const seqBefore = getLatestSeq(db);
  const rowsBefore = db.prepare("SELECT COUNT(*) AS count FROM config_entities").get().count;
  try {
    const state = runMigrations(db, logger);
    assert.strictEqual(state.currentVersion, 16);
    assert.deepStrictEqual(checksums(), V14_CHECKSUMS);
    assert.strictEqual(getLatestSeq(db), seqBefore);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM config_entities").get().count, rowsBefore);

    const row = (id, profile) => db.prepare(
      "SELECT * FROM config_entities WHERE entity_id = ? AND profile = ?"
    ).get(id, profile);
    const runtime = configSnapshotFromRow(row(entityId, "runtime"));
    assert.deepStrictEqual(runtime.safe_projection_json, {
      name: "latest", advancedSystemPrompt: { hiddenBlocks: ["hidden"] },
    });
    assert.deepStrictEqual(runtime.deleted_fields, ["systemPrompt"]);
    assert.strictEqual(runtime.checksum, checksumConfigDto(runtime));
    assert.deepStrictEqual(JSON.parse(row(entityId, "bootstrap").safe_projection_json), {
      name: "base", systemPrompt: "base prompt",
    });
    assert.deepStrictEqual(JSON.parse(row(entityId, "manual").safe_projection_json), { name: "manual" });

    const nested = configSnapshotFromRow(row(nestedId, "runtime"));
    assert.deepStrictEqual(nested.safe_projection_json, { advancedSystemPrompt: {} });
    assert.ok(nested.projection_fields.includes("advancedSystemPrompt"));
    assert.deepStrictEqual(nested.deleted_fields, ["advancedSystemPrompt.hiddenBlocks"]);
    assert.deepStrictEqual(JSON.parse(row(prefixedId, "runtime").safe_projection_json), {
      name: "legacy prefix", advancedSystemPrompt: { hiddenBlocks: ["latest"] },
    });
    assert.deepStrictEqual(JSON.parse(row(prefixedId, "manual").safe_projection_json), { name: "manual prefix" });
    assert.deepStrictEqual(JSON.parse(row(prefixedId, "bootstrap").safe_projection_json), { name: "plain bootstrap" });
    assert.deepStrictEqual(JSON.parse(row(groupId, "runtime").safe_projection_json), {
      name: "latest group",
      members: ["member-2"],
      memberTags: { "member-2": ["keep"] },
    });

    const noHistoryAfter = row(noHistoryId, "runtime");
    for (const [key, value] of Object.entries(noHistoryBefore)) {
      assert.strictEqual(noHistoryAfter[key], value, `row without history changed: ${key}`);
    }

    const deletedAfter = row(deletedId, "runtime");
    for (const [key, value] of Object.entries(deletedBefore)) {
      assert.strictEqual(deletedAfter[key], value, `deleted row changed: ${key}`);
    }
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM items").get().count, 0);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM topics").get().count, 0);
    assert.deepStrictEqual(db.pragma("foreign_key_check"), []);

    assert.strictEqual(migrationVariant("\r\n").runMigrations(db, logger).currentVersion, 16);
    assert.strictEqual(migrationVariant("\n").runMigrations(db, logger).currentVersion, 16);
    assert.deepStrictEqual(checksums(), V14_CHECKSUMS);
  } finally {
    db.close();
  }
  console.log("config snapshot migration smoke test passed");
}

main();
