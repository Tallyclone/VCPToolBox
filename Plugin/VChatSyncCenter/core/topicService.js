const { appendChange } = require("./changeLog");

const ORDER_RANK_STEP = 1000000000;

function normalizeMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function stripTopicOrderFields(topic) {
  const clean = { ...normalizeMetadata(topic) };
  delete clean.order_rank;
  delete clean.orderRank;
  delete clean.order_version;
  delete clean.orderVersion;
  delete clean.order_updated_at;
  delete clean.orderUpdatedAt;
  delete clean.order_device_id;
  delete clean.orderDeviceId;
  return clean;
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

function nextOrderVersion(db) {
  const info = db
    .prepare("INSERT INTO topic_order_versions DEFAULT VALUES")
    .run();
  return Number(info.lastInsertRowid);
}

function minOrderRank(db, itemType, itemId) {
  const row = db
    .prepare(
      "SELECT MIN(order_rank) AS min_rank FROM topics WHERE item_type = ? AND item_id = ? AND deleted = 0"
    )
    .get(itemType, itemId);
  return row && row.min_rank !== null && row.min_rank !== undefined
    ? Number(row.min_rank)
    : null;
}

function nextFrontRank(db, itemType, itemId) {
  const minRank = minOrderRank(db, itemType, itemId);
  return minRank === null ? 0 : minRank - ORDER_RANK_STEP;
}

function ensureTopic(db, itemType, itemId, topicId, metadata = {}) {
  const safeMetadata = stripTopicOrderFields(metadata);
  const topic = {
    ...safeMetadata,
    id: String(topicId),
  };
  const title = topicTitleOf(topic, topicId);
  const existing = db
    .prepare(
      "SELECT order_rank, order_version FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
    )
    .get(itemType, itemId, topicId);
  const orderRank =
    existing &&
    existing.order_rank !== null &&
    existing.order_rank !== undefined
      ? Number(existing.order_rank)
      : nextFrontRank(db, itemType, itemId);
  const orderVersion =
    existing && Number(existing.order_version || 0) > 0
      ? Number(existing.order_version)
      : nextOrderVersion(db);
  db.prepare(
    `
INSERT INTO topics(item_id, item_type, id, title, metadata_json, order_rank, order_version, deleted, content_updated_at, order_updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 0, ${nowExpr()}, ${nowExpr()})
ON CONFLICT(item_id, item_type, id) DO UPDATE SET
  updated_at = ${nowExpr()}
WHERE topics.deleted = 0
`
  ).run(
    itemId,
    itemType,
    topicId,
    title,
    JSON.stringify(topic),
    orderRank,
    orderVersion
  );
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

function applyTopicUpsert(db, operation, options = {}) {
  const identity = normalizeTopicOperation(operation);
  const current = getTopicRow(db, identity);
  if (current && Number(current.deleted || 0) === 1) {
    const error = new Error("topic upsert target is deleted");
    error.code = "TOPIC_DELETED";
    throw error;
  }
  const currentMeta = current
    ? stripTopicOrderFields(JSON.parse(current.metadata_json || "{}"))
    : {};
  const incoming = stripTopicOrderFields(identity.topic);
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
  const isNewOrder =
    !current || current.order_rank === null || current.order_rank === undefined;
  const rawIncomingTopic = normalizeMetadata(identity.topic);
  const incomingOrderRankRaw =
    rawIncomingTopic.order_rank !== undefined &&
    rawIncomingTopic.order_rank !== null
      ? rawIncomingTopic.order_rank
      : rawIncomingTopic.orderRank;
  const incomingOrderRank = Number(incomingOrderRankRaw);
  const hasTrustedInitialOrderRank =
    options.trustInitialOrderRank === true &&
    Number.isFinite(incomingOrderRank);
  const orderRank = isNewOrder
    ? hasTrustedInitialOrderRank
      ? incomingOrderRank
      : nextFrontRank(db, identity.item_type, identity.item_id)
    : Number(current.order_rank);
  const orderVersion = isNewOrder
    ? nextOrderVersion(db)
    : Number(current.order_version || 0);

  db.prepare(
    `
INSERT INTO topics(item_id, item_type, id, title, metadata_json, version, deleted, order_rank, order_version, order_updated_at, order_device_id, content_updated_at, content_device_id, updated_at)
VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ${nowExpr()}, ?, ${nowExpr()}, ?, ${nowExpr()})
ON CONFLICT(item_id, item_type, id) DO UPDATE SET
  title = excluded.title,
  metadata_json = excluded.metadata_json,
  version = excluded.version,
  order_rank = CASE WHEN topics.order_rank IS NULL THEN excluded.order_rank ELSE topics.order_rank END,
  order_version = CASE WHEN COALESCE(topics.order_version, 0) = 0 THEN excluded.order_version ELSE topics.order_version END,
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
    orderVersion,
    operation.device_id || null,
    operation.device_id || null,
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

  // 缺陷1修复: 新话题创建时自动追加 topic_order 事件，确保排序信息能广播到其他设备
  if (isNewOrder) {
    appendTopicOrderChange(db, operation, identity, true, {
      order_rank: orderRank,
      order_version: orderVersion,
      order_updated_at: new Date().toISOString(),
      source: "create",
      mode: "move_to_front",
    });
  }

  return { ok: true, seq, version: nextVersion };
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

function getActiveTopic(db, identity) {
  return db
    .prepare(
      "SELECT * FROM topics WHERE item_type = ? AND item_id = ? AND id = ? AND deleted = 0"
    )
    .get(identity.item_type, identity.item_id, identity.topic_id);
}

function rankBefore(db, identity, beforeRank) {
  return db
    .prepare(
      `SELECT id, order_rank FROM topics
       WHERE item_type = ? AND item_id = ? AND deleted = 0 AND id <> ? AND order_rank < ?
       ORDER BY order_rank DESC, id DESC LIMIT 1`
    )
    .get(identity.item_type, identity.item_id, identity.topic_id, beforeRank);
}

function rankAfter(db, identity, afterRank) {
  return db
    .prepare(
      `SELECT id, order_rank FROM topics
       WHERE item_type = ? AND item_id = ? AND deleted = 0 AND id <> ? AND order_rank > ?
       ORDER BY order_rank ASC, id ASC LIMIT 1`
    )
    .get(identity.item_type, identity.item_id, identity.topic_id, afterRank);
}

function rebalanceOwnerRanks(db, itemType, itemId) {
  const rows = db
    .prepare(
      `SELECT id FROM topics
       WHERE item_type = ? AND item_id = ? AND deleted = 0
       ORDER BY order_rank ASC, created_at ASC, id ASC`
    )
    .all(itemType, itemId);
  const orderUpdatedAt = new Date().toISOString();
  const update = db.prepare(
    `UPDATE topics SET order_rank = ?, order_version = ?, order_updated_at = ?, updated_at = ${nowExpr()}
     WHERE item_type = ? AND item_id = ? AND id = ? AND deleted = 0`
  );
  // 缺陷2修复: rebalance 后为每个受影响话题递增 order_version 并追加 topic_order change_log
  rows.forEach((row, index) => {
    const newRank = index * ORDER_RANK_STEP;
    const newVersion = nextOrderVersion(db);
    update.run(newRank, newVersion, orderUpdatedAt, itemType, itemId, row.id);
    appendTopicOrderChange(
      db,
      { device_id: null },
      { item_type: itemType, item_id: itemId, topic_id: row.id },
      true,
      {
        order_rank: newRank,
        order_version: newVersion,
        order_updated_at: orderUpdatedAt,
        source: "rebalance",
        mode: "rebalance",
      }
    );
  });
}

function midpointRank(leftRank, rightRank) {
  if (leftRank === null || leftRank === undefined)
    return Number(rightRank) - ORDER_RANK_STEP;
  if (rightRank === null || rightRank === undefined)
    return Number(leftRank) + ORDER_RANK_STEP;
  const left = Number(leftRank);
  const right = Number(rightRank);
  const mid = Math.floor((left + right) / 2);
  return mid > left && mid < right ? mid : null;
}

function rankForMoveToFront(db, identity) {
  return nextFrontRank(db, identity.item_type, identity.item_id);
}

function rankForMoveBefore(db, identity, beforeTopicId) {
  const before = getActiveTopic(db, { ...identity, topic_id: beforeTopicId });
  if (!before) throw new Error("topic_order move_before target not found");
  const previous = rankBefore(db, identity, Number(before.order_rank));
  let rank = midpointRank(
    previous ? previous.order_rank : null,
    before.order_rank
  );
  if (rank === null) {
    rebalanceOwnerRanks(db, identity.item_type, identity.item_id);
    const refreshed = getActiveTopic(db, {
      ...identity,
      topic_id: beforeTopicId,
    });
    const refreshedPrevious = rankBefore(
      db,
      identity,
      Number(refreshed.order_rank)
    );
    rank = midpointRank(
      refreshedPrevious ? refreshedPrevious.order_rank : null,
      refreshed.order_rank
    );
  }
  return rank;
}

function rankForMoveAfter(db, identity, afterTopicId) {
  const after = getActiveTopic(db, { ...identity, topic_id: afterTopicId });
  if (!after) throw new Error("topic_order move_after target not found");
  const next = rankAfter(db, identity, Number(after.order_rank));
  let rank = midpointRank(after.order_rank, next ? next.order_rank : null);
  if (rank === null) {
    rebalanceOwnerRanks(db, identity.item_type, identity.item_id);
    const refreshed = getActiveTopic(db, {
      ...identity,
      topic_id: afterTopicId,
    });
    const refreshedNext = rankAfter(db, identity, Number(refreshed.order_rank));
    rank = midpointRank(
      refreshed.order_rank,
      refreshedNext ? refreshedNext.order_rank : null
    );
  }
  return rank;
}

function appendTopicOrderChange(
  db,
  operation,
  identity,
  applied,
  orderResult = {}
) {
  let opId = operation.operation_id;
  if (!opId) {
    opId = `auto.topic_order.${identity.item_type}.${identity.item_id}.${identity.topic_id || "all"}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  } else if (operation.entity_type !== "topic_order") {
    opId = `${opId}.auto_order`;
  }

  return appendChange(db, {
    ...operation,
    operation_id: opId,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id || null,
    entity_type: "topic_order",
    entity_id: identity.item_id,
    action: "move",
    version: orderResult.order_version || null,
    payload: {
      ...(operation.payload || {}),
      applied,
      center_assigned: applied,
      ...orderResult,
    },
  });
}

function applyTopicOrderMove(db, operation) {
  const identity = normalizeOrderIdentity(operation);
  if (!identity.topic_id) throw new Error("topic_order move requires topic_id");
  const payload = operation.payload || {};
  const mode = String(payload.mode || "move_to_front");
  const source = String(payload.source || "manual");
  const current = getActiveTopic(db, identity);
  if (!current) {
    return {
      ok: true,
      seq: appendTopicOrderChange(db, operation, identity, false),
      skipped: true,
    };
  }

  let orderRank;
  if (mode === "move_before") {
    const beforeId = String(
      payload.before_topic_id || payload.beforeTopicId || ""
    );
    if (!beforeId)
      throw new Error("topic_order move_before requires before_topic_id");
    orderRank = rankForMoveBefore(db, identity, beforeId);
  } else if (mode === "move_after") {
    const afterId = String(
      payload.after_topic_id || payload.afterTopicId || ""
    );
    if (!afterId)
      throw new Error("topic_order move_after requires after_topic_id");
    orderRank = rankForMoveAfter(db, identity, afterId);
  } else {
    orderRank = rankForMoveToFront(db, identity);
  }

  const orderVersion = nextOrderVersion(db);
  const orderUpdatedAt = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE topics
       SET order_rank = ?,
           order_version = ?,
           order_updated_at = ?,
           order_device_id = ?,
           content_updated_at = CASE WHEN ? = 'activity' THEN ? ELSE content_updated_at END,
           content_device_id = CASE WHEN ? = 'activity' THEN ? ELSE content_device_id END,
           updated_at = ${nowExpr()}
       WHERE item_type = ? AND item_id = ? AND id = ? AND deleted = 0`
    )
    .run(
      orderRank,
      orderVersion,
      orderUpdatedAt,
      operation.device_id || null,
      source,
      orderUpdatedAt,
      source,
      operation.device_id || null,
      identity.item_type,
      identity.item_id,
      identity.topic_id
    );
  const applied = result.changes > 0;
  const seq = appendTopicOrderChange(db, operation, identity, applied, {
    order_rank: orderRank,
    order_version: orderVersion,
    order_updated_at: orderUpdatedAt,
    source,
    mode,
  });
  return {
    ok: true,
    seq,
    version: orderVersion,
    order_version: orderVersion,
    skipped: !applied,
  };
}

module.exports = {
  ORDER_RANK_STEP,
  ensureTopic,
  applyTopicUpsert,
  applyTopicOrderMove,
};
