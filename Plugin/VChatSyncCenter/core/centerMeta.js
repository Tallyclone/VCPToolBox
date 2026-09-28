const crypto = require("crypto");

const GENERATION_KEY = "generation";

// The generation identifies one lineage of change_log sequence numbers. It is
// created once per database and rotated whenever the sequence can go
// backwards (restore from backup). Clients keep the generation next to their
// cursor: a different generation means their cursor no longer addresses this
// log and they must rebuild their baseline instead of skipping events.
function ensureCenterMetaTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS center_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
}

function newGenerationId() {
  return `gen_${crypto.randomUUID()}`;
}

function getMetaValue(db, key) {
  const row = db
    .prepare("SELECT value FROM center_meta WHERE key = ?")
    .get(key);
  return row ? row.value : null;
}

function setMetaValue(db, key, value) {
  db.prepare(
    `INSERT INTO center_meta(key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, String(value));
}

function ensureGeneration(db) {
  ensureCenterMetaTable(db);
  const existing = getMetaValue(db, GENERATION_KEY);
  if (existing) return existing;
  const generation = newGenerationId();
  setMetaValue(db, GENERATION_KEY, generation);
  return generation;
}

function getGeneration(db) {
  return ensureGeneration(db);
}

function rotateGeneration(db, detail = {}) {
  ensureCenterMetaTable(db);
  const previous = getMetaValue(db, GENERATION_KEY);
  const generation = newGenerationId();
  const transaction = db.transaction(() => {
    setMetaValue(db, GENERATION_KEY, generation);
    setMetaValue(
      db,
      "generation_history",
      JSON.stringify(
        [
          ...(JSON.parse(getMetaValue(db, "generation_history") || "[]") || []),
          {
            generation,
            previous_generation: previous,
            rotated_at: new Date().toISOString(),
            ...detail,
          },
        ].slice(-50)
      )
    );
  });
  transaction();
  return { generation, previous_generation: previous };
}

module.exports = {
  GENERATION_KEY,
  ensureCenterMetaTable,
  ensureGeneration,
  getGeneration,
  rotateGeneration,
  getMetaValue,
  setMetaValue,
};
