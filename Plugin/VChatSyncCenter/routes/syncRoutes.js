const { requireSyncAuth } = require("../core/auth");
const { getDbStatus } = require("../core/db");
const { getLatestSeq, getChanges } = require("../core/changeLog");
const { runIntegrityCheck } = require("../core/integrityService");
const {
  getBackupStatus,
  listBackups,
  createDatabaseBackup,
  verifyBackupFile,
  resolveBackupPath,
  restoreDatabaseBackup,
} = require("../core/backupService");
const {
  registerDevice,
  processOperation,
} = require("../core/operationProcessor");
const { listConflicts } = require("../core/conflictService");
const {
  getAttachment,
  upsertAttachment,
  verifyAttachmentFile,
} = require("../core/attachmentStore");
const {
  requireBootstrapAuth,
  importBootstrap,
  exportBaseline,
} = require("../core/bootstrapService");

function getReadyDb(runtime, res) {
  if (runtime.initError) {
    res.status(500).json({
      ok: false,
      enabled: runtime.config.enabled,
      error: runtime.initError.message,
    });
    return null;
  }
  if (!runtime.dbContext || !runtime.dbContext.db) {
    res.status(500).json({
      ok: false,
      enabled: runtime.config.enabled,
      error: "Database is not initialized",
    });
    return null;
  }
  return runtime.dbContext.db;
}

function parseLimit(value, runtime, fallback = 1000) {
  const maxLimit = Number(runtime.config.maxLimit || 5000);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return Math.min(fallback, maxLimit);
  return Math.min(Math.max(parsed, 1), maxLimit);
}

function parseMultipartFormData(req) {
  const contentType = String(
    (req.headers && req.headers["content-type"]) || ""
  );
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  const boundary = match[1] || match[2];
  const raw = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(req.bodyRaw || "");
  if (!raw.length) return null;

  const parts = raw.toString("binary").split(`--${boundary}`);
  const fields = {};
  let fileBuffer = null;
  let fileInfo = {};

  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd);
    let body = part.slice(headerEnd + 4);
    body = body.replace(/\r\n--$/, "").replace(/\r\n$/, "");
    const nameMatch = header.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = header.match(/filename="([^"]*)"/i);
    if (filenameMatch || name === "file" || name === "attachment") {
      fileBuffer = Buffer.from(body, "binary");
      fileInfo.filename = filenameMatch ? filenameMatch[1] : fields.filename;
      const typeMatch = header.match(/content-type:\s*([^\r\n]+)/i);
      if (typeMatch) fileInfo.mime_type = typeMatch[1].trim();
    } else {
      fields[name] = Buffer.from(body, "binary").toString("utf8");
    }
  }

  return fileBuffer ? { fields, fileBuffer, fileInfo } : null;
}

function notifyLatestSeq(runtime, latestSeq, detail = {}) {
  const ws = runtime && runtime.webSocketServer;
  if (ws && typeof ws.broadcastVChatSyncLatestSeq === "function") {
    try {
      ws.broadcastVChatSyncLatestSeq(latestSeq, detail);
    } catch (error) {
      if (runtime.logger && runtime.logger.warn) {
        runtime.logger.warn(
          "VChatSyncCenter latest_seq websocket broadcast failed",
          {
            error: error.message,
          }
        );
      }
    }
  }
}

function createSyncRoutes(router, runtime) {
  router.get("/status", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;

    const dbStatus = getDbStatus(runtime.dbContext);
    const integrity = runIntegrityCheck(db);
    const latestSeq = getLatestSeq(db);

    return res.json({
      ok: integrity === "ok",
      enabled: runtime.config.enabled,
      latest_seq: latestSeq,
      initialized_at: runtime.initializedAt,
      db: {
        path: dbStatus.path,
        wal: dbStatus.wal,
        integrity,
        ready: dbStatus.ready,
      },
      schema: dbStatus.migrations,
      table_counts: dbStatus.table_counts,
      backup: getBackupStatus(runtime.config),
      limits: {
        max_limit: runtime.config.maxLimit,
        max_json_body_mb: runtime.config.maxJsonBodyMb,
        max_attachment_mb: runtime.config.maxAttachmentMb,
      },
    });
  });

  router.post("/devices/register", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      return res.json(registerDevice(db, req.body || {}));
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/operations", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      const result = processOperation(db, req.body || {}, {
        requireDeviceBinding: runtime.config.requireDeviceBinding,
      });
      if (result && result.latest_seq !== undefined) {
        notifyLatestSeq(runtime, result.latest_seq, {
          operation_id: result.operation_id,
          entity_type: result.entity_type,
          action: result.action,
        });
      }
      return res.status(result.ok === false ? 409 : 200).json(result);
    } catch (error) {
      runtime.logger.warn("VChatSyncCenter operation rejected", {
        error: error.message,
      });
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/changes", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    const afterSeq = Math.max(
      Number.parseInt(req.query.after_seq || "0", 10) || 0,
      0
    );
    const limit = parseLimit(req.query.limit, runtime, 1000);
    const events = getChanges(db, afterSeq, limit);
    const latestSeq = getLatestSeq(db);
    const nextAfterSeq =
      events.length > 0 ? events[events.length - 1].seq : afterSeq;
    return res.json({
      ok: true,
      latest_seq: latestSeq,
      events,
      has_more: events.length === limit && nextAfterSeq < latestSeq,
      next_after_seq: nextAfterSeq,
    });
  });

  router.get("/conflicts", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    const limit = parseLimit(req.query.limit, runtime, 100);
    runtime.logger.warn("VChatSyncCenter high-risk route audited", {
      route: "/conflicts",
      method: "GET",
      ip: req.ip,
    });
    return res.json({
      ok: true,
      conflicts: listConflicts(db, {
        limit,
        maxLimit: runtime.config.maxLimit,
      }),
    });
  });

  router.get("/backup/list", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    runtime.logger.warn("VChatSyncCenter high-risk route audited", {
      route: "/backup/list",
      method: "GET",
      ip: req.ip,
    });
    return res.json({ ok: true, backups: listBackups(runtime.config) });
  });

  router.post("/backup/create", requireSyncAuth(runtime), async (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      runtime.logger.warn("VChatSyncCenter high-risk route audited", {
        route: "/backup/create",
        method: "POST",
        ip: req.ip,
      });
      const result = await createDatabaseBackup(runtime, req.body || {});
      return res.json(result);
    } catch (error) {
      runtime.logger.warn("database backup failed", { error: error.message });
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/backup/verify", requireSyncAuth(runtime), (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      runtime.logger.warn("VChatSyncCenter high-risk route audited", {
        route: "/backup/verify",
        method: "POST",
        ip: req.ip,
      });
      const backupPath = resolveBackupPath(
        runtime.config,
        req.body && (req.body.name || req.body.path)
      );
      return res.json({ ok: true, backup: verifyBackupFile(backupPath) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/backup/restore", requireSyncAuth(runtime), async (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      runtime.logger.warn("VChatSyncCenter high-risk route audited", {
        route: "/backup/restore",
        method: "POST",
        ip: req.ip,
      });
      const result = await restoreDatabaseBackup(runtime, req.body || {});
      notifyLatestSeq(runtime, result.restored.latest_seq, {
        entity_type: "database",
        action: "restore",
      });
      return res.json(result);
    } catch (error) {
      runtime.logger.warn("database restore failed", { error: error.message });
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/bootstrap/import", async (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      requireBootstrapAuth(runtime, req);
      runtime.logger.warn("VChatSyncCenter high-risk route audited", {
        route: "/bootstrap/import",
        method: "POST",
        ip: req.ip,
      });
      const result = importBootstrap(runtime, req.body || {});
      return res.json(result);
    } catch (error) {
      runtime.logger.warn("bootstrap import rejected", {
        error: error.message,
      });
      const status = /authorization/i.test(error.message) ? 401 : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  router.get("/bootstrap/export", async (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      requireBootstrapAuth(runtime, req);
      runtime.logger.warn("VChatSyncCenter high-risk route audited", {
        route: "/bootstrap/export",
        method: "GET",
        ip: req.ip,
      });
      const result = exportBaseline(runtime, {
        after_seq: req.query.after_seq,
        limit: parseLimit(req.query.limit, runtime, 5000),
        kind: req.query.kind,
        cursor: req.query.cursor,
      });
      return res.json(result);
    } catch (error) {
      runtime.logger.warn("bootstrap export rejected", {
        error: error.message,
      });
      const status = /authorization/i.test(error.message) ? 401 : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  router.post("/attachments", requireSyncAuth(runtime), async (req, res) => {
    const db = getReadyDb(runtime, res);
    if (!db) return null;
    try {
      const multipart = parseMultipartFormData(req);
      const body = multipart ? multipart.fields : req.body || {};
      const rawBody = req.rawBody || req.bodyRaw || null;
      const base64 = body.content_base64 || body.base64 || body.data;
      const buffer = multipart
        ? multipart.fileBuffer
        : Buffer.isBuffer(rawBody) && !base64
        ? rawBody
        : Buffer.from(String(base64 || ""), "base64");
      if (!buffer.length)
        throw new Error(
          "attachment content_base64 or multipart file is required"
        );
      const result = await upsertAttachment(runtime, {
        buffer,
        hash: body.hash,
        ext: body.ext,
        mime_type:
          body.mime_type || (multipart && multipart.fileInfo.mime_type),
        filename: body.filename || (multipart && multipart.fileInfo.filename),
        device_id: body.device_id,
        operation_id: body.operation_id,
      });
      if (result && result.seq !== undefined) {
        notifyLatestSeq(runtime, result.seq, {
          entity_type: "attachment",
          action: result.idempotent ? "upsert" : "create",
          hash: result.hash,
        });
      }
      return res.json(result);
    } catch (error) {
      runtime.logger.warn("attachment upload rejected", {
        error: error.message,
      });
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get(
    "/attachments/:hash",
    requireSyncAuth(runtime),
    async (req, res) => {
      const db = getReadyDb(runtime, res);
      if (!db) return null;
      try {
        runtime.logger.warn("VChatSyncCenter high-risk route audited", {
          route: "/attachments/:hash",
          method: "GET",
          ip: req.ip,
        });
        const hash = String(req.params.hash || "").toLowerCase();
        const attachment = getAttachment(db, runtime.config, hash);
        if (!attachment)
          return res
            .status(404)
            .json({ ok: false, error: "attachment not found" });
        const buffer = await verifyAttachmentFile(attachment);
        res.setHeader(
          "Content-Type",
          attachment.mime_type || "application/octet-stream"
        );
        res.setHeader("Content-Length", String(buffer.length));
        res.setHeader("X-VChat-Attachment-Hash", attachment.hash);
        res.setHeader("X-VChat-Attachment-Ext", attachment.ext || "");
        return res.end(buffer);
      } catch (error) {
        runtime.logger.warn("attachment download rejected", {
          error: error.message,
        });
        return res.status(400).json({ ok: false, error: error.message });
      }
    }
  );
}

module.exports = {
  createSyncRoutes,
};
