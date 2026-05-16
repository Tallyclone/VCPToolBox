const crypto = require("crypto");
const { getLatestSeq, getOperationResult } = require("./changeLog");
const { applyCreate, applyUpdate, applyDelete } = require("./messageService");
const { applyConfigOperation } = require("./configService");
const { safeJsonStringify } = require("../utils/safeJson");

function hashDeviceKey(deviceKey) {
  if (!deviceKey) return null;
  return crypto.createHash("sha256").update(String(deviceKey)).digest("hex");
}

function registerDevice(db, input = {}) {
  const deviceId = String(input.device_id || input.id || "").trim();
  if (!deviceId) throw new Error("device_id is required");
  const now = new Date().toISOString();
  const trusted = input.trusted ? 1 : 0;
  db.prepare(
    `
INSERT INTO devices(id, name, platform, device_key_hash, trusted, metadata_json, created_at, updated_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  platform = excluded.platform,
  device_key_hash = COALESCE(excluded.device_key_hash, devices.device_key_hash),
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at,
  last_seen_at = excluded.last_seen_at
`
  ).run(
    deviceId,
    input.name || null,
    input.platform || null,
    hashDeviceKey(input.device_key),
    trusted,
    safeJsonStringify(input.metadata || {}),
    now,
    now,
    now
  );
  return {
    ok: true,
    device_id: deviceId,
    trusted: trusted === 1,
  };
}

function validateOperation(operation) {
  if (!operation || typeof operation !== "object")
    throw new Error("operation body is required");
  if (!operation.operation_id) throw new Error("operation_id is required");
  if (!operation.device_id) throw new Error("device_id is required");
  const entityType = operation.entity_type || operation.type;
  const action = operation.action || operation.operation;
  const isConfig =
    String(entityType || "").includes("config") || entityType === "settings";
  if (entityType !== "message" && !isConfig)
    throw new Error("only message/config operations are supported");
  if (
    entityType === "message" &&
    !["create", "update", "delete"].includes(action)
  )
    throw new Error("unsupported message action");
  if (isConfig && !["create", "update"].includes(action))
    throw new Error("unsupported config action");
  return { ...operation, entity_type: entityType, action };
}

function ensureRegisteredDevice(db, operation, options = {}) {
  if (!options.requireDeviceBinding) return;
  const row = db
    .prepare("SELECT id FROM devices WHERE id = ? LIMIT 1")
    .get(operation.device_id);
  if (!row) throw new Error("device is not registered");
}

function processOperation(db, input, options = {}) {
  const operation = validateOperation(input);
  const transaction = db.transaction(() => {
    const previous = getOperationResult(db, operation.operation_id);
    if (previous) return previous;

    ensureRegisteredDevice(db, operation, options);
    const isConfig =
      String(operation.entity_type || "").includes("config") ||
      operation.entity_type === "settings";
    if (isConfig) return applyConfigOperation(db, operation);
    if (operation.action === "create") return applyCreate(db, operation);
    if (operation.action === "update") return applyUpdate(db, operation);
    return applyDelete(db, operation);
  });

  const result = transaction();
  return {
    ...result,
    operation_id: operation.operation_id,
    latest_seq: getLatestSeq(db),
  };
}

module.exports = {
  registerDevice,
  processOperation,
};
