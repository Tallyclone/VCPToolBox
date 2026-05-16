const { appendChange } = require("./changeLog");
const { safeJsonStringify, stableJsonStringify } = require("../utils/safeJson");
const { sha256 } = require("../utils/checksum");
const {
  SENSITIVE_KEY_PATTERN,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
} = require("./configSchema");

function buildConfigChecksumSource({
  dto_version,
  schema,
  entity_id,
  safe_projection_json,
}) {
  return {
    dto_version: Number(dto_version || 1),
    schema,
    entity_id,
    safe_projection_json,
  };
}

function checksumConfigDto({
  dto_version,
  schema,
  entity_id,
  safe_projection_json,
}) {
  return sha256(
    stableJsonStringify(
      buildConfigChecksumSource({
        dto_version,
        schema,
        entity_id,
        safe_projection_json,
      })
    )
  );
}

function normalizeConfigOperation(operation) {
  const payload = operation.payload || {};
  const dto =
    payload.safe_projection_json || payload.dto || payload.config || {};
  const schema = String(operation.entity_type || payload.schema || "");
  const entityId = String(
    operation.entity_id || payload.entity_id || payload.relative_path || ""
  );
  if (!schema || !entityId)
    throw new Error("config operation requires schema and entity_id");
  if (!payload.dto_version)
    throw new Error("config payload requires dto_version");
  validateSafeConfigDto(schema, dto);
  const dtoVersion = Number(payload.dto_version || 1);
  const safeProjectionJson = safeJsonStringify(dto);
  const computedChecksum = checksumConfigDto({
    dto_version: dtoVersion,
    schema,
    entity_id: entityId,
    safe_projection_json: dto,
  });
  if (payload.checksum && payload.checksum !== computedChecksum) {
    throw new Error("config payload checksum mismatch");
  }
  const checksum = computedChecksum;
  return {
    schema,
    entity_id: entityId,
    relative_path: payload.relative_path || entityId,
    dto_version: dtoVersion,
    safe_projection_json: safeProjectionJson,
    checksum,
    dto,
  };
}

function applyConfigOperation(db, operation) {
  const normalized = normalizeConfigOperation(operation);
  const current = db
    .prepare(
      "SELECT version FROM config_entities WHERE schema = ? AND entity_id = ?"
    )
    .get(normalized.schema, normalized.entity_id);
  const nextVersion = current ? Number(current.version || 0) + 1 : 1;
  db.prepare(
    `
INSERT INTO config_entities(schema, entity_id, dto_version, safe_projection_json, checksum, operation_id, device_id, version, deleted, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(schema, entity_id) DO UPDATE SET
  dto_version = excluded.dto_version,
  safe_projection_json = excluded.safe_projection_json,
  checksum = excluded.checksum,
  operation_id = excluded.operation_id,
  device_id = excluded.device_id,
  version = excluded.version,
  deleted = 0,
  updated_at = excluded.updated_at
`
  ).run(
    normalized.schema,
    normalized.entity_id,
    normalized.dto_version,
    normalized.safe_projection_json,
    normalized.checksum,
    operation.operation_id,
    operation.device_id || null,
    nextVersion
  );

  const seq = appendChange(db, {
    ...operation,
    entity_type: normalized.schema,
    entity_id: normalized.entity_id,
    action: operation.action || "update",
    version: nextVersion,
    payload: {
      dto_version: normalized.dto_version,
      schema: normalized.schema,
      entity_id: normalized.entity_id,
      relative_path: normalized.relative_path,
      safe_projection_json: normalized.dto,
      checksum: normalized.checksum,
    },
  });
  return { ok: true, seq, version: nextVersion, checksum: normalized.checksum };
}

module.exports = {
  applyConfigOperation,
  normalizeConfigOperation,
  buildConfigChecksumSource,
  checksumConfigDto,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
  SENSITIVE_KEY_PATTERN,
};
