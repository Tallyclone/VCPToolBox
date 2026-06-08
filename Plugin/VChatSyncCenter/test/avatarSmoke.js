const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase, closeDatabase } = require("../core/db");
const { processOperation } = require("../core/operationProcessor");
const { upsertAttachment } = require("../core/attachmentStore");
const { exportBaseline, importBootstrap } = require("../core/bootstrapService");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vchat-avatar-center-")
  );
  const config = {
    dbPath: path.join(tempRoot, "center.db"),
    attachmentDir: path.join(tempRoot, "attachments"),
    backupDir: path.join(tempRoot, "backups"),
    maxLimit: 5000,
    bootstrapKey: "test-bootstrap-key",
  };
  const logger = { warn() {}, info() {}, error() {} };
  const dbContext = ensureDatabase(config, logger);
  const runtime = { config, logger, dbContext };

  try {
    const avatarBuffer = Buffer.from("avatar-binary-v1");
    const avatarHash = sha256(avatarBuffer);
    const attachment = await upsertAttachment(runtime, {
      buffer: avatarBuffer,
      hash: avatarHash,
      ext: ".png",
      mime_type: "image/png",
      filename: "avatar.png",
      device_id: "device-1",
      operation_id: `attachment.device-1.${avatarHash}`,
    });
    assert.strictEqual(attachment.hash, avatarHash);

    const createResult = processOperation(dbContext.db, {
      operation_id: "avatar-create-agent-one",
      device_id: "device-1",
      entity_type: "avatar",
      entity_id: "agent:agent-one",
      action: "create",
      payload: {
        owner_type: "agent",
        owner_id: "agent-one",
        hash: avatarHash,
        ext: ".png",
        mime_type: "image/png",
        relative_path: "Agents/agent-one/avatar.png",
      },
    });
    assert.strictEqual(createResult.ok, true);

    const avatarRow = dbContext.db
      .prepare("SELECT * FROM avatars WHERE owner_type = ? AND owner_id = ?")
      .get("agent", "agent-one");
    assert(avatarRow, "avatar row should exist");
    assert.strictEqual(avatarRow.hash, avatarHash);
    assert.strictEqual(Number(avatarRow.deleted || 0), 0);

    const createChange = dbContext.db
      .prepare(
        "SELECT action, payload_json FROM change_log WHERE operation_id = ? AND entity_type = ? AND entity_id = ?"
      )
      .get("avatar-create-agent-one", "avatar", "agent:agent-one");
    assert(createChange, "avatar create change should exist");
    assert.strictEqual(createChange.action, "create");

    assert.throws(
      () =>
        processOperation(dbContext.db, {
          operation_id: "avatar-create-path-mismatch",
          device_id: "device-1",
          entity_type: "avatar",
          entity_id: "agent:agent-one",
          action: "create",
          payload: {
            owner_type: "agent",
            owner_id: "agent-one",
            hash: avatarHash,
            ext: ".png",
            relative_path: "Agents/agent-two/avatar.png",
          },
        }),
      /avatar relative_path owner mismatch/
    );
    assert.throws(
      () =>
        processOperation(dbContext.db, {
          operation_id: "avatar-create-missing-attachment",
          device_id: "device-1",
          entity_type: "avatar",
          entity_id: "agent:agent-missing-attachment",
          action: "create",
          payload: {
            owner_type: "agent",
            owner_id: "agent-missing-attachment",
            hash: "0".repeat(64),
            ext: ".png",
            relative_path: "Agents/agent-missing-attachment/avatar.png",
          },
        }),
      /avatar attachment not found/
    );

    const baseline = exportBaseline(runtime, { kind: "avatars", limit: 10 });
    assert.strictEqual(baseline.ok, true);
    assert.strictEqual(baseline.baseline.avatars.length, 1);
    assert.strictEqual(baseline.baseline.avatars[0].hash, avatarHash);

    const deleteResult = processOperation(dbContext.db, {
      operation_id: "avatar-delete-agent-one",
      device_id: "device-1",
      entity_type: "avatar",
      entity_id: "agent:agent-one",
      action: "delete",
      payload: {
        owner_type: "agent",
        owner_id: "agent-one",
        relative_path: "Agents/agent-one/avatar.png",
      },
    });
    assert.strictEqual(deleteResult.ok, true);

    const deletedRow = dbContext.db
      .prepare("SELECT * FROM avatars WHERE owner_type = ? AND owner_id = ?")
      .get("agent", "agent-one");
    assert.strictEqual(Number(deletedRow.deleted || 0), 1);
    assert.strictEqual(deletedRow.hash, null);

    const deleteChange = dbContext.db
      .prepare("SELECT action FROM change_log WHERE operation_id = ?")
      .get("avatar-delete-agent-one");
    assert.strictEqual(deleteChange.action, "delete");

    const deletedBaseline = exportBaseline(runtime, {
      kind: "avatars",
      limit: 10,
    });
    assert.strictEqual(deletedBaseline.baseline.avatars.length, 0);

    const importRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "vchat-avatar-import-")
    );
    const importConfig = {
      dbPath: path.join(importRoot, "center.db"),
      attachmentDir: path.join(importRoot, "attachments"),
      backupDir: path.join(importRoot, "backups"),
      maxLimit: 5000,
      bootstrapKey: "test-bootstrap-key",
    };
    const importDbContext = ensureDatabase(importConfig, logger);
    try {
      const importRuntime = {
        config: importConfig,
        logger,
        dbContext: importDbContext,
      };
      await upsertAttachment(importRuntime, {
        buffer: avatarBuffer,
        hash: avatarHash,
        ext: ".png",
        mime_type: "image/png",
        filename: "avatar.png",
        device_id: "device-2",
        operation_id: `attachment.device-2.${avatarHash}`,
      });
      const imported = importBootstrap(importRuntime, {
        mode: "bootstrap_incremental",
        device_id: "device-2",
        avatars: [baseline.baseline.avatars[0]],
      });
      assert.strictEqual(imported.ok, true);
      assert.strictEqual(imported.imported.avatars, 1);
      const importedRow = importDbContext.db
        .prepare(
          "SELECT hash FROM avatars WHERE owner_type = ? AND owner_id = ? AND deleted = 0"
        )
        .get("agent", "agent-one");
      assert.strictEqual(importedRow.hash, avatarHash);
    } finally {
      closeDatabase(importDbContext);
      fs.rmSync(importRoot, { recursive: true, force: true });
    }
  } finally {
    closeDatabase(dbContext);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("avatar center smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
