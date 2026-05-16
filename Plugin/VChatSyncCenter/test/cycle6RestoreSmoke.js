const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase } = require("../core/db");
const {
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyBackupFile,
} = require("../core/backupService");

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vchat-sync-restore-"));
  const dbPath = path.join(tempRoot, "center.db");
  const backupDir = path.join(tempRoot, "backups");
  const logger = { warn() {}, info() {}, error() {} };
  const runtime = {
    config: {
      dbPath,
      backupDir,
      attachmentDir: path.join(tempRoot, "attachments"),
    },
    dbContext: null,
    logger,
  };
  runtime.dbContext = ensureDatabase(runtime.config, logger);
  runtime.dbContext.db
    .prepare("INSERT INTO change_log(operation_id, entity_type, entity_id, action) VALUES (?, 'test', ?, 'create')")
    .run("op-1", "e1");
  runtime.dbContext.db
    .prepare("INSERT INTO change_log(operation_id, entity_type, entity_id, action) VALUES (?, 'test', ?, 'create')")
    .run("op-2", "e2");

  const source = await createDatabaseBackup(runtime, { label: "source" });
  assert.strictEqual(source.backup.latest_seq, 2);

  runtime.dbContext.db
    .prepare("INSERT INTO change_log(operation_id, entity_type, entity_id, action) VALUES (?, 'test', ?, 'create')")
    .run("op-3", "e3");
  assert.strictEqual(
    runtime.dbContext.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM change_log")
      .get().latest_seq,
    3
  );

  await assert.rejects(
    () => restoreDatabaseBackup(runtime, { name: source.backup.name }),
    /older than current latest_seq/
  );

  const restored = await restoreDatabaseBackup(runtime, {
    name: source.backup.name,
    allow_seq_downgrade: true,
  });
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.restored.integrity, "ok");
  assert.strictEqual(restored.restored.latest_seq, 2);
  assert.strictEqual(verifyBackupFile(dbPath).latest_seq, 2);
  assert.ok(restored.pre_restore_backup.path);

  runtime.dbContext.db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("cycle6 restore smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
