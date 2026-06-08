const { appendChange } = require("./changeLog");

function normalizeMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

function topicTitleOf(topic, fallback) {
  return (
    topic.name ||
    topic.title ||
    topic.topic_title ||
    topic.topicTitle ||
    fallback ||
    null
  );
}

function nowExpr() {
  return "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
}

function minOrderRank(db, itemType, itemId) {
  const row = db
    .prepare(
      "SELECT MIN(order_rank) AS min_rank FROM topics WHERE item_type = ? AND item_id = ? AND deleted = 0"
    )
    .get(itemType, itemId);
  return row && row.min_rank !== null && row.min_rank !== undefined
    ? Number(row.min_rank)
    : 1000;
}

function nextFrontRank(db, itemType, itemId) {
  return minOrderRank(db, itemType, itemId) - 1000;
}

function ensureTopic(db, itemType, itemId, topicId, metadata = {}) {
  const safeMetadata = normalizeMetadata(metadata);
  const topic = {
    ...safeMetadata,
    id: String(topicId),
  };
  const title = topicTitleOf(topic, topicId);
  const orderRank = nextFrontRank(db, itemType, itemId);
  db.prepare(
    `
INSERT INTO topics(item_id, item_type, id, title, metadata_json, order_rank, deleted, content_updated_at, order_updated_at)
VALUES (?, ?, ?, ?, ?, ?, 0, ${nowExpr()}, ${nowExpr()})
ON CONFLICT(item_id, item_type, id) DO UPDATE SET
  updated_at = ${nowExpr()}
WHERE topics.deleted = 0
`
  ).run(itemId, itemType, topicId, title, JSON.stringify(topic), orderRank);
}

function normalizeTopicOperation(operation) {
  const payload = operation.payload || {};
  const rawTopic = normalizeMetadata(
    payload.topic || payload.metadata || payload
  );
  const itemType = String(
    operation.item_type ||
      payload.item_type ||
      payload.owner_type ||
      rawTopic.item_type ||
      ""
  );
  const itemId = String(
    operation.item_id ||
      payload.item_id ||
      payload.owner_id ||
      rawTopic.item_id ||
      ""
  );
  const topicId = String(
    operation.topic_id ||
      payload.topic_id ||
      payload.topicId ||
      topicIdOf(rawTopic) ||
      operation.entity_id ||
      payload.id ||
      ""
  );
  if (!itemType || !itemId || !topicId) {
    throw new Error("topic upsert requires item_type, item_id and topic_id");
  }
  const topic = {
    ...rawTopic,
    id: rawTopic.id || topicId,
  };
  if (!topic.name && topicTitleOf(topic, null))
    topic.name = topicTitleOf(topic, null);
  return { item_type: itemType, item_id: itemId, topic_id: topicId, topic };
}

function getTopicRow(db, identity) {
  return db
    .prepare(
      "SELECT * FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
    )
    .get(identity.item_type, identity.item_id, identity.topic_id);
}

function applyTopicUpsert(db, operation) {
  const identity = normalizeTopicOperation(operation);
  const current = getTopicRow(db, identity);
  if (current && Number(current.deleted || 0) === 1) {
    const error = new Error("topic upsert target is deleted");
    error.code = "TOPIC_DELETED";
    throw error;
  }
  const currentMeta = current
    ? normalizeMetadata(JSON.parse(current.metadata_json || "{}"))
    : {};
  const incoming = identity.topic;
  const incomingNameSource =
    incoming.nameSource || incoming.name_source || null;
  const currentNameSource =
    currentMeta.nameSource || currentMeta.name_source || null;

  let nextTopic = {
    ...currentMeta,
    ...incoming,
    id: currentMeta.id || incoming.id || identity.topic_id,
  };

  if (incomingNameSource === "generated") {
    if (currentNameSource === "generated" || currentNameSource === "manual") {
      // generated 标题 first-wins：已有 generated/manual 名称时，后到 generated 不覆盖。
      nextTopic.name =
        currentMeta.name ||
        currentMeta.title ||
        current?.title ||
        identity.topic_id;
      nextTopic.title =
        currentMeta.title ||
        currentMeta.name ||
        current?.title ||
        identity.topic_id;
      nextTopic.nameSource = currentNameSource;
      nextTopic.nameGeneratedAt = currentMeta.nameGeneratedAt;
      nextTopic.nameGeneratedSeq = currentMeta.nameGeneratedSeq;
      nextTopic.nameGeneratedDeviceId = currentMeta.nameGeneratedDeviceId;
    } else {
      nextTopic.nameSource = "generated";
      nextTopic.nameGeneratedAt =
        incoming.nameGeneratedAt || incoming.name_generated_at || Date.now();
      nextTopic.nameGeneratedDeviceId =
        operation.device_id || incoming.nameGeneratedDeviceId || null;
    }
  } else if (incomingNameSource === "manual") {
    nextTopic.nameSource = "manual";
  } else if (!currentNameSource && !nextTopic.nameSource) {
    nextTopic.nameSource = "default";
  }

  const nextVersion = current ? Number(current.version || 0) + 1 : 1;
  const orderRank =
    current && current.order_rank !== null && current.order_rank !== undefined
      ? Number(current.order_rank)
      : nextFrontRank(db, identity.item_type, identity.item_id);
  db.prepare(
    `
INSERT INTO topics(item_id, item_type, id, title, metadata_json, version, deleted, order_rank, content_updated_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 0, ?, ${nowExpr()}, ${nowExpr()})
ON CONFLICT(item_id, item_type, id) DO UPDATE SET
  title = excluded.title,
  metadata_json = excluded.metadata_json,
  version = excluded.version,
  content_updated_at = ${nowExpr()},
  content_device_id = ?,
  updated_at = ${nowExpr()}
WHERE topics.deleted = 0
`
  ).run(
    identity.item_id,
    identity.item_type,
    identity.topic_id,
    topicTitleOf(nextTopic, identity.topic_id),
    JSON.stringify(nextTopic),
    nextVersion,
    orderRank,
    operation.device_id || null
  );
  const seq = appendChange(db, {
    ...operation,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_type: "topic",
    entity_id: identity.topic_id,
    action: operation.action || "upsert",
    version: nextVersion,
    payload: { topic: nextTopic },
  });
  if (incomingNameSource === "generated" && !currentNameSource) {
    nextTopic = { ...nextTopic, nameGeneratedSeq: seq };
    db.prepare(
      `UPDATE topics SET metadata_json = ?, updated_at = ${nowExpr()} WHERE item_type = ? AND item_id = ? AND id = ?`
    ).run(
      JSON.stringify(nextTopic),
      identity.item_type,
      identity.item_id,
      identity.topic_id
    );
  }
  return { ok: true, seq, version: nextVersion };
}

function listActiveTopics(db, itemType, itemId) {
  return db
    .prepare(
      "SELECT * FROM topics WHERE item_type = ? AND item_id = ? AND deleted = 0 ORDER BY order_rank ASC, created_at ASC, id ASC"
    )
    .all(itemType, itemId);
}

function updateRanks(db, itemType, itemId, topicIds) {
  const update = db.prepare(
    `UPDATE topics SET order_rank = ?, order_updated_at = ${nowExpr()}, updated_at = ${nowExpr()} WHERE item_type = ? AND item_id = ? AND id = ?`
  );
  topicIds.forEach((topicId, index) => {
    update.run((index + 1) * 1000, itemType, itemId, topicId);
  });
}

function normalizeOrderIdentity(operation) {
  const payload = operation.payload || {};
  const itemType = String(
    operation.item_type || payload.item_type || payload.owner_type || ""
  );
  const itemId = String(
    operation.item_id ||
      payload.item_id ||
      payload.owner_id ||
      operation.entity_id ||
      ""
  );
  const topicId = String(
    operation.topic_id || payload.topic_id || payload.topicId || ""
  );
  if (!itemType || !itemId)
    throw new Error("topic_order requires item_type and item_id");
  return { item_type: itemType, item_id: itemId, topic_id: topicId };
}

function activityTimestampOf(operation) {
  const payload = operation.payload || {};
  const raw =
    payload.activity_at ||
    payload.activityAt ||
    payload.updated_at ||
    payload.updatedAt ||
    payload.timestamp ||
    Date.now();
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function upsertTopicActivityState(db, operation, identity, seq) {
  db.prepare(
    `
INSERT INTO topic_activity_state(
  item_type, item_id, topic_id, latest_seq, latest_device_id, activity_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ${nowExpr()})
ON CONFLICT(item_type, item_id, topic_id) DO UPDATE SET
  latest_seq = excluded.latest_seq,
  latest_device_id = excluded.latest_device_id,
  activity_at = excluded.activity_at,
  updated_at = ${nowExpr()}
WHERE excluded.latest_seq > topic_activity_state.latest_seq
`
  ).run(
    identity.item_type,
    identity.item_id,
    identity.topic_id,
    seq,
    operation.device_id || null,
    activityTimestampOf(operation)
  );
}

function applyTopicOrderMove(db, operation) {
  const identity = normalizeOrderIdentity(operation);
  if (!identity.topic_id) throw new Error("topic_order move requires topic_id");
  const payload = operation.payload || {};
  const mode = String(payload.mode || "move_to_front");
  const source = String(payload.source || "manual");

  if (source === "activity" && mode === "move_to_front") {
    const result = db
      .prepare(
        `UPDATE topics SET content_updated_at = ${nowExpr()}, content_device_id = ?, updated_at = ${nowExpr()}
         WHERE item_type = ? AND item_id = ? AND id = ? AND deleted = 0`
      )
      .run(
        operation.device_id || null,
        identity.item_type,
        identity.item_id,
        identity.topic_id
      );
    const applied = result.changes > 0;
    const seq = appendTopicOrderChange(db, operation, identity, applied);
    if (applied) {
      upsertTopicActivityState(db, operation, identity, seq);
    }
    return {
      ok: true,
      seq,
      skipped: result.changes === 0,
    };
  }

  const rows = listActiveTopics(db, identity.item_type, identity.item_id);
  const ids = rows
    .map((row) => row.id)
    .filter((id) => id !== identity.topic_id);
  if (!rows.some((row) => row.id === identity.topic_id)) {
    return {
      ok: true,
      seq: appendTopicOrderChange(db, operation, identity, false),
      skipped: true,
    };
  }
  if (mode === "move_before") {
    const beforeId = String(
      payload.before_topic_id || payload.beforeTopicId || ""
    );
    const index = ids.indexOf(beforeId);
    ids.splice(index >= 0 ? index : 0, 0, identity.topic_id);
  } else if (mode === "move_after") {
    const afterId = String(
      payload.after_topic_id || payload.afterTopicId || ""
    );
    const index = ids.indexOf(afterId);
    ids.splice(index >= 0 ? index + 1 : 0, 0, identity.topic_id);
  } else {
    ids.unshift(identity.topic_id);
  }
  updateRanks(db, identity.item_type, identity.item_id, ids);
  return {
    ok: true,
    seq: appendTopicOrderChange(db, operation, identity, true),
  };
}

function applyTopicOrderReplace(db, operation) {
  const identity = normalizeOrderIdentity(operation);
  const payload = operation.payload || {};
  const requested = Array.isArray(payload.topics_order)
    ? payload.topics_order
    : payload.order;
  const rows = listActiveTopics(db, identity.item_type, identity.item_id);
  const existing = new Set(rows.map((row) => row.id));
  const seen = new Set();
  const ids = [];
  for (const value of requested || []) {
    const id = String(value || "");
    if (!id || !existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  for (const row of rows) {
    if (!seen.has(row.id)) ids.push(row.id);
  }
  updateRanks(db, identity.item_type, identity.item_id, ids);
  return {
    ok: true,
    seq: appendTopicOrderChange(db, operation, identity, true),
  };
}

function appendTopicOrderChange(db, operation, identity, applied) {
  return appendChange(db, {
    ...operation,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id || null,
    entity_type: "topic_order",
    entity_id: identity.item_id,
    action: operation.action,
    version: null,
    payload: { ...(operation.payload || {}), applied },
  });
}

module.exports = {
  ensureTopic,
  applyTopicUpsert,
  applyTopicOrderMove,
  applyTopicOrderReplace,
};
