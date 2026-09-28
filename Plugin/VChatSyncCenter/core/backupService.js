const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { ensureDatabase, closeDatabase } = require("./db");
const { getGeneration, rotateGeneration } = require("./centerMeta");

const BACKUP_NAME_PATTERN = /^vchat-sync-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

function ensureBackupDir(config) {
  fs.mkdirSync(config.backupDir, { recursive: true });
}

function safeBackupName(label = "manual") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const cleanLabel = String(label || "manual").replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `vchat-sync-${cleanLabel}-${stamp}.db`;
}

// "6h", "90m", "1d", "3600s", or a plain number of milliseconds. Returns 0
// when automatic backups are disabled ("0", "off", "false", "none", "").
function parseInterval(value) {
  if (value === undefined || value === null) return 0;
  const raw = String(value).trim().toLowerCase();
  if (!raw || ["0", "off", "false", "none", "disabled"].includes(raw)) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  const multiplier = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[unit];
  return Math.round(amount * multiplier);
}

function listBackups(config) {
  ensureBackupDir(config);
  return fs
    .readdirSync(config.backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
    .map((entry) => {
      const filePath = path.join(config.backupDir, entry.name);
      const stat = fs.statSync(filePath);
      const match = BACKUP_NAME_PATTERN.exec(entry.name);
      return {
        name: entry.name,
        path: filePath,
        label: match ? match[1] : null,
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
    let generation = null;
    try {
      const row = db
        .prepare("SELECT value FROM center_meta WHERE key = 'generation'")
        .get();
      generation = row ? row.value : null;
    } catch (_) {
      // Older backups predate center_meta.
    }
    const stat = fs.statSync(backupPath);
    return {
      path: backupPath,
      name: path.basename(backupPath),
      size_bytes: stat.size,
      integrity,
      latest_seq: Number(
        latestSeqRow && latestSeqRow.latest_seq ? latestSeqRow.latest_seq : 0
      ),
      generation,
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

// Restoring a backup can move the change-log sequence backwards, and the
// numbers between the backup's latest_seq and the previous latest_seq will be
// reused by new events. Every client cursor from before the restore would then
// silently skip those events. Rotating the generation makes every client
// detect the restore and rebuild its baseline instead.
async function restoreDatabaseBackup(runtime, options = {}) {
  const { config, logger } = runtime;
  const backupPath = resolveBackupPath(config, options.name || options.path);
  const backupVerified = verifyBackupFile(backupPath);
  if (backupVerified.integrity !== "ok") {
    throw new Error("backup integrity_check failed");
  }

  const currentDb =
    runtime.dbContext && runtime.dbContext.db && runtime.dbContext.db.open
      ? runtime.dbContext.db
      : null;
  const currentLatestSeq = currentDb
    ? Number(
        currentDb
          .prepare("SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM change_log")
          .get().latest_seq || 0
      )
    : 0;
  const previousGeneration = currentDb ? getGeneration(currentDb) : null;
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

  // Always start a new generation after a restore: even when the sequence did
  // not go backwards, the restored log content differs from what clients saw.
  const rotation = rotateGeneration(runtime.dbContext.db, {
    reason: "backup_restore",
    backup: backupVerified.name,
    backup_latest_seq: backupVerified.latest_seq,
    previous_latest_seq: currentLatestSeq,
    previous_generation: previousGeneration,
    seq_downgrade: backupVerified.latest_seq < currentLatestSeq,
  });

  if (logger && logger.warn) {
    logger.warn("VChatSyncCenter database restored from backup", {
      backupPath,
      pre_restore_backup: preRestore.backup && preRestore.backup.path,
      latest_seq: restored.latest_seq,
      generation: rotation.generation,
      previous_generation: rotation.previous_generation,
    });
  }

  return {
    ok: true,
    restored: { ...restored, generation: rotation.generation },
    generation: rotation.generation,
    previous_generation: rotation.previous_generation,
    source_backup: backupVerified,
    pre_restore_backup: preRestore.backup,
    clients_must_rebootstrap: true,
  };
}

function pruneBackups(config, options = {}) {
  const retentionDays = Number(
    options.retentionDays !== undefined
      ? options.retentionDays
      : config.backupRetentionDays
  );
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { ok: true, removed: [], kept: listBackups(config).length, retention_days: retentionDays };
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const backups = listBackups(config);
  const removed = [];
  for (const backup of backups) {
    // Never remove pre-restore safety copies automatically.
    if (backup.label && /^pre-restore/.test(backup.label)) continue;
    if (Date.parse(backup.modified_at) >= cutoff) continue;
    // Always keep the newest backup, whatever its age.
    if (backup === backups[0]) continue;
    fs.rmSync(backup.path, { force: true });
    removed.push(backup.name);
  }
  return {
    ok: true,
    removed,
    kept: backups.length - removed.length,
    retention_days: retentionDays,
  };
}

function backupSchedulerState(runtime) {
  if (!runtime._backupScheduler) {
    runtime._backupScheduler = {
      timer: null,
      running: false,
      interval_ms: 0,
      next_run_at: null,
      last_run_at: null,
      last_result: null,
      last_error: null,
      runs: 0,
      failures: 0,
    };
  }
  return runtime._backupScheduler;
}

async function runScheduledBackup(runtime, reason = "scheduled") {
  const state = backupSchedulerState(runtime);
  const { logger } = runtime;
  if (state.running) return { skipped: true, reason: "already_running" };
  state.running = true;
  state.last_run_at = new Date().toISOString();
  try {
    const created = await createDatabaseBackup(runtime, { label: "auto" });
    const pruned = pruneBackups(runtime.config);
    state.runs += 1;
    state.last_error = null;
    state.last_result = {
      reason,
      backup: created.backup && created.backup.name,
      latest_seq: created.backup && created.backup.latest_seq,
      pruned: pruned.removed.length,
      at: new Date().toISOString(),
    };
    return { ok: true, backup: created.backup, pruned };
  } catch (error) {
    state.failures += 1;
    state.last_error = { message: error.message, at: new Date().toISOString() };
    if (logger && logger.error) {
      logger.error("VChatSyncCenter automatic backup failed", {
        reason,
        error: error.message,
      });
    }
    return { ok: false, error: error.message };
  } finally {
    state.running = false;
  }
}

function startBackupScheduler(runtime) {
  const { config, logger } = runtime;
  const state = backupSchedulerState(runtime);
  const parsed = parseInterval(config.backupInterval);
  if (parsed === null) {
    if (logger && logger.error) {
      logger.error("VChatSyncCenter automatic backup disabled: invalid VCHAT_BACKUP_INTERVAL", {
        value: config.backupInterval,
      });
    }
    state.interval_ms = 0;
    state.invalid_interval = String(config.backupInterval);
    return state;
  }
  if (parsed === 0) {
    state.interval_ms = 0;
    return state;
  }
  const intervalMs = Math.min(Math.max(parsed, MIN_INTERVAL_MS), MAX_TIMER_MS);
  state.interval_ms = intervalMs;
  const schedule = () => {
    if (state.stopped) return;
    state.next_run_at = new Date(Date.now() + intervalMs).toISOString();
    state.timer = setTimeout(async () => {
      state.timer = null;
      if (!runtime.dbContext || !runtime.dbContext.db || !runtime.dbContext.db.open) {
        schedule();
        return;
      }
      await runScheduledBackup(runtime, "scheduled");
      schedule();
    }, intervalMs);
    if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
  };
  state.stopped = false;
  schedule();
  if (logger && logger.info) {
    logger.info("VChatSyncCenter automatic backup scheduled", {
      interval: config.backupInterval,
      interval_ms: intervalMs,
      retention_days: config.backupRetentionDays,
      backupDir: config.backupDir,
    });
  }
  return state;
}

function stopBackupScheduler(runtime) {
  if (!runtime || !runtime._backupScheduler) return;
  const state = runtime._backupScheduler;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.next_run_at = null;
}

function getBackupStatus(runtimeOrConfig) {
  const runtime =
    runtimeOrConfig && runtimeOrConfig.config ? runtimeOrConfig : null;
  const config = runtime ? runtime.config : runtimeOrConfig;
  const backups = listBackups(config);
  const scheduler = runtime ? runtime._backupScheduler || null : null;
  const parsed = parseInterval(config.backupInterval);
  const enabled = Boolean(scheduler && scheduler.interval_ms > 0 && !scheduler.stopped);
  return {
    enabled,
    scheduled: enabled,
    backupDir: config.backupDir,
    interval: config.backupInterval,
    interval_ms: parsed === null ? null : parsed,
    interval_valid: parsed !== null,
    retentionDays: config.backupRetentionDays,
    latest: backups[0] || null,
    count: backups.length,
    scheduler: scheduler
      ? {
          running: scheduler.running,
          next_run_at: scheduler.next_run_at,
          last_run_at: scheduler.last_run_at,
          last_result: scheduler.last_result,
          last_error: scheduler.last_error,
          runs: scheduler.runs,
          failures: scheduler.failures,
        }
      : null,
    note: enabled
      ? "Automatic backups run on the configured interval; old backups beyond the retention window are pruned (the newest and pre-restore copies are kept)."
      : "Automatic backups are not running. Use POST /backup/create before risky operations; verify backups before restore.",
  };
}

module.exports = {
  getBackupStatus,
  listBackups,
  createDatabaseBackup,
  verifyBackupFile,
  resolveBackupPath,
  restoreDatabaseBackup,
  pruneBackups,
  parseInterval,
  startBackupScheduler,
  stopBackupScheduler,
  runScheduledBackup,
};
