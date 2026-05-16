const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { ensureDatabase, closeDatabase } = require("./db");

function ensureBackupDir(config) {
  fs.mkdirSync(config.backupDir, { recursive: true });
}

function safeBackupName(label = "manual") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const cleanLabel = String(label || "manual").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `vchat-sync-${cleanLabel}-${stamp}.db`;
}

function listBackups(config) {
  ensureBackupDir(config);
  return fs
    .readdirSync(config.backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
    .map((entry) => {
      const filePath = path.join(config.backupDir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        size_bytes: stat.size,
        created_at: stat.birthtime.toISOString(),
        modified_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)));
}

async function createDatabaseBackup(runtime, options = {}) {
  const { config, dbContext, logger } = runtime;
  if (!dbContext || !dbContext.db || !dbContext.db.open) {
    throw new Error("database is not open");
  }
  ensureBackupDir(config);
  const backupPath = path.join(config.backupDir, safeBackupName(options.label));

  dbContext.db.pragma("wal_checkpoint(FULL)");
  await dbContext.db.backup(backupPath);
  const verified = verifyBackupFile(backupPath);
  if (logger && logger.warn) {
    logger.warn("VChatSyncCenter database backup created", {
      backupPath,
      size_bytes: verified.size_bytes,
      integrity: verified.integrity,
    });
  }
  return { ok: true, backup: verified };
}

function verifyBackupFile(backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error("backup file not found");
  }
  const db = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const latestSeqRow = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM change_log")
      .get();
    const stat = fs.statSync(backupPath);
    return {
      path: backupPath,
      name: path.basename(backupPath),
      size_bytes: stat.size,
      integrity,
      latest_seq: Number(
        latestSeqRow && latestSeqRow.latest_seq ? latestSeqRow.latest_seq : 0
      ),
      verified_at: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}

function resolveBackupPath(config, nameOrPath) {
  const raw = String(nameOrPath || "");
  if (!raw) throw new Error("backup name is required");
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(config.backupDir, raw);
  const backupRoot = path.resolve(config.backupDir);
  if (!resolved.startsWith(backupRoot + path.sep) && resolved !== backupRoot) {
    throw new Error("backup path escapes configured backup directory");
  }
  return resolved;
}

async function restoreDatabaseBackup(runtime, options = {}) {
  const { config, logger } = runtime;
  const backupPath = resolveBackupPath(config, options.name || options.path);
  const backupVerified = verifyBackupFile(backupPath);
  if (backupVerified.integrity !== "ok") {
    throw new Error("backup integrity_check failed");
  }

  const currentLatestSeq =
    runtime.dbContext && runtime.dbContext.db && runtime.dbContext.db.open
      ? Number(
          runtime.dbContext.db
            .prepare(
              "SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM change_log"
            )
            .get().latest_seq || 0
        )
      : 0;
  if (
    backupVerified.latest_seq < currentLatestSeq &&
    !options.allow_seq_downgrade
  ) {
    throw new Error(
      `backup latest_seq ${backupVerified.latest_seq} is older than current latest_seq ${currentLatestSeq}`
    );
  }

  const preRestore = await createDatabaseBackup(runtime, {
    label: options.pre_restore_label || "pre-restore",
  });

  if (runtime.dbContext) {
    closeDatabase(runtime.dbContext);
    runtime.dbContext = null;
  }

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const restoreTmp = `${config.dbPath}.restore-tmp-${
    process.pid
  }-${Date.now()}`;
  try {
    fs.copyFileSync(backupPath, restoreTmp);
    const tmpVerified = verifyBackupFile(restoreTmp);
    if (tmpVerified.integrity !== "ok") {
      throw new Error("restored tmp integrity_check failed");
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
    }
    fs.renameSync(restoreTmp, config.dbPath);
  } catch (error) {
    fs.rmSync(restoreTmp, { force: true });
    runtime.dbContext = ensureDatabase(config, logger);
    throw error;
  }

  runtime.dbContext = ensureDatabase(config, logger);
  const restored = verifyBackupFile(config.dbPath);
  if (restored.integrity !== "ok") {
    throw new Error("restored database integrity_check failed");
  }

  if (logger && logger.warn) {
    logger.warn("VChatSyncCenter database restored from backup", {
      backupPath,
      pre_restore_backup: preRestore.backup && preRestore.backup.path,
      latest_seq: restored.latest_seq,
    });
  }

  return {
    ok: true,
    restored,
    source_backup: backupVerified,
    pre_restore_backup: preRestore.backup,
  };
}

function getBackupStatus(config) {
  const backups = listBackups(config);
  return {
    enabled: true,
    backupDir: config.backupDir,
    interval: config.backupInterval,
    retentionDays: config.backupRetentionDays,
    latest: backups[0] || null,
    count: backups.length,
    note: "Use POST /backup/create before risky operations; verify backups before restore.",
  };
}

module.exports = {
  getBackupStatus,
  listBackups,
  createDatabaseBackup,
  verifyBackupFile,
  resolveBackupPath,
  restoreDatabaseBackup,
};
