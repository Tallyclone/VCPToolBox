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
    entity_id: row.entity_id,
    action: row.action,
    version: row.version,
    payload,
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

function mapChangeRow(row) {
  return {
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
  };
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

  return rows.map(mapChangeRow);
}

function getCompactedChanges(db, afterSeq = 0, limit = 1000) {
  const normalizedAfterSeq = Number(afterSeq || 0);
  const normalizedLimit = Number(limit || 1000);
  const rows = db
    .prepare(
      `
WITH compacted_events AS (
  SELECT
    latest_seq AS seq,
    NULL AS operation_id,
    latest_device_id AS device_id,
    item_type,
    item_id,
    topic_id,
    'topic_order' AS entity_type,
    topic_id AS entity_id,
    'move' AS action,
    NULL AS version,
    json_object(
      'mode', 'move_to_front',
      'source', 'activity',
      'activity_at', activity_at,
      'compacted', 1,
      'applied', 1
    ) AS payload_json,
    updated_at AS created_at
  FROM topic_activity_state
  WHERE latest_seq > ?
), ordinary_events AS (
  SELECT seq, operation_id, device_id, item_type, item_id, topic_id, entity_type, entity_id, action, version, payload_json, created_at
  FROM change_log
  WHERE seq > ?
    AND NOT (
      entity_type = 'topic_order'
      AND action = 'move'
      AND payload_json LIKE '%"source":"activity"%'
      AND payload_json LIKE '%"mode":"move_to_front"%'
    )
)
SELECT * FROM ordinary_events
UNION ALL
SELECT * FROM compacted_events
ORDER BY seq ASC
LIMIT ?
`
    )
    .all(normalizedAfterSeq, normalizedAfterSeq, normalizedLimit);

  return rows.map(mapChangeRow);
}

module.exports = {
  getLatestSeq,
  getOperationResult,
  appendChange,
  getChanges,
  getCompactedChanges,
};
