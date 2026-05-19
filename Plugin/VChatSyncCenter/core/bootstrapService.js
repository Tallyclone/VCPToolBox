const { appendChange, getLatestSeq, getChanges } = require("./changeLog");
const { registerDevice } = require("./operationProcessor");
const { applyCreate } = require("./messageService");
const { applyConfigOperation } = require("./configService");
const { safeJsonParse, safeJsonStringify } = require("../utils/safeJson");

function parseJson(value, fallback) {
  return safeJsonParse(value, fallback);
}

function audit(runtime, action, detail = {}) {
  const logger = runtime && runtime.logger;
  if (logger && logger.warn)
    logger.warn(`VChatSyncCenter bootstrap ${action}`, detail);
}

function requireBootstrapAuth(runtime, req) {
  const configured =
    runtime.config.bootstrapKey || runtime.config.syncKey || "";
  const header = String(
    (req.headers &&
      (req.headers["x-vchat-bootstrap-key"] || req.headers.authorization)) ||
      ""
  );
  const token = header.replace(/^Bearer\s+/i, "");
  if (!configured || token !== configured) {
    throw new Error("bootstrap authorization failed");
  }
}

function centerIsEmpty(db) {
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM config_entities) AS configs,
        (SELECT COUNT(*) FROM attachments) AS attachments,
        (SELECT COUNT(*) FROM change_log) AS changes`
    )
    .get();
  return (
    !row ||
    (row.messages === 0 &&
      row.items === 0 &&
      row.topics === 0 &&
      row.configs === 0 &&
      row.attachments === 0 &&
      row.changes === 0)
  );
}

function insertBaselineChange(db, input) {
  return appendChange(db, {
    operation_id: input.operation_id,
    device_id: input.device_id || null,
    item_type: input.item_type || null,
    item_id: input.item_id || null,
    topic_id: input.topic_id || null,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    action: input.action || "baseline",
    version: input.version || 1,
    payload: input.payload || {},
  });
}

function startBootstrapSession(db, manifest, counts) {
  const sessionId =
    manifest.session_id ||
    manifest.sessionId ||
    `bootstrap.${
      manifest.device_id || manifest.deviceId || "unknown"
    }.${Date.now()}`;
  db.prepare(
    `INSERT INTO bootstrap_sessions(id, mode, device_id, status, checkpoint_json, audit_json)
     VALUES (?, ?, ?, 'started', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       device_id = excluded.device_id,
       status = 'started',
       checkpoint_json = excluded.checkpoint_json,
       audit_json = excluded.audit_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(
    sessionId,
    manifest.mode || "bootstrap_primary",
    manifest.device_id || manifest.deviceId || null,
    safeJsonStringify({ stage: "started", counts }),
    safeJsonStringify({ started_at: new Date().toISOString() })
  );
  return sessionId;
}

function updateBootstrapSession(
  db,
  sessionId,
  status,
  checkpoint = {},
  auditDetail = {}
) {
  db.prepare(
    `UPDATE bootstrap_sessions
     SET status = ?, checkpoint_json = ?, audit_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    status,
    safeJsonStringify(checkpoint),
    safeJsonStringify({ ...auditDetail, updated_at: new Date().toISOString() }),
    sessionId
  );
}

function parseCursor(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildPageInfo(kind, cursor, limit, rows) {
  return {
    kind,
    cursor,
    limit,
    has_more: rows.length > limit,
    next_cursor: rows.length > limit ? cursor + limit : null,
  };
}

function takePage(rows, limit) {
  return rows.length > limit ? rows.slice(0, limit) : rows;
}

function importBootstrap(runtime, manifest = {}) {
  const db = runtime.dbContext.db;
  const deviceId = manifest.device_id || manifest.deviceId || null;
  const mode = manifest.mode || "bootstrap_primary";
  if (mode === "bootstrap_primary" && !centerIsEmpty(db)) {
    throw new Error("center is not empty; bootstrap_primary refused");
  }
  const messages = Array.isArray(manifest.messages) ? manifest.messages : [];
  const configs = Array.isArray(manifest.configs) ? manifest.configs : [];
  const attachments = Array.isArray(manifest.attachments)
    ? manifest.attachments
    : [];
  const conflicts = Array.isArray(manifest.conflicts) ? manifest.conflicts : [];
  const sessionId = startBootstrapSession(db, manifest, {
    messages: messages.length,
    configs: configs.length,
    attachments: attachments.length,
    conflicts: conflicts.length,
  });

  const tx = db.transaction(() => {
    if (deviceId) {
      registerDevice(db, {
        device_id: deviceId,
        name: manifest.device_name || manifest.deviceName || deviceId,
        platform: manifest.platform || null,
        trusted: true,
        metadata: { bootstrap_mode: mode },
      });
    }

    for (const config of configs) {
      const payload = config.payload || config;
      applyConfigOperation(db, {
        operation_id:
          payload.operation_id ||
          `bootstrap.config.${deviceId || "unknown"}.${payload.schema}.${
            payload.entity_id
          }`,
        device_id: deviceId,
        entity_type: payload.schema,
        entity_id: payload.entity_id || payload.relative_path,
        action: "create",
        payload,
      });
    }

    for (const entry of messages) {
      const message = entry.message || entry.raw_json || entry;
      applyCreate(db, {
        operation_id:
          entry.operation_id ||
          `bootstrap.message.${deviceId || "unknown"}.${entry.item_type}.${
            entry.item_id
          }.${entry.topic_id}.${message.id}`,
        device_id: deviceId,
        entity_type: "message",
        entity_id: message.id || entry.id,
        item_type: entry.item_type || message.item_type,
        item_id: entry.item_id || message.item_id,
        topic_id: entry.topic_id || message.topic_id,
        action: "create",
        payload: {
          item: entry.item || null,
          topic: entry.topic || null,
          message,
          local_order: entry.local_order,
          attachments: entry.attachments || message.attachments || [],
        },
      });
    }

    for (const attachment of attachments) {
      insertBaselineChange(db, {
        operation_id:
          attachment.operation_id ||
          `bootstrap.attachment.${deviceId || "unknown"}.${attachment.hash}`,
        device_id: deviceId,
        entity_type: "attachment",
        entity_id: attachment.hash,
        action: "baseline",
        payload: attachment,
      });
    }

    for (const conflict of conflicts) {
      db.prepare(
        `INSERT INTO conflicts(operation_id, device_id, entity_type, entity_key, base_version, incoming_json, current_json, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(
        conflict.operation_id || `bootstrap.conflict.${Date.now()}`,
        deviceId,
        conflict.entity_type || conflict.type || "bootstrap",
        conflict.entity_key || conflict.normalized_id || "unknown",
        conflict.base_version || null,
        safeJsonStringify(conflict.incoming || conflict),
        safeJsonStringify(conflict.current || null)
      );
    }

    return getLatestSeq(db);
  });

  let latestSeq = 0;
  try {
    latestSeq = tx();
    updateBootstrapSession(
      db,
      sessionId,
      "completed",
      {
        stage: "completed",
        latest_seq: latestSeq,
        imported: {
          messages: messages.length,
          configs: configs.length,
          attachments: attachments.length,
          conflicts: conflicts.length,
        },
      },
      { mode, device_id: deviceId }
    );
  } catch (error) {
    updateBootstrapSession(
      db,
      sessionId,
      "failed",
      { stage: "failed", error: error.message },
      { mode, device_id: deviceId }
    );
    throw error;
  }
  audit(runtime, "import", {
    mode,
    session_id: sessionId,
    device_id: deviceId,
    messages: messages.length,
    configs: configs.length,
    attachments: attachments.length,
    conflicts: conflicts.length,
    latest_seq: latestSeq,
  });
  return {
    ok: true,
    mode,
    session_id: sessionId,
    imported: {
      messages: messages.length,
      configs: configs.length,
      attachments: attachments.length,
      conflicts: conflicts.length,
    },
    latest_seq: latestSeq,
  };
}

function exportBaseline(runtime, options = {}) {
  const db = runtime.dbContext.db;
  const afterSeq = Math.max(Number(options.after_seq || 0) || 0, 0);
  const limit = Math.min(
    Math.max(Number(options.limit || 5000) || 5000, 1),
    runtime.config.maxLimit || 5000
  );
  const kind = String(options.kind || "all").toLowerCase();
  const cursor = parseCursor(options.cursor);
  const pageLimit = limit + 1;

  const loadMessages = kind === "all" || kind === "messages";
  const loadConfigs = kind === "all" || kind === "configs";
  const loadAttachments = kind === "all" || kind === "attachments";

  const messageRows = loadMessages
    ? db
        .prepare(
          `SELECT * FROM messages WHERE deleted = 0 ORDER BY item_type, item_id, topic_id, COALESCE(local_order, 2147483647), server_seq, id LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const messages = takePage(messageRows, limit).map((row) => ({
    item_type: row.item_type,
    item_id: row.item_id,
    topic_id: row.topic_id,
    id: row.id,
    version: row.version,
    message: parseJson(row.raw_json, null),
    checksum: row.checksum,
    local_order:
      row.local_order === undefined || row.local_order === null
        ? null
        : Number(row.local_order),
  }));
  const configRows = loadConfigs
    ? db
        .prepare(
          `SELECT * FROM config_entities WHERE deleted = 0 AND COALESCE(profile, 'bootstrap') = 'bootstrap' ORDER BY schema, entity_id LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const configs = takePage(configRows, limit).map((row) => ({
    schema: row.schema,
    entity_id: row.entity_id,
    dto_version: row.dto_version,
    safe_projection_json: parseJson(row.safe_projection_json, {}),
    profile: row.profile || "bootstrap",
    projection_fields: parseJson(row.projection_fields_json, []),
    checksum: row.checksum,
    version: row.version,
  }));
  const attachmentRows = loadAttachments
    ? db
        .prepare(`SELECT * FROM attachments ORDER BY hash LIMIT ? OFFSET ?`)
        .all(pageLimit, cursor)
    : [];

  const attachments = takePage(attachmentRows, limit).map((row) => ({
    hash: row.hash,
    algorithm: row.algorithm,
    size_bytes: row.size_bytes,
    mime_type: row.mime_type,
    ext: row.ext,
    storage_path: row.storage_path,
    metadata: parseJson(row.metadata_json, {}),
  }));
  const changes = afterSeq > 0 ? getChanges(db, afterSeq, limit) : [];
  return {
    ok: true,
    exported_at: new Date().toISOString(),
    latest_seq: getLatestSeq(db),
    after_seq: afterSeq,
    changes,
    has_more_changes:
      changes.length === limit &&
      changes.length > 0 &&
      changes[changes.length - 1].seq < getLatestSeq(db),
    next_after_seq:
      changes.length > 0 ? changes[changes.length - 1].seq : afterSeq,
    page: {
      kind,
      messages: buildPageInfo("messages", cursor, limit, messageRows),
      configs: buildPageInfo("configs", cursor, limit, configRows),
      attachments: buildPageInfo("attachments", cursor, limit, attachmentRows),
    },
    baseline: { messages, configs, attachments },
  };
}

module.exports = {
  requireBootstrapAuth,
  centerIsEmpty,
  importBootstrap,
  exportBaseline,
};
