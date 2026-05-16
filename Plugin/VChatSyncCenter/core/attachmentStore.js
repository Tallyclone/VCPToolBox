const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { appendChange, getOperationResult } = require("./changeLog");
const { safeJsonParse, safeJsonStringify } = require("../utils/safeJson");

function sanitizeExt(ext) {
  const raw = String(ext || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const normalized = raw.startsWith(".") ? raw : `.${raw}`;
  return /^\.[a-z0-9]{1,16}$/.test(normalized) ? normalized : "";
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function storagePathFor(config, hash, ext) {
  const prefix = String(hash).slice(0, 2) || "00";
  return path.join(config.attachmentDir, prefix, `${hash}${sanitizeExt(ext)}`);
}

function relativeStoragePath(config, absolutePath) {
  return path.relative(config.attachmentDir, absolutePath).replace(/\\/g, "/");
}

function rowToAttachment(row, config) {
  if (!row) return null;
  return {
    hash: row.hash,
    algorithm: row.algorithm,
    size_bytes: Number(row.size_bytes || 0),
    mime_type: row.mime_type || null,
    ext: row.ext || "",
    storage_path: row.storage_path,
    metadata: safeJsonParse(row.metadata_json, {}),
    created_at: row.created_at,
    absolute_path: path.resolve(config.attachmentDir, row.storage_path),
  };
}

function getAttachment(db, config, hash) {
  const row = db
    .prepare("SELECT * FROM attachments WHERE hash = ? LIMIT 1")
    .get(hash);
  return rowToAttachment(row, config);
}

function buildAttachmentOperationId(input, expectedHash) {
  const operationId = String(input.operation_id || "").trim();
  return operationId || `attachment.${expectedHash}`;
}

function linkUploadedAttachmentToMessages(db, attachmentHash) {
  const rows = db
    .prepare(
      `
SELECT seq, payload_json
FROM change_log
WHERE entity_type = 'message'
  AND action IN ('create', 'update')
  AND payload_json LIKE ?
ORDER BY seq ASC
`
    )
    .all(`%${attachmentHash}%`);

  const insert = db.prepare(`
INSERT OR IGNORE INTO message_attachments(item_type, item_id, topic_id, message_id, attachment_hash, usage, sort_order, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

  let linked = 0;
  for (const row of rows) {
    const payload = safeJsonParse(row.payload_json, {});
    const message = payload.message || {};
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments
      : [];
    const itemType = message.item_type || payload.item_type;
    const itemId = message.item_id || payload.item_id;
    const topicId = message.topic_id || payload.topic_id;
    const messageId = message.id || payload.message_id || payload.id;
    if (!itemType || !itemId || !topicId || !messageId) continue;

    attachments.forEach((attachment, index) => {
      const hash =
        attachment && (attachment.hash || attachment.attachment_hash);
      if (hash !== attachmentHash) return;
      const info = insert.run(
        String(itemType),
        String(itemId),
        String(topicId),
        String(messageId),
        attachmentHash,
        attachment.usage || attachment.role || null,
        Number.isInteger(attachment.position) ? attachment.position : index,
        safeJsonStringify(attachment.metadata || attachment)
      );
      linked += Number(info.changes || 0);
    });
  }
  return linked;
}

async function upsertAttachment(runtime, input = {}) {
  const db = runtime.dbContext.db;
  const config = runtime.config;
  const buffer = Buffer.isBuffer(input.buffer)
    ? input.buffer
    : Buffer.from(input.buffer || "");
  const computedHash = hashBuffer(buffer);
  const expectedHash = String(input.hash || computedHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error("attachment hash must be sha256 hex");
  if (computedHash !== expectedHash)
    throw new Error("attachment hash mismatch");

  const maxBytes = Number(config.maxAttachmentMb || 512) * 1024 * 1024;
  if (buffer.length > maxBytes)
    throw new Error("attachment exceeds VCHAT_SYNC_MAX_ATTACHMENT_MB");

  const ext = sanitizeExt(input.ext || path.extname(input.filename || ""));
  const target = storagePathFor(config, expectedHash, ext);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  let existed = false;
  if (fs.existsSync(target)) {
    const existing = await fsp.readFile(target);
    if (hashBuffer(existing) !== expectedHash)
      throw new Error("stored attachment checksum mismatch");
    existed = true;
  } else {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buffer);
    const verify = hashBuffer(await fsp.readFile(tmp));
    if (verify !== expectedHash) {
      await fsp.rm(tmp, { force: true });
      throw new Error("tmp attachment checksum mismatch");
    }
    await fsp.rename(tmp, target).catch(async () => {
      await fsp.copyFile(tmp, target);
      await fsp.rm(tmp, { force: true });
    });
  }

  const metadata = {
    filename: input.filename || null,
    uploaded_by: input.device_id || null,
  };

  const operationId = buildAttachmentOperationId(input, expectedHash);
  const transaction = db.transaction(() => {
    const previous = getOperationResult(db, operationId);
    if (previous) {
      const linked = linkUploadedAttachmentToMessages(db, expectedHash);
      return { seq: previous.seq, linked, idempotent: true };
    }

    db.prepare(
      `
INSERT INTO attachments(hash, algorithm, size_bytes, mime_type, ext, storage_path, metadata_json)
VALUES (?, 'sha256', ?, ?, ?, ?, ?)
ON CONFLICT(hash) DO UPDATE SET
  size_bytes = excluded.size_bytes,
  mime_type = COALESCE(excluded.mime_type, attachments.mime_type),
  ext = COALESCE(NULLIF(excluded.ext, ''), attachments.ext),
  storage_path = excluded.storage_path,
  metadata_json = excluded.metadata_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`
    ).run(
      expectedHash,
      buffer.length,
      input.mime_type || input.mime || null,
      ext,
      relativeStoragePath(config, target),
      safeJsonStringify(metadata)
    );

    const linked = linkUploadedAttachmentToMessages(db, expectedHash);
    const seq = appendChange(db, {
      operation_id: operationId,
      device_id: input.device_id || null,
      entity_type: "attachment",
      entity_id: expectedHash,
      action: existed ? "upsert" : "create",
      version: 1,
      payload: {
        hash: expectedHash,
        size_bytes: buffer.length,
        mime_type: input.mime_type || input.mime || null,
        ext,
        filename: input.filename || null,
        linked_messages: linked,
      },
    });
    return { seq, linked, idempotent: existed };
  });

  const result = transaction();
  return {
    ok: true,
    hash: expectedHash,
    size_bytes: buffer.length,
    mime_type: input.mime_type || input.mime || null,
    ext,
    storage_path: relativeStoragePath(config, target),
    idempotent: result.idempotent,
    linked_messages: result.linked,
    seq: result.seq,
  };
}

async function verifyAttachmentFile(attachment) {
  const buffer = await fsp.readFile(attachment.absolute_path);
  const hash = hashBuffer(buffer);
  if (hash !== attachment.hash)
    throw new Error("attachment checksum verification failed");
  return buffer;
}

module.exports = {
  getAttachment,
  upsertAttachment,
  verifyAttachmentFile,
  sanitizeExt,
};
