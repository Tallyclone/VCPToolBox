const assert = require("assert");
const Database = require("better-sqlite3");
const { runMigrations } = require("../core/migrations");
const { processOperation } = require("../core/operationProcessor");
const { getChanges, getLatestSeq } = require("../core/changeLog");

function message(operationId, itemId, topicId, messageId, action = "update") {
  return {
    operation_id: operationId,
    device_id: "message-delete-wins-device",
    entity_type: "message",
    entity_id: messageId,
    item_type: "agent",
    item_id: itemId,
    topic_id: topicId,
    action,
    base_version: 1,
    payload: { message: { id: messageId, role: "user", content: operationId } },
  };
}

function topic(operationId, itemId, topicId, action = "upsert") {
  return {
    ...message(operationId, itemId, topicId, topicId, action),
    entity_type: "topic",
    payload: { topic: { id: topicId, name: topicId } },
  };
}

function assertTerminalUpdate(db, operation, reason) {
  const beforeSeq = getLatestSeq(db);
  const result = processOperation(db, operation);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deleted, true);
  assert.strictEqual(result.conflict, true);
  assert.strictEqual(result.resolution, "delete_wins");
  assert.strictEqual(result.reason, reason);
  const events = getChanges(db, beforeSeq);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].action, "update_rejected_deleted");
  assert.strictEqual(events[0].item_id, operation.item_id);
  assert.strictEqual(events[0].topic_id, operation.topic_id);
  assert.strictEqual(events[0].entity_id, operation.entity_id);

  // Losing the HTTP acknowledgement must not turn the retry into a success.
  const retry = processOperation(db, operation);
  assert.strictEqual(retry.idempotent, true);
  for (const key of ["ok", "deleted", "conflict", "resolution", "reason", "seq", "version"]) {
    assert.strictEqual(retry[key], result[key], key);
  }
  assert.strictEqual(getLatestSeq(db), result.seq);
  assert.strictEqual(db.prepare(
    "SELECT COUNT(*) AS count FROM conflicts WHERE operation_id = ?"
  ).get(operation.operation_id).count, 1);
}

function main() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, { info() {} });
  try {
    processOperation(db, topic("seed-active-topic", "active", "topic"));
    processOperation(db, message("create-message", "active", "topic", "message", "create"));
    const update = processOperation(db, message("valid-update", "active", "topic", "message"));
    assert.strictEqual(update.conflict, false);
    assert.strictEqual(update.version, 2);
    processOperation(db, message("delete-message", "active", "topic", "message", "delete"));
    assertTerminalUpdate(db, message("edit-deleted-message", "active", "topic", "message"), "message_deleted");

    processOperation(db, topic("seed-deleted-topic", "topic-owner", "topic"));
    processOperation(db, message("seed-topic-message", "topic-owner", "topic", "message", "create"));
    processOperation(db, topic("delete-topic", "topic-owner", "topic", "delete"));
    assertTerminalUpdate(db, message("edit-under-deleted-topic", "topic-owner", "topic", "message"), "message_deleted");
    assertTerminalUpdate(db, message("missing-message-under-deleted-topic", "topic-owner", "topic", "missing"), "topic_deleted");

    processOperation(db, topic("delete-unknown-topic", "unknown-owner", "unknown-topic", "delete"));
    assertTerminalUpdate(db, message("edit-under-topic-tombstone", "unknown-owner", "unknown-topic", "missing"), "topic_deleted");
    processOperation(db, message("delete-unknown-message", "unknown-owner", "other-topic", "missing", "delete"));
    assertTerminalUpdate(db, message("edit-message-tombstone", "unknown-owner", "other-topic", "missing"), "message_tombstone");

    processOperation(db, {
      operation_id: "delete-unknown-item",
      device_id: "message-delete-wins-device",
      entity_type: "item",
      entity_id: "deleted-owner",
      item_type: "agent",
      item_id: "deleted-owner",
      action: "delete",
    });
    assertTerminalUpdate(db, message("edit-under-item-tombstone", "deleted-owner", "topic", "missing"), "item_deleted");

    const beforeErrors = getLatestSeq(db);
    assert.throws(
      () => processOperation(db, message("missing-parent", "never-created", "topic", "message")),
      (error) => error.code === "MESSAGE_TOPIC_MISSING"
    );
    assert.throws(
      () => processOperation(db, message("missing-target", "active", "topic", "never-created")),
      (error) => error.code === "MESSAGE_UPDATE_TARGET_MISSING"
    );
    assert.strictEqual(getLatestSeq(db), beforeErrors);
    assert.deepStrictEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
  console.log("message update delete-wins smoke test passed");
}

main();
