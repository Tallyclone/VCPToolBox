const { appendChange } = require("./changeLog");
const {
  applyConfigDelete,
  rejectDeletedConfigChange,
  getTombstone,
  configKey,
} = require("./deleteService");
const { ensureItem } = require("./itemService");
const { applyTopicUpsert } = require("./topicService");
const { safeJsonStringify, stableJsonStringify } = require("../utils/safeJson");
const { sha256 } = require("../utils/checksum");
const {
  SENSITIVE_KEY_PATTERN,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
  validateDeletedFields,
} = require("./configSchema");

function buildConfigChecksumSource({
  dto_version,
  schema,
  entity_id,
  safe_projection_json,
  projection_fields,
  deleted_fields,
  profile,
}) {
  return {
    dto_version: Number(dto_version || 1),
    schema,
    entity_id,
    safe_projection_json,
    projection_fields: Array.isArray(projection_fields)
      ? projection_fields
      : undefined,
    deleted_fields: Array.isArray(deleted_fields) ? deleted_fields : undefined,
    profile: profile || "bootstrap",
  };
}

function checksumConfigDto({
  dto_version,
  schema,
  entity_id,
  safe_projection_json,
  projection_fields,
  deleted_fields,
  profile,
}) {
  return sha256(
    stableJsonStringify(
      buildConfigChecksumSource({
        dto_version,
        schema,
        entity_id,
        safe_projection_json,
        projection_fields,
        deleted_fields,
        profile,
      })
    )
  );
}

function configOwnerIdentity(configPayload = {}) {
  const schema = configPayload.schema;
  if (schema !== "agent_config" && schema !== "group_config") return null;
  const entityId = String(
    configPayload.entity_id || configPayload.relative_path || ""
  ).replace(/\\/g, "/");
  const match = /^(Agents|AgentGroups)\/([^/]+)\/config\.json$/i.exec(entityId);
  if (!match) return null;
  return {
    item_type: match[1].toLowerCase() === "agentgroups" ? "group" : "agent",
    item_id: match[2],
  };
}

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

function normalizeDerivedTopic(topic) {
  const source =
    topic && typeof topic === "object" && !Array.isArray(topic) ? topic : {};
  const id = topicIdOf(source);
  if (!id) return null;
  const safe = { id: String(id) };
  if (source.name !== undefined && source.name !== null) {
    safe.name = source.name;
  } else if (source.title || source.topic_title || source.topicTitle) {
    safe.name = source.title || source.topic_title || source.topicTitle;
  }
  if (source.createdAt !== undefined && source.createdAt !== null) {
    safe.createdAt = source.createdAt;
  } else if (source.created_at || source.timestamp) {
    safe.createdAt = source.created_at || source.timestamp;
  }
  for (const key of ["locked", "unread", "creatorSource"]) {
    if (Object.prototype.hasOwnProperty.call(source, key))
      safe[key] = source[key];
  }
  return safe;
}

function topicParentExists(db, owner, topicId) {
  const row = db
    .prepare(
      "SELECT id FROM topics WHERE item_type = ? AND item_id = ? AND id = ? LIMIT 1"
    )
    .get(owner.item_type, owner.item_id, String(topicId));
  return Boolean(row);
}

function deriveTopicsFromConfigDto(
  db,
  normalized,
  operation,
  source = "runtime_config_topics"
) {
  const owner = configOwnerIdentity(normalized);
  if (!owner) return 0;
  const dto = normalized.dto || {};
  const topics = Array.isArray(dto.topics) ? dto.topics : [];
  if (topics.length === 0) return 0;
  ensureItem(db, owner.item_type, owner.item_id, {
    title: dto.name || owner.item_id,
    source,
  });
  let count = 0;
  for (const topic of topics) {
    const safeTopic = normalizeDerivedTopic(topic);
    const topicId = safeTopic && safeTopic.id;
    if (!topicId || topicParentExists(db, owner, topicId)) continue;
    applyTopicUpsert(db, {
      operation_id: `${operation.operation_id || "config"}.derived_topic.${
        owner.item_type
      }.${owner.item_id}.${topicId}`,
      device_id: operation.device_id,
      entity_type: "topic",
      entity_id: topicId,
      item_type: owner.item_type,
      item_id: owner.item_id,
      topic_id: topicId,
      action: "upsert",
      payload: { topic: safeTopic, source },
    });
    count += 1;
  }
  return count;
}

function normalizeConfigOperation(operation) {
  const payload = operation.payload || {};
  const dto =
    payload.safe_projection_json || payload.dto || payload.config || {};
  const schema = String(operation.entity_type || payload.schema || "");
  const entityId = String(
    operation.entity_id || payload.entity_id || payload.relative_path || ""
  );
  const profile = payload.profile || operation.profile || "bootstrap";
  const projectionFields =
    payload.projection_fields || operation.projection_fields;
  if (!schema || !entityId) {
    throw new Error("config operation requires schema and entity_id");
  }
  if (!payload.dto_version) {
    throw new Error("config payload requires dto_version");
  }
  validateSafeConfigDto(schema, dto, {
    profile,
    projection_fields: projectionFields,
  });
  const deletedFields = validateDeletedFields(
    schema,
    payload.deleted_fields || operation.deleted_fields,
    projectionFields,
    profile
  );
  const dtoVersion = Number(payload.dto_version || 1);
  const safeProjectionJson = safeJsonStringify(dto);
  const computedChecksum = checksumConfigDto({
    dto_version: dtoVersion,
    schema,
    entity_id: entityId,
    safe_projection_json: dto,
    projection_fields: projectionFields,
    deleted_fields: deletedFields,
    profile,
  });
  if (payload.checksum && payload.checksum !== computedChecksum) {
    throw new Error("config payload checksum mismatch");
  }
  return {
    schema,
    entity_id: entityId,
    relative_path: payload.relative_path || entityId,
    profile,
    projection_fields: Array.isArray(projectionFields)
      ? projectionFields
      : null,
    deleted_fields: deletedFields,
    dto_version: dtoVersion,
    safe_projection_json: safeProjectionJson,
    checksum: computedChecksum,
    dto,
  };
}

function applyConfigOperation(db, operation) {
  if (operation.action === "delete") {
    return applyConfigDelete(db, operation);
  }
  const normalized = normalizeConfigOperation(operation);
  const current = db
    .prepare(
      "SELECT * FROM config_entities WHERE schema = ? AND entity_id = ? AND profile = ?"
    )
    .get(normalized.schema, normalized.entity_id, normalized.profile);
  if (current && Number(current.deleted || 0) === 1) {
    return rejectDeletedConfigChange(
      db,
      {
        ...operation,
        entity_id: normalized.entity_id,
        entity_type: normalized.schema,
      },
      current,
      normalized.profile
    );
  }
  if (!current) {
    const tombstone =
      getTombstone(
        db,
        normalized.schema,
        configKey(normalized.schema, normalized.entity_id, normalized.profile)
      ) ||
      getTombstone(
        db,
        normalized.schema,
        configKey(normalized.schema, normalized.entity_id, "*")
      );
    if (tombstone) {
      return rejectDeletedConfigChange(
        db,
        {
          ...operation,
          entity_id: normalized.entity_id,
          entity_type: normalized.schema,
        },
        null,
        normalized.profile
      );
    }
  }
  const nextVersion = current ? Number(current.version || 0) + 1 : 1;
  db.prepare(
    `
INSERT INTO config_entities(schema, entity_id, profile, projection_fields_json, dto_version, safe_projection_json, checksum, operation_id, device_id, version, deleted, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(schema, entity_id, profile) DO UPDATE SET
  projection_fields_json = excluded.projection_fields_json,
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
    normalized.profile,
    safeJsonStringify(normalized.projection_fields || []),
    normalized.dto_version,
    normalized.safe_projection_json,
    normalized.checksum,
    operation.operation_id,
    operation.device_id || null,
    nextVersion
  );

  const derivedTopics =
    normalized.profile === "runtime"
      ? deriveTopicsFromConfigDto(
          db,
          normalized,
          operation,
          "runtime_config_topics"
        )
      : 0;

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
      profile: normalized.profile,
      projection_fields: normalized.projection_fields,
      deleted_fields: normalized.deleted_fields,
      safe_projection_json: normalized.dto,
      checksum: normalized.checksum,
      derived_topics: derivedTopics,
    },
  });
  return {
    ok: true,
    seq,
    version: nextVersion,
    checksum: normalized.checksum,
    derived_topics: derivedTopics,
  };
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
