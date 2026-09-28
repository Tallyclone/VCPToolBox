const assert = require("assert");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations } = require("../core/migrations");
const { processOperation } = require("../core/operationProcessor");

// Override for an isolated Center checkout; the default uses sibling repos.
const adapterDir =
  process.env.VCHAT_SYNC_ADAPTER_DIR ||
  path.resolve(
    __dirname,
    "../../../../VCPChat/VCPDistributedServer/Plugin/VChatSyncAdapter"
  );
const { diffConfig } = require(path.join(adapterDir, "diff/configDiffEngine"));

async function syncConfig(db, relativePath, config, previous = null) {
  const diff = await diffConfig(
    relativePath,
    config,
    { getFile() { return previous; } },
    { deviceId: "new-group-adapter-device", profile: "runtime" }
  );
  assert.strictEqual(diff.bootstrapPending, false);
  for (const operation of diff.operations) {
    const result = processOperation(db, operation);
    assert.strictEqual(result.ok, true);
    assert.notStrictEqual(result.deleted, true);
  }
  return { checksum: diff.checksum, snapshot_json: config };
}

function assertGroupCanReceiveMessages(db, itemId, topicId) {
  const parent = db
    .prepare("SELECT deleted FROM items WHERE item_type = 'group' AND item_id = ?")
    .get(itemId);
  assert.ok(parent);
  assert.strictEqual(parent.deleted, 0);
  const topic = db
    .prepare("SELECT deleted FROM topics WHERE item_type = 'group' AND item_id = ? AND id = ?")
    .get(itemId, topicId);
  assert.ok(topic);
  assert.strictEqual(topic.deleted, 0);
  const result = processOperation(db, {
    operation_id: `${itemId}-first-message`,
    device_id: "new-group-adapter-device",
    entity_type: "message",
    entity_id: "first-message",
    item_type: "group",
    item_id: itemId,
    topic_id: topicId,
    action: "create",
    payload: { message: { id: "first-message", role: "user", content: "hello" } },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.conflict, false);
  assert.strictEqual(result.version, 1);
}

async function main() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, { info() {} });
  try {
    await syncConfig(db, "AgentGroups/new-group/config.json", {
      id: "new-group",
      name: "New group",
      members: ["member-a"],
      topics: [{ id: "topic", name: "Topic", createdAt: 1 }],
    });
    assertGroupCanReceiveMessages(db, "new-group", "topic");

    const emptyGroup = {
      id: "initially-empty-group",
      name: "Initially empty group",
      members: ["member-a"],
      topics: [],
    };
    const previous = await syncConfig(
      db,
      "AgentGroups/initially-empty-group/config.json",
      emptyGroup
    );
    await syncConfig(
      db,
      "AgentGroups/initially-empty-group/config.json",
      { ...emptyGroup, topics: [{ id: "later-topic", name: "Later topic", createdAt: 2 }] },
      previous
    );
    assertGroupCanReceiveMessages(db, "initially-empty-group", "later-topic");
    assert.deepStrictEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
  console.log("new group Adapter integration smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
