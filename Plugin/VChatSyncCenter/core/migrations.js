const { sha256 } = require("../utils/checksum");

const MIGRATIONS = [
  {
    version: 1,
    name: "create_core_sync_schema",
    sql: `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  platform TEXT,
  device_key_hash TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  device_id TEXT NOT NULL,
  cursor_name TEXT NOT NULL DEFAULT 'default',
  latest_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (device_id, cursor_name),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS items (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_type, item_id)
);

CREATE TABLE IF NOT EXISTS item_versions (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  operation_id TEXT,
  device_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_type, item_id, version),
  FOREIGN KEY (item_type, item_id) REFERENCES items(item_type, item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS topics (
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT,
  metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_id, item_type, id),
  FOREIGN KEY (item_type, item_id) REFERENCES items(item_type, item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT,
  content TEXT,
  content_json TEXT,
  metadata_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_type, item_id, topic_id, id),
  FOREIGN KEY (item_id, item_type, topic_id) REFERENCES topics(item_id, item_type, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_history (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  operation_id TEXT,
  device_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_type, item_id, topic_id, message_id, version),
  FOREIGN KEY (item_type, item_id, topic_id, message_id) REFERENCES messages(item_type, item_id, topic_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  hash TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL DEFAULT 'sha256',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  ext TEXT,
  storage_path TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attachment_derivatives (
  attachment_hash TEXT NOT NULL,
  derivative_type TEXT NOT NULL,
  hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  storage_path TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (attachment_hash, derivative_type),
  FOREIGN KEY (attachment_hash) REFERENCES attachments(hash) ON DELETE CASCADE,
  FOREIGN KEY (hash) REFERENCES attachments(hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_attachments (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_hash TEXT NOT NULL,
  usage TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_type, item_id, topic_id, message_id, attachment_hash),
  FOREIGN KEY (item_type, item_id, topic_id, message_id) REFERENCES messages(item_type, item_id, topic_id, id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_hash) REFERENCES attachments(hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  device_id TEXT,
  item_type TEXT,
  item_id TEXT,
  topic_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version INTEGER,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT,
  device_id TEXT,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT,
  device_id TEXT,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  base_version INTEGER,
  incoming_json TEXT,
  current_json TEXT,
  resolution TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_cursors_latest_seq ON sync_cursors(latest_seq);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);
CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_messages_topic_updated ON messages(item_type, item_id, topic_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_message_history_message ON message_history(item_type, item_id, topic_id, message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_mime ON attachments(mime_type);
CREATE INDEX IF NOT EXISTS idx_change_log_created ON change_log(created_at);
CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_tombstones_entity ON tombstones(entity_type, entity_key);
CREATE INDEX IF NOT EXISTS idx_conflicts_resolution ON conflicts(resolution, created_at);
`,
  },
  {
    version: 2,
    name: "add_cycle1_operation_columns",
    sql: `
ALTER TABLE messages ADD COLUMN raw_json TEXT;
ALTER TABLE messages ADD COLUMN checksum TEXT;
ALTER TABLE messages ADD COLUMN server_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE tombstones ADD COLUMN retain_until TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_server_seq ON messages(server_seq);
CREATE INDEX IF NOT EXISTS idx_change_log_seq_created ON change_log(seq, created_at);
`,
  },
  {
    version: 3,
    name: "add_cycle4_attachment_config_columns",
    sql: `
ALTER TABLE attachments ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_message_attachments_hash ON message_attachments(attachment_hash);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(item_type, item_id, topic_id, message_id);
CREATE TABLE IF NOT EXISTS config_entities (
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
CREATE INDEX IF NOT EXISTS idx_config_entities_updated ON config_entities(updated_at);
`,
  },
  {
    version: 4,
    name: "add_cycle5_bootstrap_sessions",
    sql: `
CREATE TABLE IF NOT EXISTS bootstrap_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  checkpoint_json TEXT,
  audit_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE messages ADD COLUMN local_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_topic_order ON messages(item_type, item_id, topic_id, local_order);
CREATE INDEX IF NOT EXISTS idx_bootstrap_sessions_mode_status ON bootstrap_sessions(mode, status);
`,
  },
  {
    version: 5,
    name: "add_config_profile_projection_metadata",
    sql: `
ALTER TABLE config_entities ADD COLUMN profile TEXT NOT NULL DEFAULT 'bootstrap';
ALTER TABLE config_entities ADD COLUMN projection_fields_json TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_entities_schema_entity_profile ON config_entities(schema, entity_id, profile);
CREATE INDEX IF NOT EXISTS idx_config_entities_profile ON config_entities(profile, updated_at);
`,
  },
  {
    version: 6,
    name: "rebuild_config_entities_profile_primary_key",
    sql: `
CREATE TABLE IF NOT EXISTS config_entities_v6 (
  schema TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'bootstrap',
  projection_fields_json TEXT,
  dto_version INTEGER NOT NULL DEFAULT 1,
  safe_projection_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  operation_id TEXT,
  device_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (schema, entity_id, profile)
);
INSERT OR REPLACE INTO config_entities_v6(
  schema, entity_id, profile, projection_fields_json, dto_version,
  safe_projection_json, checksum, operation_id, device_id, version, deleted, updated_at
)
SELECT
  schema,
  CASE
    WHEN entity_id LIKE 'runtime:%' THEN substr(entity_id, length('runtime') + 2)
    WHEN entity_id LIKE 'manual:%' THEN substr(entity_id, length('manual') + 2)
    WHEN COALESCE(profile, 'bootstrap') != 'bootstrap'
      AND entity_id LIKE COALESCE(profile, 'bootstrap') || ':%'
      THEN substr(entity_id, length(COALESCE(profile, 'bootstrap')) + 2)
    ELSE entity_id
  END AS entity_id,
  CASE
    WHEN entity_id LIKE 'runtime:%' THEN 'runtime'
    WHEN entity_id LIKE 'manual:%' THEN 'manual'
    ELSE COALESCE(profile, 'bootstrap')
  END AS profile,
  projection_fields_json,
  dto_version,
  safe_projection_json,
  checksum,
  operation_id,
  device_id,
  version,
  deleted,
  updated_at
FROM config_entities;
DROP TABLE config_entities;
ALTER TABLE config_entities_v6 RENAME TO config_entities;
CREATE INDEX IF NOT EXISTS idx_config_entities_updated ON config_entities(updated_at);
CREATE INDEX IF NOT EXISTS idx_config_entities_profile ON config_entities(profile, updated_at);
`,
  },
];

function ensureSchemaMigrationsTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
`);
}

function prepareMigrations() {
  return MIGRATIONS.map((migration) => ({
    ...migration,
    checksum: sha256(`${migration.version}:${migration.name}:${migration.sql}`),
  }));
}

function getMigrationState(db) {
  ensureSchemaMigrationsTable(db);
  const migrations = prepareMigrations();
  const appliedRows = db
    .prepare("SELECT * FROM schema_migrations ORDER BY version ASC")
    .all();
  const applied = new Map(
    appliedRows
      .filter((row) => row.success === 1)
      .map((row) => [row.version, row])
  );

  for (const migration of migrations) {
    const row = applied.get(migration.version);
    if (row && row.checksum !== migration.checksum) {
      throw new Error(
        `Migration checksum mismatch for version ${migration.version} (${migration.name}). Refuse to continue.`
      );
    }
  }

  const pending = migrations.filter(
    (migration) => !applied.has(migration.version)
  );
  const latest =
    appliedRows.length > 0 ? appliedRows[appliedRows.length - 1] : null;

  return {
    currentVersion: appliedRows
      .filter((row) => row.success === 1)
      .reduce((max, row) => Math.max(max, row.version), 0),
    latestKnownVersion: migrations.reduce(
      (max, row) => Math.max(max, row.version),
      0
    ),
    pendingCount: pending.length,
    latestResult: latest,
  };
}

function executeMigrationSql(db, sql) {
  const statements = String(sql || "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    try {
      db.exec(`${statement};`);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (/duplicate column name/i.test(message)) continue;
      throw error;
    }
  }
}

function runMigrations(db, logger) {
  ensureSchemaMigrationsTable(db);
  const migrations = prepareMigrations();
  const appliedRows = db
    .prepare("SELECT version, checksum, success FROM schema_migrations")
    .all();
  const applied = new Map(
    appliedRows
      .filter((row) => row.success === 1)
      .map((row) => [row.version, row])
  );

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for version ${migration.version} (${migration.name}). Refuse to continue.`
        );
      }
      continue;
    }

    const startedAt = Date.now();
    const transaction = db.transaction(() => {
      executeMigrationSql(db, migration.sql);
      db.prepare(
        `
INSERT INTO schema_migrations(version, name, checksum, applied_at, duration_ms, success, error_message)
VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 1, NULL)
ON CONFLICT(version) DO UPDATE SET
  name = excluded.name,
  checksum = excluded.checksum,
  applied_at = excluded.applied_at,
  duration_ms = excluded.duration_ms,
  success = 1,
  error_message = NULL
`
      ).run(
        migration.version,
        migration.name,
        migration.checksum,
        Date.now() - startedAt
      );
    });

    try {
      transaction();
      logger.info("Applied VChatSyncCenter migration", {
        version: migration.version,
        name: migration.name,
      });
    } catch (error) {
      const duration = Date.now() - startedAt;
      db.prepare(
        `
INSERT INTO schema_migrations(version, name, checksum, applied_at, duration_ms, success, error_message)
VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 0, ?)
ON CONFLICT(version) DO UPDATE SET
  name = excluded.name,
  checksum = excluded.checksum,
  applied_at = excluded.applied_at,
  duration_ms = excluded.duration_ms,
  success = 0,
  error_message = excluded.error_message
`
      ).run(
        migration.version,
        migration.name,
        migration.checksum,
        duration,
        error.message
      );
      throw error;
    }
  }

  return getMigrationState(db);
}

module.exports = {
  runMigrations,
  getMigrationState,
};
