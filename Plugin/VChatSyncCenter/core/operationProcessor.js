const crypto = require("crypto");
const { getLatestSeq, getOperationResult } = require("./changeLog");
const { applyCreate, applyUpdate, applyDelete } = require("./messageService");
const { applyConfigOperation } = require("./configService");
const { applyEntityDelete } = require("./deleteService");
const {
  applyTopicUpsert,
  applyTopicOrderMove,
  applyTopicOrderReplace,
} = require("./topicService");
const { applyAvatarOperation } = require("./avatarService");
const { applyThemePackageOperation } = require("./themeService");
const { CONFIG_SCHEMAS } = require("./configSchema");
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

function isConfigEntityType(entityType) {
  return Object.prototype.hasOwnProperty.call(
    CONFIG_SCHEMAS,
    String(entityType || "")
  );
}

function validateOperation(operation) {
  if (!operation || typeof operation !== "object")
    throw new Error("operation body is required");
  if (!operation.operation_id) throw new Error("operation_id is required");
  if (!operation.device_id) throw new Error("device_id is required");
  const entityType = operation.entity_type || operation.type;
  const action = operation.action || operation.operation;
  const isConfig = isConfigEntityType(entityType);
  const isSoftDeleteEntity =
    entityType === "item" ||
    entityType === "topic" ||
    entityType === "topic_history" ||
    entityType === "group_member";
  const isAvatar = entityType === "avatar";
  const isThemePackage = entityType === "theme_package";
  const isTopicOrder = entityType === "topic_order";
  if (
    entityType !== "message" &&
    !isConfig &&
    !isSoftDeleteEntity &&
    !isAvatar &&
    !isThemePackage &&
    !isTopicOrder
  )
    throw new Error(
      "only message/config/item/topic/topic_history/group_member/avatar/theme_package/topic_order operations are supported"
    );
  if (
    entityType === "message" &&
    !["create", "update", "delete"].includes(action)
  )
    throw new Error("unsupported message action");
  if (isConfig && !["create", "update", "delete"].includes(action))
    throw new Error("unsupported config action");
  if (
    entityType === "topic" &&
    !["create", "update", "upsert", "delete"].includes(action)
  )
    throw new Error("unsupported topic action");
  if (isSoftDeleteEntity && entityType !== "topic" && action !== "delete")
    throw new Error("unsupported item/topic_history/group_member action");
  if (isTopicOrder && !["move", "replace"].includes(action))
    throw new Error("unsupported topic_order action");
  if (isAvatar && !["create", "update", "delete", "upsert"].includes(action))
    throw new Error("unsupported avatar action");
  if (
    isThemePackage &&
    !["create", "update", "delete", "upsert"].includes(action)
  )
    throw new Error("unsupported theme_package action");
  const normalizedAction =
    entityType === "topic" || isTopicOrder || isThemePackage
      ? action
      : action === "upsert"
      ? "update"
      : action;
  return {
    ...operation,
    entity_type: entityType,
    action: normalizedAction,
  };
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
    if (isConfigEntityType(operation.entity_type)) {
      return applyConfigOperation(db, operation);
    }
    if (operation.entity_type === "avatar") {
      return applyAvatarOperation(db, operation);
    }
    if (operation.entity_type === "theme_package") {
      return applyThemePackageOperation(db, operation);
    }
    if (operation.entity_type === "topic_order") {
      if (operation.action === "move")
        return applyTopicOrderMove(db, operation);
      return applyTopicOrderReplace(db, operation);
    }
    if (operation.entity_type === "topic" && operation.action !== "delete") {
      return applyTopicUpsert(db, operation);
    }
    if (
      operation.entity_type === "item" ||
      operation.entity_type === "topic" ||
      operation.entity_type === "topic_history" ||
      operation.entity_type === "group_member"
    ) {
      return applyEntityDelete(db, operation);
    }
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
