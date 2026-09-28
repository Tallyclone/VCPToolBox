const assert = require("assert");
const Database = require("better-sqlite3");
const { runMigrations } = require("../core/migrations");
const { processOperation } = require("../core/operationProcessor");
const { getChanges, getLatestSeq } = require("../core/changeLog");
const { ensureItem, getItemDeletion } = require("../core/itemService");

function topicOperation(operationId, itemId, topicId, action = "upsert") {
  return {
    operation_id: operationId,
    device_id: "topic-lifecycle-device",
    entity_type: "topic",
    entity_id: topicId,
    item_type: "group",
    item_id: itemId,
    topic_id: topicId,
    action,
    payload: { topic: { id: topicId, name: operationId } },
  };
}

function itemDelete(operationId, itemId) {
  return {
    operation_id: operationId,
    device_id: "topic-lifecycle-device",
    entity_type: "item",
    entity_id: itemId,
    item_type: "group",
    item_id: itemId,
    action: "delete",
  };
}

function assertDeleteWins(db, operation, reason) {
  const beforeSeq = getLatestSeq(db);
  const beforeOrderCount = db
    .prepare("SELECT COUNT(*) AS count FROM topic_order_versions")
    .get().count;
  const result = processOperation(db, operation);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.conflict, true);
  assert.strictEqual(result.deleted, true);
  assert.strictEqual(result.resolution, "delete_wins");
  assert.strictEqual(result.reason, reason);

  const events = getChanges(db, beforeSeq);
  assert.strictEqual(events.length, 1);
  const event = events[0];
  assert.strictEqual(event.entity_type, "topic");
  assert.strictEqual(event.action, `${operation.action}_rejected_deleted`);
  assert.strictEqual(event.item_type, operation.item_type);
  assert.strictEqual(event.item_id, operation.item_id);
  assert.strictEqual(event.topic_id, operation.topic_id);
  assert.strictEqual(event.entity_id, operation.entity_id);
  assert.strictEqual(event.payload.reason, reason);
  assert.strictEqual(event.payload.deleted, true);
  assert.strictEqual(event.payload.conflict, true);
  assert.strictEqual(event.payload.resolution, "delete_wins");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM topic_order_versions").get().count,
    beforeOrderCount
  );

  const retry = processOperation(db, operation);
  assert.strictEqual(retry.idempotent, true);
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(retry.conflict, true);
  assert.strictEqual(retry.deleted, true);
  assert.strictEqual(retry.resolution, "delete_wins");
  assert.strictEqual(retry.reason, reason);
  assert.strictEqual(retry.seq, result.seq);
  assert.strictEqual(getLatestSeq(db), result.seq);
  assert.strictEqual(
    db
      .prepare("SELECT COUNT(*) AS count FROM conflicts WHERE operation_id = ?")
      .get(operation.operation_id).count,
    1
  );
}

function main() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, { info() {} });
  try {
    const created = processOperation(
      db,
      topicOperation("new-group-topic", "new-group", "topic")
    );
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.version, 1);
    assert.strictEqual(
      db
        .prepare("SELECT deleted FROM items WHERE item_type = 'group' AND item_id = 'new-group'")
        .get().deleted,
      0
    );
    assert.strictEqual(getItemDeletion(db, "group", "new-group"), null);
    processOperation(
      db,
      topicOperation("rename-topic", "new-group", "topic", "update")
    );
    assert.strictEqual(
      db
        .prepare("SELECT title FROM topics WHERE item_type = 'group' AND item_id = 'new-group' AND id = 'topic'")
        .get().title,
      "rename-topic"
    );

    processOperation(
      db,
      topicOperation("delete-missing-topic", "missing-owner", "missing-topic", "delete")
    );
    assertDeleteWins(
      db,
      topicOperation("create-after-tombstone", "missing-owner", "missing-topic", "create"),
      "topic_tombstone"
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM items WHERE item_id = 'missing-owner'").get().count,
      0
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM topics WHERE item_id = 'missing-owner'").get().count,
      0
    );

    processOperation(
      db,
      topicOperation("delete-existing-topic", "new-group", "topic", "delete")
    );
    assertDeleteWins(
      db,
      topicOperation("rename-after-delete", "new-group", "topic", "update"),
      "topic_deleted"
    );
    assert.deepStrictEqual(
      db
        .prepare("SELECT title, deleted FROM topics WHERE item_type = 'group' AND item_id = 'new-group' AND id = 'topic'")
        .get(),
      { title: "rename-topic", deleted: 1 }
    );

    processOperation(db, itemDelete("delete-existing-owner", "new-group"));
    const deletedOwner = db
      .prepare("SELECT * FROM items WHERE item_type = 'group' AND item_id = 'new-group'")
      .get();
    assertDeleteWins(
      db,
      topicOperation("offline-topic-after-owner-delete", "new-group", "offline-topic"),
      "item_deleted"
    );
    assert.strictEqual(ensureItem(db, "group", "new-group"), false);
    assert.deepStrictEqual(
      db.prepare("SELECT * FROM items WHERE item_type = 'group' AND item_id = 'new-group'").get(),
      deletedOwner
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM topics WHERE id = 'offline-topic'").get().count,
      0
    );

    processOperation(db, itemDelete("delete-missing-owner", "tombstone-owner"));
    assert.strictEqual(getItemDeletion(db, "group", "tombstone-owner").reason, "item_tombstone");
    assert.strictEqual(ensureItem(db, "group", "tombstone-owner"), false);
    assertDeleteWins(
      db,
      topicOperation("offline-topic-after-owner-tombstone", "tombstone-owner", "offline-topic"),
      "item_tombstone"
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM items WHERE item_id = 'tombstone-owner'").get().count,
      0
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS count FROM topics WHERE item_id = 'tombstone-owner'").get().count,
      0
    );

    // Older message rejection events have no explicit payload.resolution.
    const messageOperation = {
      ...topicOperation("message-under-deleted-owner", "tombstone-owner", "offline-topic", "create"),
      entity_type: "message",
      entity_id: "message",
      payload: { message: { id: "message", role: "user", content: "offline" } },
    };
    const messageResult = processOperation(db, messageOperation);
    assert.strictEqual(messageResult.resolution, "delete_wins");
    const legacyPayload = JSON.parse(db.prepare(
      "SELECT payload_json FROM change_log WHERE operation_id = ?"
    ).get(messageOperation.operation_id).payload_json);
    delete legacyPayload.resolution;
    db.prepare("UPDATE change_log SET payload_json = ? WHERE operation_id = ?")
      .run(JSON.stringify(legacyPayload), messageOperation.operation_id);
    const messageRetry = processOperation(db, messageOperation);
    assert.strictEqual(messageRetry.idempotent, true);
    assert.strictEqual(messageRetry.conflict, true);
    assert.strictEqual(messageRetry.deleted, true);
    assert.strictEqual(messageRetry.resolution, "delete_wins");
    assert.strictEqual(messageRetry.seq, messageResult.seq);
    assert.deepStrictEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
  console.log("topic lifecycle smoke test passed");
}

main();
