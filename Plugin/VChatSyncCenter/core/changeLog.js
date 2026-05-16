const { safeJsonParse, safeJsonStringify } = require("../utils/safeJson");

function getLatestSeq(db) {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM change_log")
    .get();
  return row ? Number(row.latest_seq || 0) : 0;
}

function getOperationResult(db, operationId) {
  if (!operationId) return null;
  const row = db
    .prepare(
      "SELECT * FROM change_log WHERE operation_id = ? ORDER BY seq ASC LIMIT 1"
    )
    .get(operationId);
  if (!row) return null;

  const payload = safeJsonParse(row.payload_json, {});
  const isRejectedCreate = row.action === "create_conflict";
  return {
    ok: !isRejectedCreate,
    seq: Number(row.seq),
    operation_id: row.operation_id,
    idempotent: true,
    conflict: !!(payload && payload.conflict),
    error: isRejectedCreate
      ? "message already exists with different checksum"
      : undefined,
    entity_type: row.entity_type,
    action: row.action,
    version: row.version,
  };
}

function appendChange(db, event) {
  const payloadJson = safeJsonStringify(event.payload || {});
  const info = db
    .prepare(
      `
INSERT INTO change_log(operation_id, device_id, item_type, item_id, topic_id, entity_type, entity_id, action, version, payload_json)
VALUES (@operation_id, @device_id, @item_type, @item_id, @topic_id, @entity_type, @entity_id, @action, @version, @payload_json)
`
    )
    .run({
      operation_id: event.operation_id,
      device_id: event.device_id || null,
      item_type: event.item_type || null,
      item_id: event.item_id || null,
      topic_id: event.topic_id || null,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      action: event.action,
      version: event.version || null,
      payload_json: payloadJson,
    });
  return Number(info.lastInsertRowid);
}

function getChanges(db, afterSeq = 0, limit = 1000) {
  const rows = db
    .prepare(
      `
SELECT seq, operation_id, device_id, item_type, item_id, topic_id, entity_type, entity_id, action, version, payload_json, created_at
FROM change_log
WHERE seq > ?
ORDER BY seq ASC
LIMIT ?
`
    )
    .all(Number(afterSeq || 0), Number(limit || 1000));

  return rows.map((row) => ({
    seq: Number(row.seq),
    operation_id: row.operation_id,
    device_id: row.device_id,
    item_type: row.item_type,
    item_id: row.item_id,
    topic_id: row.topic_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    version: row.version,
    payload: safeJsonParse(row.payload_json, null),
    created_at: row.created_at,
  }));
}

module.exports = {
  getLatestSeq,
  getOperationResult,
  appendChange,
  getChanges,
};
