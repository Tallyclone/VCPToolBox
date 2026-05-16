const { safeJsonStringify } = require('../utils/safeJson');

function recordConflict(db, conflict) {
  const info = db.prepare(`
INSERT INTO conflicts(operation_id, device_id, entity_type, entity_key, base_version, incoming_json, current_json, resolution)
VALUES (@operation_id, @device_id, @entity_type, @entity_key, @base_version, @incoming_json, @current_json, @resolution)
`).run({
    operation_id: conflict.operation_id || null,
    device_id: conflict.device_id || null,
    entity_type: conflict.entity_type,
    entity_key: conflict.entity_key,
    base_version: conflict.base_version === undefined ? null : conflict.base_version,
    incoming_json: safeJsonStringify(conflict.incoming || null),
    current_json: safeJsonStringify(conflict.current || null),
    resolution: conflict.resolution || 'pending',
  });
  return Number(info.lastInsertRowid);
}

function listConflicts(db, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), Number(options.maxLimit || 5000));
  return db.prepare(`
SELECT id, operation_id, device_id, entity_type, entity_key, base_version, incoming_json, current_json, resolution, created_at, resolved_at
FROM conflicts
ORDER BY id DESC
LIMIT ?
`).all(limit);
}

module.exports = {
  recordConflict,
  listConflicts,
};
