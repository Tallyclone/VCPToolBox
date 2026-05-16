function normalizeMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function ensureItem(db, itemType, itemId, metadata = {}) {
  const safeMetadata = normalizeMetadata(metadata);
  db.prepare(
    `
INSERT INTO items(item_type, item_id, title, summary, metadata_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(item_type, item_id) DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`
  ).run(
    itemType,
    itemId,
    safeMetadata.title || null,
    safeMetadata.summary || null,
    JSON.stringify(safeMetadata)
  );
}

module.exports = {
  ensureItem,
};
