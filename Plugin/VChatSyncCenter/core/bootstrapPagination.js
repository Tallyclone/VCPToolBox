const PAGES = {
  messages: { table: "messages", keys: ["item_type", "item_id", "topic_id", "id"], filter: "deleted = 0" },
  topics: { table: "topics", keys: ["item_type", "item_id", "id"], filter: "deleted = 0" },
  configs: { table: "config_entities", keys: ["schema", "entity_id", "profile"], filter: "deleted = 0 AND profile IN ('bootstrap', 'runtime')" },
  attachments: { table: "attachments", keys: ["hash"], filter: "1 = 1" },
  message_attachments: { table: "message_attachments", keys: ["item_type", "item_id", "topic_id", "message_id", "attachment_hash"], filter: "1 = 1" },
  avatars: { table: "avatars", keys: ["owner_type", "owner_id"], filter: "deleted = 0" },
  themes: { table: "theme_packages", keys: ["theme_id"], filter: "deleted = 0" },
};

function parseBootstrapCursor(value, kind, latestSeq) {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") {
    return { raw: null, kind, key: null, baseline_seq: latestSeq };
  }
  let cursor;
  try {
    const raw = String(value);
    if (!raw.startsWith("v1.")) throw new Error("invalid cursor version");
    cursor = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf8"));
    const page = PAGES[kind];
    if (!page || cursor.kind !== kind || !Array.isArray(cursor.key) ||
        cursor.key.length !== page.keys.length || cursor.key.some((part) => typeof part !== "string") ||
        !Number.isSafeInteger(cursor.baseline_seq) || cursor.baseline_seq < 0 || cursor.baseline_seq > latestSeq) {
      throw new Error("invalid cursor contents");
    }
  } catch (_) {
    throw new Error("invalid bootstrap cursor; restart the baseline export");
  }
  return { ...cursor, raw: String(value) };
}

function loadBootstrapPage(db, kind, cursor, limit) {
  const page = PAGES[kind];
  if (!page) throw new Error(`unsupported bootstrap kind: ${kind}`);
  const key = cursor.kind === kind ? cursor.key : null;
  const columns = page.keys.join(", ");
  const after = key ? ` AND (${columns}) > (${key.map(() => "?").join(", ")})` : "";
  // Only immutable primary keys participate in pagination. A delete or reorder
  // between requests cannot shift an unchanged row past an OFFSET boundary.
  return db.prepare(
    `SELECT * FROM ${page.table} WHERE ${page.filter}${after} ORDER BY ${columns} LIMIT ?`
  ).all(...(key || []), limit + 1);
}

function buildPageInfo(kind, cursor, limit, rows) {
  const hasMore = rows.length > limit;
  const last = hasMore ? rows[limit - 1] : null;
  const next = last ? {
    kind,
    key: PAGES[kind].keys.map((column) => String(last[column])),
    baseline_seq: cursor.baseline_seq,
  } : null;
  return {
    kind,
    cursor: cursor.kind === kind ? cursor.raw : null,
    limit,
    has_more: hasMore,
    next_cursor: next ? `v1.${Buffer.from(JSON.stringify(next)).toString("base64url")}` : null,
  };
}

module.exports = { PAGES, parseBootstrapCursor, loadBootstrapPage, buildPageInfo };
