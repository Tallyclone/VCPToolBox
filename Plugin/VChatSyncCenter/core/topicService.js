function normalizeMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function ensureTopic(db, itemType, itemId, topicId, metadata = {}) {
  const safeMetadata = normalizeMetadata(metadata);
  db.prepare(
    `
INSERT INTO topics(item_id, item_type, id, title, metadata_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(item_id, item_type, id) DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`
  ).run(
    itemId,
    itemType,
    topicId,
    safeMetadata.title || null,
    JSON.stringify(safeMetadata)
  );
}

module.exports = {
  ensureTopic,
};
