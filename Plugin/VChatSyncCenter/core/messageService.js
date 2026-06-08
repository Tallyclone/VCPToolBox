const { sha256 } = require("../utils/checksum");
const { safeJsonParse, safeJsonStringify } = require("../utils/safeJson");
const { appendChange } = require("./changeLog");
const { recordConflict } = require("./conflictService");
const { ensureItem } = require("./itemService");
const { getTombstone, insertTombstone } = require("./deleteService");

function nowIso() {
  return new Date().toISOString();
}

function messageKey(input) {
  return `${input.item_type}:${input.item_id}:${input.topic_id}:${input.id}`;
}

function normalizeMessagePayload(operation) {
  const payload = operation.payload || {};
  const message = payload.message || payload.raw_json || payload.raw || payload;
  const itemType =
    operation.item_type || payload.item_type || message.item_type;
  const itemId = operation.item_id || payload.item_id || message.item_id;
  const topicId = operation.topic_id || payload.topic_id || message.topic_id;
  const id =
    operation.entity_id || payload.message_id || payload.id || message.id;
  const rawLocalOrder = payload.local_order ?? operation.local_order;
  const localOrder =
    rawLocalOrder === undefined ||
    rawLocalOrder === null ||
    rawLocalOrder === ""
      ? null
      : Number(rawLocalOrder);

  if (!itemType || !itemId || !topicId || !id) {
    throw new Error(
      "message operation requires item_type, item_id, topic_id and message id"
    );
  }
  if (localOrder !== null && !Number.isInteger(localOrder)) {
    throw new Error("message local_order must be an integer or null");
  }

  return {
    item_type: String(itemType),
    item_id: String(itemId),
    topic_id: String(topicId),
    id: String(id),
    message,
    local_order: localOrder,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
  };
}

function rejectPlaceholderMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.isThinking === true)
    throw new Error("thinking placeholder message is not syncable");
  if (message.id === "loading_history")
    throw new Error("loading_history placeholder message is not syncable");
  if (
    message.placeholder === true ||
    message.ui_placeholder === true ||
    message.status === "placeholder"
  ) {
    throw new Error("ui placeholder message is not syncable");
  }
}

const LARGE_DERIVATIVE_KEYS = new Set([
  "extractedText",
  "imageFrames",
  "ocrText",
  "thumbnail",
  "thumbnailBase64",
  "frames",
]);

function summarizeDerivativeValue(value) {
  if (typeof value === "string") {
    return {
      type: "text",
      size_chars: value.length,
      preview: value.slice(0, 512),
      checksum: sha256(value),
    };
  }
  const json = safeJsonStringify(value);
  return {
    type: Array.isArray(value) ? "array" : typeof value,
    size_chars: json.length,
    item_count: Array.isArray(value) ? value.length : undefined,
    checksum: sha256(json),
  };
}

function sanitizeMessageForCenter(value, derivatives = [], path = "message") {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeMessageForCenter(item, derivatives, `${path}[${index}]`)
    );
  }
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (LARGE_DERIVATIVE_KEYS.has(key)) {
      derivatives.push({
        path: childPath,
        key,
        ...summarizeDerivativeValue(child),
      });
      continue;
    }
    out[key] = sanitizeMessageForCenter(child, derivatives, childPath);
  }
  return out;
}

function normalizeAndSanitizeMessage(identity) {
  const derivatives = [];
  const message = sanitizeMessageForCenter(identity.message, derivatives);
  if (derivatives.length > 0) {
    message._syncDerivatives = {
      stripped: true,
      items: derivatives,
    };
  }
  return { ...identity, message, derivatives };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    item_type: row.item_type,
    item_id: row.item_id,
    topic_id: row.topic_id,
    id: row.id,
    role: row.role,
    content: row.content,
    content_json: safeJsonParse(row.content_json, null),
    metadata_json: safeJsonParse(row.metadata_json, null),
    raw_json: safeJsonParse(row.raw_json, null),
    checksum: row.checksum,
    version: Number(row.version || 0),
    deleted: Number(row.deleted || 0),
    deleted_at: row.deleted_at,
    server_seq: Number(row.server_seq || 0),
    local_order:
      row.local_order === undefined || row.local_order === null
        ? null
        : Number(row.local_order),
  };
}

function getMessage(db, identity) {
  return db
    .prepare(
      `
SELECT * FROM messages
WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?
`
    )
    .get(identity.item_type, identity.item_id, identity.topic_id, identity.id);
}

function getDeletedParent(db, identity) {
  const itemEntityKey = `${identity.item_type}:${identity.item_id}`;
  const topicEntityKey = `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
  const item = db
    .prepare("SELECT deleted FROM items WHERE item_type = ? AND item_id = ?")
    .get(identity.item_type, identity.item_id);
  if (item && Number(item.deleted || 0) === 1) {
    return {
      entity_type: "item",
      entity_key: itemEntityKey,
    };
  }
  if (getTombstone(db, "item", itemEntityKey)) {
    return {
      entity_type: "item",
      entity_key: itemEntityKey,
    };
  }
  const topic = db
    .prepare(
      "SELECT deleted FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
    )
    .get(identity.item_type, identity.item_id, identity.topic_id);
  if (topic && Number(topic.deleted || 0) === 1) {
    return {
      entity_type: "topic",
      entity_key: topicEntityKey,
    };
  }
  if (getTombstone(db, "topic", topicEntityKey)) {
    return {
      entity_type: "topic",
      entity_key: topicEntityKey,
    };
  }
  return null;
}

function requireActiveTopic(db, identity) {
  const topicEntityKey = `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
  const topic = db
    .prepare(
      "SELECT deleted FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
    )
    .get(identity.item_type, identity.item_id, identity.topic_id);
  if (!topic) {
    const error = new Error("message parent topic does not exist");
    error.code = "MESSAGE_TOPIC_MISSING";
    error.details = {
      parent: {
        entity_type: "topic",
        entity_key: topicEntityKey,
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
      },
      message: {
        entity_type: "message",
        entity_key: messageKey(identity),
        message_id: identity.id,
      },
      retry_hint: "submit topic upsert before retrying this message operation",
    };
    throw error;
  }
  if (
    Number(topic.deleted || 0) === 1 ||
    getTombstone(db, "topic", topicEntityKey)
  ) {
    const error = new Error("message parent topic is deleted");
    error.code = "MESSAGE_TOPIC_DELETED";
    error.details = {
      parent: {
        entity_type: "topic",
        entity_key: topicEntityKey,
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
      },
      message: {
        entity_type: "message",
        entity_key: messageKey(identity),
        message_id: identity.id,
      },
    };
    throw error;
  }
  return topic;
}

function rejectDeletedMessageCreate(
  db,
  operation,
  identity,
  entityKey,
  current,
  reason
) {
  recordConflict(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: "message",
    entity_key: entityKey,
    incoming: identity.message,
    current: rowToMessage(current),
    resolution: "delete_wins",
  });
  const seq = appendChange(db, {
    ...operation,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_type: "message",
    entity_id: identity.id,
    action: "create_rejected_deleted",
    version: current ? current.version : null,
    payload: {
      message: identity.message,
      conflict: true,
      deleted: true,
      reason,
    },
  });
  return {
    ok: true,
    seq,
    conflict: true,
    deleted: true,
    resolution: "delete_wins",
  };
}

function filterExistingAttachments(db, attachments) {
  const skipped = [];
  const existing = [];
  const exists = db.prepare(
    "SELECT hash FROM attachments WHERE hash = ? LIMIT 1"
  );

  (attachments || []).forEach((attachment) => {
    const hash = attachment && (attachment.hash || attachment.attachment_hash);
    if (!hash) return;
    if (exists.get(hash)) existing.push({ ...attachment, hash });
    else
      skipped.push({
        ...attachment,
        hash,
        reason: "attachment_not_uploaded_yet",
      });
  });

  return { existing, skipped };
}

function insertMessageAttachments(db, identity, attachments) {
  db.prepare(
    "DELETE FROM message_attachments WHERE item_type = ? AND item_id = ? AND topic_id = ? AND message_id = ?"
  ).run(identity.item_type, identity.item_id, identity.topic_id, identity.id);

  const { existing, skipped } = filterExistingAttachments(
    db,
    attachments || []
  );
  const insert = db.prepare(`
INSERT OR IGNORE INTO message_attachments(item_type, item_id, topic_id, message_id, attachment_hash, usage, sort_order, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

  existing.forEach((attachment, index) => {
    insert.run(
      identity.item_type,
      identity.item_id,
      identity.topic_id,
      identity.id,
      attachment.hash,
      attachment.usage || null,
      index,
      safeJsonStringify(attachment.metadata || attachment)
    );
  });

  return { attached: existing, skipped };
}

function insertHistory(db, current, operation) {
  db.prepare(
    `
INSERT OR REPLACE INTO message_history(item_type, item_id, topic_id, message_id, version, snapshot_json, operation_id, device_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`
  ).run(
    current.item_type,
    current.item_id,
    current.topic_id,
    current.id,
    current.version,
    safeJsonStringify(rowToMessage(current)),
    operation.operation_id,
    operation.device_id || null
  );
}

function messageContentJson(message) {
  return safeJsonStringify(
    message.content === undefined ? null : message.content
  );
}

function applyCreate(db, operation) {
  let identity = normalizeMessagePayload(operation);
  rejectPlaceholderMessage(identity.message);
  identity = normalizeAndSanitizeMessage(identity);

  const rawJson = safeJsonStringify(identity.message);
  const checksum = sha256(rawJson || "");
  const existing = getMessage(db, identity);
  const entityKey = messageKey(identity);

  if (existing) {
    if (Number(existing.deleted || 0) === 1) {
      return rejectDeletedMessageCreate(
        db,
        operation,
        identity,
        entityKey,
        existing,
        "message_deleted"
      );
    }
    if (existing.checksum === checksum) {
      const seq = appendChange(db, {
        ...operation,
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        entity_type: "message",
        entity_id: identity.id,
        action: "create",
        version: existing.version,
        payload: {
          message: identity.message,
          local_order: identity.local_order,
          idempotent_by_checksum: true,
        },
      });
      db.prepare(
        "UPDATE messages SET server_seq = ?, local_order = COALESCE(?, local_order) WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?"
      ).run(
        seq,
        identity.local_order,
        identity.item_type,
        identity.item_id,
        identity.topic_id,
        identity.id
      );
      return { ok: true, seq, conflict: false, version: existing.version };
    }

    recordConflict(db, {
      operation_id: operation.operation_id,
      device_id: operation.device_id,
      entity_type: "message",
      entity_key: entityKey,
      incoming: identity.message,
      current: rowToMessage(existing),
      resolution: "rejected_create_conflict",
    });
    const seq = appendChange(db, {
      ...operation,
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      entity_type: "message",
      entity_id: identity.id,
      action: "create_conflict",
      version: existing.version,
      payload: { message: identity.message, conflict: true, rejected: true },
    });
    return {
      ok: false,
      seq,
      conflict: true,
      error: "message already exists with different checksum",
    };
  }

  if (getTombstone(db, "message", entityKey)) {
    return rejectDeletedMessageCreate(
      db,
      operation,
      identity,
      entityKey,
      null,
      "message_tombstone"
    );
  }
  const deletedParent = getDeletedParent(db, identity);
  if (deletedParent) {
    return rejectDeletedMessageCreate(
      db,
      operation,
      identity,
      entityKey,
      null,
      `${deletedParent.entity_type}_deleted`
    );
  }
  requireActiveTopic(db, identity);

  ensureItem(
    db,
    identity.item_type,
    identity.item_id,
    operation.payload && operation.payload.item
  );

  db.prepare(
    `
INSERT INTO messages(item_type, item_id, topic_id, id, role, content, content_json, metadata_json, raw_json, checksum, version, deleted, server_seq, local_order)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)
`
  ).run(
    identity.item_type,
    identity.item_id,
    identity.topic_id,
    identity.id,
    identity.message.role || null,
    typeof identity.message.content === "string"
      ? identity.message.content
      : null,
    messageContentJson(identity.message),
    safeJsonStringify(identity.message.metadata || null),
    rawJson,
    checksum,
    identity.local_order
  );
  const attachmentState = insertMessageAttachments(
    db,
    identity,
    identity.attachments
  );

  const seq = appendChange(db, {
    ...operation,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_type: "message",
    entity_id: identity.id,
    action: "create",
    version: 1,
    payload: {
      message: identity.message,
      local_order: identity.local_order,
      attachments: identity.attachments,
      attachment_refs: attachmentState,
      derivatives: identity.derivatives,
    },
  });
  db.prepare(
    "UPDATE messages SET server_seq = ?, local_order = COALESCE(?, local_order) WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?"
  ).run(
    seq,
    identity.local_order,
    identity.item_type,
    identity.item_id,
    identity.topic_id,
    identity.id
  );
  return { ok: true, seq, conflict: false, version: 1 };
}

function applyUpdate(db, operation) {
  let identity = normalizeMessagePayload(operation);
  rejectPlaceholderMessage(identity.message);
  identity = normalizeAndSanitizeMessage(identity);
  const current = getMessage(db, identity);
  const entityKey = messageKey(identity);
  requireActiveTopic(db, identity);
  if (!current) {
    const error = new Error("message update target does not exist");
    error.code = "MESSAGE_UPDATE_TARGET_MISSING";
    throw error;
  }

  if (Number(current.deleted || 0) === 1) {
    recordConflict(db, {
      operation_id: operation.operation_id,
      device_id: operation.device_id,
      entity_type: "message",
      entity_key: entityKey,
      base_version: operation.base_version,
      incoming: identity.message,
      current: rowToMessage(current),
      resolution: "delete_wins",
    });
    const seq = appendChange(db, {
      ...operation,
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      entity_type: "message",
      entity_id: identity.id,
      action: "update_rejected_deleted",
      version: current.version,
      payload: { message: identity.message, conflict: true, deleted: true },
    });
    return { ok: true, seq, conflict: true, deleted: true };
  }

  const baseVersion =
    operation.base_version === undefined
      ? null
      : Number(operation.base_version);
  if (
    operation.base_version !== undefined &&
    operation.base_version !== null &&
    !Number.isInteger(baseVersion)
  ) {
    throw new Error("base_version must be integer or null");
  }
  const hasConflict =
    baseVersion === null || baseVersion !== Number(current.version || 0);
  insertHistory(db, current, operation);
  if (hasConflict) {
    recordConflict(db, {
      operation_id: operation.operation_id,
      device_id: operation.device_id,
      entity_type: "message",
      entity_key: entityKey,
      base_version: baseVersion,
      incoming: identity.message,
      current: rowToMessage(current),
      resolution: "lww_accepted",
    });
  }

  const nextVersion = Number(current.version || 0) + 1;
  const rawJson = safeJsonStringify(identity.message);
  const checksum = sha256(rawJson || "");
  db.prepare(
    `
UPDATE messages
SET role = ?, content = ?, content_json = ?, metadata_json = ?, raw_json = ?, checksum = ?, version = ?, local_order = COALESCE(?, local_order), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?
`
  ).run(
    identity.message.role || null,
    typeof identity.message.content === "string"
      ? identity.message.content
      : null,
    messageContentJson(identity.message),
    safeJsonStringify(identity.message.metadata || null),
    rawJson,
    checksum,
    nextVersion,
    identity.local_order,
    identity.item_type,
    identity.item_id,
    identity.topic_id,
    identity.id
  );
  const attachmentState = insertMessageAttachments(
    db,
    identity,
    identity.attachments
  );

  const seq = appendChange(db, {
    ...operation,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_type: "message",
    entity_id: identity.id,
    action: "update",
    version: nextVersion,
    payload: {
      message: identity.message,
      local_order: identity.local_order,
      base_version: baseVersion,
      conflict: hasConflict,
      attachments: identity.attachments,
      attachment_refs: attachmentState,
      derivatives: identity.derivatives,
    },
  });
  db.prepare(
    "UPDATE messages SET server_seq = ? WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?"
  ).run(
    seq,
    identity.item_type,
    identity.item_id,
    identity.topic_id,
    identity.id
  );
  return { ok: true, seq, conflict: hasConflict, version: nextVersion };
}

function applyDelete(db, operation) {
  const payload = operation.payload || {};
  const identity = normalizeMessagePayload({
    ...operation,
    payload: {
      ...payload,
      message: payload.message || { id: payload.id || operation.entity_id },
    },
  });
  const current = getMessage(db, identity);
  const deletedAt = payload.deleted_at || nowIso();
  const retainUntil = payload.retain_until || null;
  const entityKey = messageKey(identity);

  if (current) {
    db.prepare(
      `
UPDATE messages
SET deleted = 1, deleted_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?
`
    ).run(
      deletedAt,
      identity.item_type,
      identity.item_id,
      identity.topic_id,
      identity.id
    );
  }

  insertTombstone(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: "message",
    entity_key: entityKey,
    reason: payload.reason || "delete",
    payload,
    deleted_at: deletedAt,
    retain_until: retainUntil,
    snapshot: rowToMessage(current),
    base_version: current ? Number(current.version || 0) : null,
  });

  const seq = appendChange(db, {
    ...operation,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_type: "message",
    entity_id: identity.id,
    action: "delete",
    version: current ? Number(current.version || 0) : null,
    payload: {
      deleted_at: deletedAt,
      retain_until: retainUntil,
      existed: !!current,
    },
  });

  if (current) {
    db.prepare(
      "UPDATE messages SET server_seq = ? WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?"
    ).run(
      seq,
      identity.item_type,
      identity.item_id,
      identity.topic_id,
      identity.id
    );
  }
  return { ok: true, seq, conflict: false, deleted: true };
}

module.exports = {
  applyCreate,
  applyUpdate,
  applyDelete,
};
