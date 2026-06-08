const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations, getMigrationState } = require("./migrations");

const CORE_TABLES = [
  "schema_migrations",
  "devices",
  "sync_cursors",
  "items",
  "item_versions",
  "topics",
  "messages",
  "message_history",
  "attachments",
  "attachment_derivatives",
  "message_attachments",
  "config_entities",
  "avatars",
  "theme_packages",
  "theme_assets",
  "theme_package_assets",
  "bootstrap_sessions",
  "change_log",
  "tombstones",
  "conflicts",
];

function ensureDatabase(config, logger) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.attachmentDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });

  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const migrationState = runMigrations(db, logger);
  return {
    db,
    dbPath: config.dbPath,
    migrationState,
    openedAt: new Date().toISOString(),
  };
}

function closeDatabase(dbContext) {
  if (dbContext && dbContext.db && dbContext.db.open) {
    dbContext.db.close();
  }
}

function getTableCounts(db) {
  const counts = {};
  for (const table of CORE_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    counts[table] = row ? Number(row.count || 0) : 0;
  }
  return counts;
}

function getWalEnabled(db) {
  const row = db.pragma("journal_mode", { simple: true });
  return String(row || "").toLowerCase() === "wal";
}

function getDbStatus(dbContext) {
  if (!dbContext || !dbContext.db) {
    return {
      ready: false,
      path: null,
      wal: false,
      migrations: null,
      table_counts: {},
    };
  }

  return {
    ready: true,
    path: dbContext.dbPath,
    wal: getWalEnabled(dbContext.db),
    migrations: getMigrationState(dbContext.db),
    table_counts: getTableCounts(dbContext.db),
  };
}

module.exports = {
  ensureDatabase,
  closeDatabase,
  getDbStatus,
  CORE_TABLES,
};
