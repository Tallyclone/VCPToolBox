const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const {
  createDatabaseBackup,
  verifyBackupFile,
  listBackups,
} = require("../core/backupService");

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vchat-sync-backup-"));
  const dbPath = path.join(tempRoot, "center.db");
  const backupDir = path.join(tempRoot, "backups");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE
);
INSERT INTO change_log(operation_id) VALUES ('op-1'), ('op-2');
`);

  const runtime = {
    config: { backupDir },
    dbContext: { db, dbPath },
    logger: { warn() {}, info() {}, error() {} },
  };

  const created = await createDatabaseBackup(runtime, { label: "cycle6-test" });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.backup.integrity, "ok");
  assert.strictEqual(created.backup.latest_seq, 2);

  const backups = listBackups(runtime.config);
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(backups[0].name, created.backup.name);

  const verified = verifyBackupFile(created.backup.path);
  assert.strictEqual(verified.integrity, "ok");
  assert.strictEqual(verified.latest_seq, 2);

  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("cycle6 backup smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
