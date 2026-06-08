const { appendChange } = require("./changeLog");
const { recordConflict } = require("./conflictService");
const {
  safeJsonParse,
  safeJsonStringify,
  stableJsonStringify,
} = require("../utils/safeJson");
const { sha256 } = require("../utils/checksum");

function nowIso() {
  return new Date().toISOString();
}

function configKey(schema, entityId, profile = "bootstrap") {
  return `${schema}:${entityId}:${profile || "bootstrap"}`;
}

function configRelativePath(schema, entityId) {
  const value = String(entityId || "");
  if (!value) return value;
  if (value.includes("/") || /\.json$/i.test(value)) return value;
  if (schema === "agent_config")
    return `Agents/${encodeURIComponent(value)}/config.json`;
  if (schema === "group_config")
    return `AgentGroups/${encodeURIComponent(value)}/config.json`;
  return value;
}

function itemKey(itemType, itemId) {
  return `${itemType}:${itemId}`;
}

function topicKey(itemType, itemId, topicId) {
  return `${itemType}:${itemId}:${topicId}`;
}

function groupMemberKey(groupId, memberId) {
  return `group:${groupId}:member:${memberId}`;
}

function checksumConfigSnapshot(value) {
  return sha256(stableJsonStringify(value || {}));
}

function rowSnapshot(row) {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === "string" && /_json$/.test(key)) {
        return [key, safeJsonParse(value, value)];
      }
      return [key, value];
    })
  );
}

function insertTombstone(db, input) {
  db.prepare(
    `
INSERT INTO tombstones(operation_id, device_id, entity_type, entity_key, reason, payload_json, deleted_at, retain_until, snapshot_json, base_version)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
  ).run(
    input.operation_id,
    input.device_id || null,
    input.entity_type,
    input.entity_key,
    input.reason || "delete",
    safeJsonStringify(input.payload || {}),
    input.deleted_at,
    input.retain_until || null,
    safeJsonStringify(input.snapshot || null),
    input.base_version === undefined ? null : input.base_version
  );
}

function getTombstone(db, entityType, entityKey) {
  return db
    .prepare(
      "SELECT * FROM tombstones WHERE entity_type = ? AND entity_key = ? ORDER BY id DESC LIMIT 1"
    )
    .get(entityType, entityKey);
}

function rejectDeletedConfigChange(db, operation, current, profile) {
  const entityKey = configKey(
    operation.entity_type,
    operation.entity_id,
    profile
  );
  recordConflict(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: operation.entity_type,
    entity_key: entityKey,
    base_version: operation.base_version,
    incoming: operation.payload || {},
    current: rowSnapshot(current),
    resolution: "delete_wins",
  });
  const seq = appendChange(db, {
    ...operation,
    entity_type: operation.entity_type,
    entity_id: operation.entity_id,
    action: `${operation.action}_rejected_deleted`,
    version: current ? Number(current.version || 0) : null,
    payload: {
      deleted: true,
      conflict: true,
      profile,
      reason: "delete_wins",
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

function applyConfigDelete(db, operation) {
  const payload = operation.payload || {};
  const schema = String(operation.entity_type || payload.schema || "");
  const entityId = String(
    operation.entity_id || payload.entity_id || payload.relative_path || ""
  );
  const scopedProfile = payload.profile || operation.profile || null;
  const deleteAllProfiles =
    payload.delete_all_profiles !== false && !scopedProfile;
  if (!schema || !entityId)
    throw new Error("config delete requires schema and entity_id");

  const rows = deleteAllProfiles
    ? db
        .prepare(
          "SELECT * FROM config_entities WHERE schema = ? AND entity_id = ?"
        )
        .all(schema, entityId)
    : [
        db
          .prepare(
            "SELECT * FROM config_entities WHERE schema = ? AND entity_id = ? AND profile = ?"
          )
          .get(schema, entityId, scopedProfile || "bootstrap"),
      ].filter(Boolean);
  const profiles = rows.length
    ? rows.map((row) => row.profile || "bootstrap")
    : [scopedProfile || "bootstrap"];
  const relativePath =
    payload.relative_path || configRelativePath(schema, entityId);
  const deletedAt = payload.deleted_at || nowIso();

  for (const row of rows) {
    const nextVersion = Number(row.version || 0) + 1;
    db.prepare(
      `
UPDATE config_entities
SET deleted = 1, deleted_at = ?, operation_id = ?, device_id = ?, version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE schema = ? AND entity_id = ? AND profile = ?
`
    ).run(
      deletedAt,
      operation.operation_id,
      operation.device_id || null,
      nextVersion,
      schema,
      entityId,
      row.profile || "bootstrap"
    );
  }

  const tombstoneProfiles = deleteAllProfiles
    ? Array.from(new Set([...profiles, "*"]))
    : profiles;
  for (const profile of tombstoneProfiles) {
    const current = rows.find(
      (row) => (row.profile || "bootstrap") === profile
    );
    insertTombstone(db, {
      operation_id: operation.operation_id,
      device_id: operation.device_id,
      entity_type: schema,
      entity_key: configKey(schema, entityId, profile),
      reason: payload.reason || "delete",
      payload: {
        ...payload,
        profile,
        schema,
        entity_id: entityId,
        relative_path: relativePath,
        delete_all_profiles: deleteAllProfiles,
      },
      deleted_at: deletedAt,
      retain_until: payload.retain_until || null,
      snapshot: rowSnapshot(current),
      base_version: current ? Number(current.version || 0) : null,
    });
  }

  const maxVersion = rows.reduce(
    (max, row) => Math.max(max, Number(row.version || 0) + 1),
    1
  );
  const seq = appendChange(db, {
    ...operation,
    entity_type: schema,
    entity_id: entityId,
    action: "delete",
    version: maxVersion,
    payload: {
      deleted_at: deletedAt,
      existed: rows.length > 0,
      profiles,
      profile: deleteAllProfiles ? undefined : profiles[0],
      delete_all_profiles: deleteAllProfiles,
      schema,
      entity_id: entityId,
      relative_path: relativePath,
      snapshots: rows.map(rowSnapshot),
    },
  });
  return {
    ok: true,
    seq,
    deleted: true,
    existed: rows.length > 0,
    version: maxVersion,
    profiles,
  };
}

function applyTopicDelete(db, operation) {
  const payload = operation.payload || {};
  const itemType = String(operation.item_type || payload.item_type || "");
  const itemId = String(operation.item_id || payload.item_id || "");
  const topicId = String(
    operation.topic_id ||
      operation.entity_id ||
      payload.topic_id ||
      payload.id ||
      ""
  );
  if (!itemType || !itemId || !topicId)
    throw new Error("topic delete requires item_type, item_id and topic_id");

  const current = db
    .prepare(
      "SELECT * FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
    )
    .get(itemType, itemId, topicId);
  const deletedAt = payload.deleted_at || nowIso();
  const entityKey = topicKey(itemType, itemId, topicId);
  const cascadeMessages = db
    .prepare(
      "SELECT * FROM messages WHERE item_type = ? AND item_id = ? AND topic_id = ? AND deleted = 0"
    )
    .all(itemType, itemId, topicId);

  if (current) {
    db.prepare(
      `UPDATE topics SET deleted = 1, deleted_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_type = ? AND item_id = ? AND id = ?`
    ).run(deletedAt, itemType, itemId, topicId);
  }
  db.prepare(
    `UPDATE messages SET deleted = 1, deleted_at = COALESCE(deleted_at, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_type = ? AND item_id = ? AND topic_id = ? AND deleted = 0`
  ).run(deletedAt, itemType, itemId, topicId);

  insertTombstone(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: "topic",
    entity_key: entityKey,
    reason: payload.reason || "delete",
    payload: {
      ...payload,
      item_type: itemType,
      item_id: itemId,
      topic_id: topicId,
    },
    deleted_at: deletedAt,
    snapshot: rowSnapshot(current),
    base_version: current ? Number(current.version || 0) : null,
  });

  const seq = appendChange(db, {
    ...operation,
    item_type: itemType,
    item_id: itemId,
    topic_id: topicId,
    entity_type: "topic",
    entity_id: topicId,
    action: "delete",
    version: current ? Number(current.version || 0) : null,
    payload: {
      deleted_at: deletedAt,
      existed: !!current,
      cascade: {
        messages_deleted: cascadeMessages.length,
      },
      snapshot: rowSnapshot(current),
    },
  });

  for (const messageRow of cascadeMessages) {
    appendCascadeDeleteChange(db, operation, {
      item_type: itemType,
      item_id: itemId,
      topic_id: topicId,
      entity_type: "message",
      entity_id: messageRow.id,
      entity_key: `${itemType}:${itemId}:${topicId}:${messageRow.id}`,
      version: Number(messageRow.version || 0),
      deleted_at: deletedAt,
      cascaded_from: "topic",
      parent_entity_type: "topic",
      parent_entity_id: topicId,
      snapshot: rowSnapshot(messageRow),
    });
  }

  return { ok: true, seq, deleted: true, existed: !!current };
}

function applyTopicHistoryDelete(db, operation) {
  const payload = operation.payload || {};
  const itemType = String(operation.item_type || payload.item_type || "");
  const itemId = String(operation.item_id || payload.item_id || "");
  const topicId = String(
    operation.topic_id ||
      operation.entity_id ||
      payload.topic_id ||
      payload.id ||
      ""
  );
  if (!itemType || !itemId || !topicId) {
    throw new Error(
      "topic_history delete requires item_type, item_id and topic_id"
    );
  }

  const deletedAt = payload.deleted_at || nowIso();
  const entityKey = `history:${topicKey(itemType, itemId, topicId)}`;
  const currentTopic = db
    .prepare(
      "SELECT * FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
    )
    .get(itemType, itemId, topicId);
  const cascadeMessages = db
    .prepare(
      "SELECT * FROM messages WHERE item_type = ? AND item_id = ? AND topic_id = ? AND deleted = 0"
    )
    .all(itemType, itemId, topicId);

  db.prepare(
    `UPDATE messages SET deleted = 1, deleted_at = COALESCE(deleted_at, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_type = ? AND item_id = ? AND topic_id = ? AND deleted = 0`
  ).run(deletedAt, itemType, itemId, topicId);

  insertTombstone(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: "topic_history",
    entity_key: entityKey,
    reason: payload.reason || "clear_history",
    payload: {
      ...payload,
      item_type: itemType,
      item_id: itemId,
      topic_id: topicId,
    },
    deleted_at: deletedAt,
    snapshot: {
      topic: rowSnapshot(currentTopic),
      messages: cascadeMessages.map(rowSnapshot),
    },
    base_version: null,
  });

  const seq = appendChange(db, {
    ...operation,
    item_type: itemType,
    item_id: itemId,
    topic_id: topicId,
    entity_type: "topic_history",
    entity_id: topicId,
    action: "delete",
    version: null,
    payload: {
      deleted_at: deletedAt,
      existed: cascadeMessages.length > 0,
      cascade: {
        messages_deleted: cascadeMessages.length,
      },
      topic_preserved: true,
      snapshot: {
        topic: rowSnapshot(currentTopic),
      },
    },
  });

  for (const messageRow of cascadeMessages) {
    appendCascadeDeleteChange(db, operation, {
      item_type: itemType,
      item_id: itemId,
      topic_id: topicId,
      entity_type: "message",
      entity_id: messageRow.id,
      entity_key: `${itemType}:${itemId}:${topicId}:${messageRow.id}`,
      version: Number(messageRow.version || 0),
      deleted_at: deletedAt,
      cascaded_from: "topic_history",
      parent_entity_type: "topic_history",
      parent_entity_id: topicId,
      snapshot: rowSnapshot(messageRow),
    });
  }

  return {
    ok: true,
    seq,
    deleted: true,
    existed: cascadeMessages.length > 0,
  };
}

function configSchemaForItemType(itemType) {
  if (itemType === "agent") return "agent_config";
  if (itemType === "group") return "group_config";
  return null;
}

function cascadeOperationId(operationId, entityType, entityKey) {
  return `${operationId}.cascade.${entityType}.${entityKey}`;
}

function appendCascadeDeleteChange(db, operation, input) {
  return appendChange(db, {
    operation_id: cascadeOperationId(
      operation.operation_id,
      input.entity_type,
      input.entity_key || input.entity_id
    ),
    device_id: operation.device_id || null,
    item_type: input.item_type || null,
    item_id: input.item_id || null,
    topic_id: input.topic_id || null,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    action: "delete",
    version: input.version === undefined ? null : input.version,
    payload: {
      ...(input.payload || {}),
      relative_path:
        input.relative_path ||
        ((input.payload || {}).schema
          ? configRelativePath(
              (input.payload || {}).schema,
              input.entity_id || (input.payload || {}).entity_id
            )
          : undefined),
      deleted_at: input.deleted_at,
      cascaded_from: input.cascaded_from,
      parent_entity_type: input.parent_entity_type,
      parent_entity_id: input.parent_entity_id,
      snapshot: input.snapshot || null,
    },
  });
}

function applyGroupMemberDelete(db, operation) {
  const payload = operation.payload || {};
  const groupId = String(
    operation.item_id ||
      payload.group_id ||
      payload.item_id ||
      payload.groupId ||
      ""
  );
  const memberId = String(
    operation.member_id ||
      operation.entity_id ||
      payload.member_id ||
      payload.memberId ||
      ""
  );
  if (!groupId || !memberId)
    throw new Error("group_member delete requires group_id and member_id");

  const deletedAt = payload.deleted_at || nowIso();
  const entityKey = groupMemberKey(groupId, memberId);
  const rows = db
    .prepare(
      "SELECT * FROM config_entities WHERE schema = 'group_config' AND entity_id = ? AND deleted = 0"
    )
    .all(groupId);
  let updatedConfigs = 0;
  let removedMember = false;

  const updateConfig = db.prepare(
    `UPDATE config_entities
SET safe_projection_json = ?, checksum = ?, operation_id = ?, device_id = ?, version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE schema = 'group_config' AND entity_id = ? AND profile = ?`
  );

  for (const row of rows) {
    const snapshot = safeJsonParse(row.safe_projection_json, {});
    const members = Array.isArray(snapshot.members) ? snapshot.members : null;
    if (!members || !members.map(String).includes(memberId)) continue;
    const nextSnapshot = {
      ...snapshot,
      members: members.filter((id) => String(id) !== memberId),
    };
    if (
      nextSnapshot.memberTags &&
      typeof nextSnapshot.memberTags === "object" &&
      !Array.isArray(nextSnapshot.memberTags)
    ) {
      nextSnapshot.memberTags = { ...nextSnapshot.memberTags };
      delete nextSnapshot.memberTags[memberId];
    }
    const nextVersion = Number(row.version || 0) + 1;
    const checksum = checksumConfigSnapshot({
      schema: "group_config",
      entity_id: groupId,
      profile: row.profile || "bootstrap",
      safe_projection_json: nextSnapshot,
    });
    updateConfig.run(
      safeJsonStringify(nextSnapshot),
      checksum,
      operation.operation_id,
      operation.device_id || null,
      nextVersion,
      groupId,
      row.profile || "bootstrap"
    );
    updatedConfigs += 1;
    removedMember = true;
    appendCascadeDeleteChange(db, operation, {
      entity_type: "group_config",
      entity_id: groupId,
      entity_key: configKey(
        "group_config",
        groupId,
        row.profile || "bootstrap"
      ),
      version: nextVersion,
      deleted_at: deletedAt,
      cascaded_from: "group_member",
      parent_entity_type: "group_member",
      parent_entity_id: memberId,
      payload: {
        schema: "group_config",
        entity_id: groupId,
        profile: row.profile || "bootstrap",
        removed_member_id: memberId,
      },
      snapshot: rowSnapshot(row),
    });
  }

  insertTombstone(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: "group_member",
    entity_key: entityKey,
    reason: payload.reason || "delete",
    payload: { ...payload, group_id: groupId, member_id: memberId },
    deleted_at: deletedAt,
    snapshot: rows.map(rowSnapshot),
    base_version: null,
  });

  const seq = appendChange(db, {
    ...operation,
    item_type: "group",
    item_id: groupId,
    entity_type: "group_member",
    entity_id: memberId,
    action: "delete",
    version: null,
    payload: {
      deleted_at: deletedAt,
      group_id: groupId,
      member_id: memberId,
      existed: removedMember,
      cascade: { configs_updated: updatedConfigs },
    },
  });
  return { ok: true, seq, deleted: true, existed: removedMember };
}

function applyItemDelete(db, operation) {
  const payload = operation.payload || {};
  const itemType = String(operation.item_type || payload.item_type || "");
  const itemId = String(
    operation.item_id ||
      operation.entity_id ||
      payload.item_id ||
      payload.id ||
      ""
  );
  if (!itemType || !itemId)
    throw new Error("item delete requires item_type and item_id");

  const current = db
    .prepare("SELECT * FROM items WHERE item_type = ? AND item_id = ?")
    .get(itemType, itemId);
  const deletedAt = payload.deleted_at || nowIso();
  const entityKey = itemKey(itemType, itemId);
  const cascadeTopics = db
    .prepare(
      "SELECT * FROM topics WHERE item_type = ? AND item_id = ? AND deleted = 0"
    )
    .all(itemType, itemId);
  const cascadeMessages = db
    .prepare(
      "SELECT * FROM messages WHERE item_type = ? AND item_id = ? AND deleted = 0"
    )
    .all(itemType, itemId);

  if (current) {
    db.prepare(
      `UPDATE items SET deleted = 1, deleted_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_type = ? AND item_id = ?`
    ).run(deletedAt, itemType, itemId);
  }
  db.prepare(
    `UPDATE topics SET deleted = 1, deleted_at = COALESCE(deleted_at, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_type = ? AND item_id = ? AND deleted = 0`
  ).run(deletedAt, itemType, itemId);
  db.prepare(
    `UPDATE messages SET deleted = 1, deleted_at = COALESCE(deleted_at, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_type = ? AND item_id = ? AND deleted = 0`
  ).run(deletedAt, itemType, itemId);

  const schema = configSchemaForItemType(itemType);
  let configDeleted = 0;
  const configEntityIds = Array.from(
    new Set(
      [
        itemId,
        payload.config_entity_id,
        ...(Array.isArray(payload.config_entity_ids)
          ? payload.config_entity_ids
          : []),
      ]
        .filter(Boolean)
        .map(String)
    )
  );
  if (schema && payload.delete_config !== false) {
    const selectConfigs = db.prepare(
      "SELECT * FROM config_entities WHERE schema = ? AND entity_id = ? AND deleted = 0"
    );
    const updateConfig = db.prepare(
      `UPDATE config_entities SET deleted = 1, deleted_at = COALESCE(deleted_at, ?), operation_id = ?, device_id = ?, version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE schema = ? AND entity_id = ? AND profile = ? AND deleted = 0`
    );
    for (const configEntityId of configEntityIds) {
      const configRows = selectConfigs.all(schema, configEntityId);
      for (const configRow of configRows) {
        const nextVersion = Number(configRow.version || 0) + 1;
        const info = updateConfig.run(
          deletedAt,
          operation.operation_id,
          operation.device_id || null,
          nextVersion,
          schema,
          configEntityId,
          configRow.profile || "bootstrap"
        );
        configDeleted += Number(info.changes || 0);
        appendCascadeDeleteChange(db, operation, {
          entity_type: schema,
          entity_id: configEntityId,
          entity_key: configKey(
            schema,
            configEntityId,
            configRow.profile || "bootstrap"
          ),
          version: nextVersion,
          deleted_at: deletedAt,
          cascaded_from: "item",
          parent_entity_type: "item",
          parent_entity_id: itemId,
          relative_path: configRelativePath(schema, configEntityId),
          payload: {
            schema,
            entity_id: configEntityId,
            relative_path: configRelativePath(schema, configEntityId),
            profile: configRow.profile || "bootstrap",
          },
          snapshot: rowSnapshot(configRow),
        });
        insertTombstone(db, {
          operation_id: operation.operation_id,
          device_id: operation.device_id,
          entity_type: schema,
          entity_key: configKey(
            schema,
            configEntityId,
            configRow.profile || "bootstrap"
          ),
          reason: payload.reason || "delete",
          payload: {
            ...payload,
            schema,
            entity_id: configEntityId,
            relative_path: configRelativePath(schema, configEntityId),
            profile: configRow.profile || "bootstrap",
            cascaded_from: "item",
            item_type: itemType,
            item_id: itemId,
          },
          deleted_at: deletedAt,
          retain_until: payload.retain_until || null,
          snapshot: rowSnapshot(configRow),
          base_version: Number(configRow.version || 0),
        });
      }
    }
  }

  insertTombstone(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id,
    entity_type: "item",
    entity_key: entityKey,
    reason: payload.reason || "delete",
    payload: { ...payload, item_type: itemType, item_id: itemId },
    deleted_at: deletedAt,
    snapshot: rowSnapshot(current),
    base_version: current ? Number(current.version || 0) : null,
  });

  const seq = appendChange(db, {
    ...operation,
    item_type: itemType,
    item_id: itemId,
    entity_type: "item",
    entity_id: itemId,
    action: "delete",
    version: current ? Number(current.version || 0) : null,
    payload: {
      deleted_at: deletedAt,
      existed: !!current,
      cascade: {
        topics_deleted: cascadeTopics.length,
        messages_deleted: cascadeMessages.length,
        configs_deleted: configDeleted,
      },
      snapshot: rowSnapshot(current),
    },
  });

  for (const topicRow of cascadeTopics) {
    appendCascadeDeleteChange(db, operation, {
      item_type: itemType,
      item_id: itemId,
      topic_id: topicRow.id,
      entity_type: "topic",
      entity_id: topicRow.id,
      entity_key: topicKey(itemType, itemId, topicRow.id),
      version: Number(topicRow.version || 0),
      deleted_at: deletedAt,
      cascaded_from: "item",
      parent_entity_type: "item",
      parent_entity_id: itemId,
      snapshot: rowSnapshot(topicRow),
    });
  }

  for (const messageRow of cascadeMessages) {
    appendCascadeDeleteChange(db, operation, {
      item_type: itemType,
      item_id: itemId,
      topic_id: messageRow.topic_id,
      entity_type: "message",
      entity_id: messageRow.id,
      entity_key: `${itemType}:${itemId}:${messageRow.topic_id}:${messageRow.id}`,
      version: Number(messageRow.version || 0),
      deleted_at: deletedAt,
      cascaded_from: "item",
      parent_entity_type: "item",
      parent_entity_id: itemId,
      snapshot: rowSnapshot(messageRow),
    });
  }

  return { ok: true, seq, deleted: true, existed: !!current };
}

function applyEntityDelete(db, operation) {
  if (operation.entity_type === "topic") return applyTopicDelete(db, operation);
  if (operation.entity_type === "topic_history") {
    return applyTopicHistoryDelete(db, operation);
  }
  if (operation.entity_type === "item") return applyItemDelete(db, operation);
  if (operation.entity_type === "group_member") {
    return applyGroupMemberDelete(db, operation);
  }
  throw new Error("unsupported delete entity type");
}

module.exports = {
  applyConfigDelete,
  rejectDeletedConfigChange,
  applyEntityDelete,
  rowSnapshot,
  insertTombstone,
  getTombstone,
  configKey,
  itemKey,
  topicKey,
};
