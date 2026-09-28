const { getTombstone, itemKey } = require("./deleteService");

function normalizeMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function getItemDeletion(db, itemType, itemId) {
  const entityKey = itemKey(itemType, itemId);
  const current = db
    .prepare(
      "SELECT deleted, deleted_at, version FROM items WHERE item_type = ? AND item_id = ?"
    )
    .get(itemType, itemId);
  if (current && Number(current.deleted || 0) === 1) {
    return {
      entity_type: "item",
      entity_key: entityKey,
      reason: "item_deleted",
      deleted_at: current.deleted_at,
      version: Number(current.version || 0),
    };
  }
  const tombstone = getTombstone(db, "item", entityKey);
  if (!tombstone) return null;
  return {
    entity_type: "item",
    entity_key: entityKey,
    reason: "item_tombstone",
    deleted_at: tombstone.deleted_at,
    version: tombstone.base_version,
  };
}

function ensureItem(db, itemType, itemId, metadata = {}) {
  if (getItemDeletion(db, itemType, itemId)) return false;
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
  return true;
}

module.exports = {
  ensureItem,
  getItemDeletion,
};
