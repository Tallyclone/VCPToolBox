const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { ensureDatabase, closeDatabase } = require("../core/db");

function makeConfig(tempRoot, name) {
  return {
    dbPath: path.join(tempRoot, `${name}.db`),
    attachmentDir: path.join(tempRoot, `${name}-attachments`),
    backupDir: path.join(tempRoot, `${name}-backups`),
  };
}

function assertProfilePrimaryKey(db) {
  const info = db.prepare("PRAGMA table_info(config_entities)").all();
  const pkColumns = info
    .filter((column) => Number(column.pk || 0) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);
  assert.deepStrictEqual(pkColumns, ["schema", "entity_id", "profile"]);
}

function assertCanStoreBootstrapAndRuntime(db) {
  db.prepare(
    `INSERT INTO config_entities(schema, entity_id, profile, projection_fields_json, dto_version, safe_projection_json, checksum)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "agent_config",
    "Agents/a/config.json",
    "bootstrap",
    "[]",
    1,
    "{}",
    "bootstrap-checksum"
  );
  db.prepare(
    `INSERT INTO config_entities(schema, entity_id, profile, projection_fields_json, dto_version, safe_projection_json, checksum)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "agent_config",
    "Agents/a/config.json",
    "runtime",
    "[]",
    1,
    "{}",
    "runtime-checksum"
  );
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM config_entities WHERE schema = ? AND entity_id = ?"
    )
    .get("agent_config", "Agents/a/config.json").count;
  assert.strictEqual(Number(count), 2);
}

function seedLegacyConfigEntities(db, withProfileColumns) {
  db.exec(`
CREATE TABLE config_entities (
  schema TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  dto_version INTEGER NOT NULL DEFAULT 1,
  safe_projection_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  operation_id TEXT,
  device_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (schema, entity_id)
);
INSERT INTO config_entities(schema, entity_id, dto_version, safe_projection_json, checksum)
VALUES ('agent_config', 'runtime:Agents/legacy/config.json', 1, '{}', 'legacy-runtime');
`);
  if (withProfileColumns) {
    db.exec(`
ALTER TABLE config_entities ADD COLUMN profile TEXT NOT NULL DEFAULT 'runtime';
ALTER TABLE config_entities ADD COLUMN projection_fields_json TEXT;
UPDATE config_entities SET profile = 'runtime', projection_fields_json = '["name"]';
`);
  }
}

function runEnsure(config) {
  const logger = { info() {}, warn() {}, error() {} };
  return ensureDatabase(config, logger);
}

function safeClose(context) {
  if (context) closeDatabase(context);
}

function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vchat-sync-center-migration-")
  );
  let freshContext = null;
  let legacyContext = null;
  let duplicateContext = null;
  try {
    const freshConfig = makeConfig(tempRoot, "fresh");
    freshContext = runEnsure(freshConfig);
    assertProfilePrimaryKey(freshContext.db);
    assertCanStoreBootstrapAndRuntime(freshContext.db);
    safeClose(freshContext);
    freshContext = null;

    const legacyConfig = makeConfig(tempRoot, "legacy-pre-v5");
    fs.mkdirSync(path.dirname(legacyConfig.dbPath), { recursive: true });
    let db = new Database(legacyConfig.dbPath);
    seedLegacyConfigEntities(db, false);
    db.close();
    legacyContext = runEnsure(legacyConfig);
    assertProfilePrimaryKey(legacyContext.db);
    const migratedLegacy = legacyContext.db
      .prepare(
        "SELECT entity_id, profile FROM config_entities WHERE checksum = ?"
      )
      .get("legacy-runtime");
    assert.deepStrictEqual(migratedLegacy, {
      entity_id: "Agents/legacy/config.json",
      profile: "runtime",
    });
    safeClose(legacyContext);
    legacyContext = null;

    const duplicateColumnConfig = makeConfig(tempRoot, "duplicate-columns");
    db = new Database(duplicateColumnConfig.dbPath);
    seedLegacyConfigEntities(db, true);
    db.close();
    duplicateContext = runEnsure(duplicateColumnConfig);
    assertProfilePrimaryKey(duplicateContext.db);
    safeClose(duplicateContext);
    duplicateContext = null;

    console.log("config migration profile primary key smoke test passed");
  } finally {
    safeClose(freshContext);
    safeClose(legacyContext);
    safeClose(duplicateContext);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
