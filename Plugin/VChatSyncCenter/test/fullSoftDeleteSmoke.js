const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase, closeDatabase } = require("../core/db");
const { processOperation } = require("../core/operationProcessor");
const { checksumConfigDto } = require("../core/configService");
const { exportBaseline } = require("../core/bootstrapService");

function configPayload(entityId, dto, profile = "bootstrap") {
  const projectionFields =
    profile === "bootstrap" ? ["name", "systemPrompt"] : ["name"];
  const safeProjection =
    profile === "bootstrap" ? dto : { name: dto && dto.name };
  const payload = {
    dto_version: 1,
    schema: "agent_config",
    entity_id: entityId,
    relative_path: entityId,
    profile,
    projection_fields: projectionFields,
    deleted_fields: [],
    safe_projection_json: safeProjection,
  };
  payload.checksum = checksumConfigDto({
    dto_version: payload.dto_version,
    schema: payload.schema,
    entity_id: payload.entity_id,
    profile: payload.profile,
    projection_fields: payload.projection_fields,
    deleted_fields: payload.deleted_fields,
    safe_projection_json: payload.safe_projection_json,
  });
  return payload;
}

function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vchat-full-soft-delete-")
  );
  const config = {
    dbPath: path.join(tempRoot, "center.db"),
    attachmentDir: path.join(tempRoot, "attachments"),
    backupDir: path.join(tempRoot, "backups"),
    maxLimit: 5000,
  };
  const logger = { warn() {}, info() {}, error() {} };
  const dbContext = ensureDatabase(config, logger);
  const runtime = { config, dbContext, logger };

  try {
    const agentId = "Agents/delete-me/config.json";
    const dto = { name: "delete me", systemPrompt: "baseline" };
    const createResult = processOperation(dbContext.db, {
      operation_id: "config-create",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: agentId,
      action: "create",
      payload: configPayload(agentId, dto),
    });
    assert.strictEqual(createResult.ok, true);

    const deleteResult = processOperation(dbContext.db, {
      operation_id: "config-delete",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: agentId,
      action: "delete",
      payload: { profile: "bootstrap", reason: "smoke" },
    });
    assert.strictEqual(deleteResult.ok, true);
    assert.strictEqual(deleteResult.deleted, true);

    const deletedConfig = dbContext.db
      .prepare(
        "SELECT deleted, safe_projection_json FROM config_entities WHERE schema = ? AND entity_id = ? AND profile = ?"
      )
      .get("agent_config", agentId, "bootstrap");
    assert.strictEqual(Number(deletedConfig.deleted), 1);
    assert.deepStrictEqual(JSON.parse(deletedConfig.safe_projection_json), dto);

    const tombstone = dbContext.db
      .prepare(
        "SELECT entity_type, entity_key, snapshot_json FROM tombstones WHERE operation_id = ?"
      )
      .get("config-delete");
    assert.strictEqual(tombstone.entity_type, "agent_config");
    assert.ok(tombstone.entity_key.includes(agentId));
    assert.ok(JSON.parse(tombstone.snapshot_json).safe_projection_json);

    const recreateResult = processOperation(dbContext.db, {
      operation_id: "config-recreate-after-delete",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: agentId,
      action: "update",
      payload: configPayload(agentId, {
        name: "resurrect",
        systemPrompt: "no",
      }),
    });
    assert.strictEqual(recreateResult.ok, true);
    assert.strictEqual(recreateResult.deleted, true);
    assert.strictEqual(recreateResult.resolution, "delete_wins");

    const exported = exportBaseline(runtime, { kind: "configs" });
    assert.strictEqual(exported.baseline.configs.length, 0);

    processOperation(dbContext.db, {
      operation_id: "message-create",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-soft-delete",
      topic_id: "topic-1",
      entity_id: "msg-1",
      payload: {
        item: { title: "agent" },
        topic: { title: "topic" },
        message: {
          id: "msg-1",
          item_type: "agent",
          item_id: "agent-soft-delete",
          topic_id: "topic-1",
          role: "user",
          content: "hello",
        },
      },
    });

    const topicDelete = processOperation(dbContext.db, {
      operation_id: "topic-delete",
      device_id: "device-1",
      entity_type: "topic",
      action: "delete",
      item_type: "agent",
      item_id: "agent-soft-delete",
      topic_id: "topic-1",
      entity_id: "topic-1",
    });
    assert.strictEqual(topicDelete.ok, true);
    const deletedMessage = dbContext.db
      .prepare(
        "SELECT deleted FROM messages WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?"
      )
      .get("agent", "agent-soft-delete", "topic-1", "msg-1");
    assert.strictEqual(Number(deletedMessage.deleted), 1);

    const messageRecreate = processOperation(dbContext.db, {
      operation_id: "message-recreate-after-delete",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-soft-delete",
      topic_id: "topic-1",
      entity_id: "msg-1",
      payload: {
        message: {
          id: "msg-1",
          item_type: "agent",
          item_id: "agent-soft-delete",
          topic_id: "topic-1",
          role: "user",
          content: "hello again",
        },
      },
    });
    assert.strictEqual(messageRecreate.ok, true);
    assert.strictEqual(messageRecreate.deleted, true);
    assert.strictEqual(messageRecreate.resolution, "delete_wins");

    const tombstoneOnlyConfigId = "Agents/tombstone-only/config.json";
    const tombstoneOnlyConfigDelete = processOperation(dbContext.db, {
      operation_id: "config-delete-before-create",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: tombstoneOnlyConfigId,
      action: "delete",
      payload: { reason: "delete-before-create" },
    });
    assert.strictEqual(tombstoneOnlyConfigDelete.ok, true);
    const tombstoneOnlyConfigCreate = processOperation(dbContext.db, {
      operation_id: "config-create-after-tombstone-only-delete",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: tombstoneOnlyConfigId,
      action: "create",
      payload: configPayload(
        tombstoneOnlyConfigId,
        { name: "no", systemPrompt: "no" },
        "runtime"
      ),
    });
    assert.strictEqual(tombstoneOnlyConfigCreate.ok, true);
    assert.strictEqual(tombstoneOnlyConfigCreate.deleted, true);
    assert.strictEqual(tombstoneOnlyConfigCreate.resolution, "delete_wins");

    const tombstoneOnlyMessageDelete = processOperation(dbContext.db, {
      operation_id: "message-delete-before-create",
      device_id: "device-1",
      entity_type: "message",
      action: "delete",
      item_type: "agent",
      item_id: "agent-msg-tombstone-only",
      topic_id: "topic-tombstone-only",
      entity_id: "msg-tombstone-only",
    });
    assert.strictEqual(tombstoneOnlyMessageDelete.ok, true);
    const tombstoneOnlyMessageCreate = processOperation(dbContext.db, {
      operation_id: "message-create-after-tombstone-only-delete",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-msg-tombstone-only",
      topic_id: "topic-tombstone-only",
      entity_id: "msg-tombstone-only",
      payload: {
        message: {
          id: "msg-tombstone-only",
          item_type: "agent",
          item_id: "agent-msg-tombstone-only",
          topic_id: "topic-tombstone-only",
          role: "user",
          content: "should not resurrect",
        },
      },
    });
    assert.strictEqual(tombstoneOnlyMessageCreate.ok, true);
    assert.strictEqual(tombstoneOnlyMessageCreate.deleted, true);
    assert.strictEqual(tombstoneOnlyMessageCreate.resolution, "delete_wins");

    const deletedTopicNewMessage = processOperation(dbContext.db, {
      operation_id: "message-create-under-deleted-topic",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-soft-delete",
      topic_id: "topic-1",
      entity_id: "msg-under-deleted-topic",
      payload: {
        message: {
          id: "msg-under-deleted-topic",
          item_type: "agent",
          item_id: "agent-soft-delete",
          topic_id: "topic-1",
          role: "user",
          content: "blocked by topic delete",
        },
      },
    });
    assert.strictEqual(deletedTopicNewMessage.ok, true);
    assert.strictEqual(deletedTopicNewMessage.deleted, true);
    assert.strictEqual(deletedTopicNewMessage.resolution, "delete_wins");

    processOperation(dbContext.db, {
      operation_id: "item-parent-seed-message",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-parent-delete",
      topic_id: "topic-parent-delete",
      entity_id: "msg-parent-seed",
      payload: {
        item: { title: "parent" },
        topic: { title: "parent topic" },
        message: {
          id: "msg-parent-seed",
          item_type: "agent",
          item_id: "agent-parent-delete",
          topic_id: "topic-parent-delete",
          role: "user",
          content: "seed",
        },
      },
    });
    const itemDelete = processOperation(dbContext.db, {
      operation_id: "item-delete-parent",
      device_id: "device-1",
      entity_type: "item",
      action: "delete",
      item_type: "agent",
      item_id: "agent-parent-delete",
      entity_id: "agent-parent-delete",
    });
    assert.strictEqual(itemDelete.ok, true);
    const deletedItemNewMessage = processOperation(dbContext.db, {
      operation_id: "message-create-under-deleted-item",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-parent-delete",
      topic_id: "topic-parent-delete-new",
      entity_id: "msg-under-deleted-item",
      payload: {
        message: {
          id: "msg-under-deleted-item",
          item_type: "agent",
          item_id: "agent-parent-delete",
          topic_id: "topic-parent-delete-new",
          role: "user",
          content: "blocked by item delete",
        },
      },
    });
    assert.strictEqual(deletedItemNewMessage.ok, true);
    assert.strictEqual(deletedItemNewMessage.deleted, true);
    assert.strictEqual(deletedItemNewMessage.resolution, "delete_wins");

    const multiProfileId = "Agents/multi-profile/config.json";
    for (const profile of ["bootstrap", "runtime", "manual"]) {
      const result = processOperation(dbContext.db, {
        operation_id: `config-create-${profile}`,
        device_id: "device-1",
        entity_type: "agent_config",
        entity_id: multiProfileId,
        action: "create",
        payload: configPayload(
          multiProfileId,
          { name: profile, systemPrompt: profile },
          profile
        ),
      });
      assert.strictEqual(result.ok, true);
    }
    const multiProfileDelete = processOperation(dbContext.db, {
      operation_id: "config-delete-all-profiles",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: multiProfileId,
      action: "delete",
      payload: { reason: "all-profiles" },
    });
    assert.strictEqual(multiProfileDelete.ok, true);
    const profileRows = dbContext.db
      .prepare(
        "SELECT profile, deleted FROM config_entities WHERE schema = ? AND entity_id = ? ORDER BY profile"
      )
      .all("agent_config", multiProfileId);
    assert.deepStrictEqual(
      profileRows.map((row) => [row.profile, Number(row.deleted)]),
      [
        ["bootstrap", 1],
        ["manual", 1],
        ["runtime", 1],
      ]
    );
    const multiProfileRecreate = processOperation(dbContext.db, {
      operation_id: "config-manual-create-after-all-profile-delete",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: multiProfileId,
      action: "create",
      payload: configPayload(
        multiProfileId,
        { name: "manual", systemPrompt: "no" },
        "manual"
      ),
    });
    assert.strictEqual(multiProfileRecreate.ok, true);
    assert.strictEqual(multiProfileRecreate.deleted, true);
    assert.strictEqual(multiProfileRecreate.resolution, "delete_wins");

    const mappedConfigId = "Agents/mapped/config.json";
    processOperation(dbContext.db, {
      operation_id: "mapped-item-seed-message",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "mapped-item-id",
      topic_id: "mapped-topic",
      entity_id: "mapped-msg",
      payload: {
        item: { title: "mapped" },
        topic: { title: "mapped topic" },
        message: {
          id: "mapped-msg",
          item_type: "agent",
          item_id: "mapped-item-id",
          topic_id: "mapped-topic",
          role: "user",
          content: "mapped seed",
        },
      },
    });
    const mappedConfigCreate = processOperation(dbContext.db, {
      operation_id: "mapped-config-create",
      device_id: "device-1",
      entity_type: "agent_config",
      entity_id: mappedConfigId,
      action: "create",
      payload: configPayload(mappedConfigId, {
        name: "mapped",
        systemPrompt: "mapped",
      }),
    });
    assert.strictEqual(mappedConfigCreate.ok, true);
    const mappedItemDelete = processOperation(dbContext.db, {
      operation_id: "mapped-item-delete",
      device_id: "device-1",
      entity_type: "item",
      action: "delete",
      item_type: "agent",
      item_id: "mapped-item-id",
      entity_id: "mapped-item-id",
      payload: { config_entity_id: mappedConfigId },
    });
    assert.strictEqual(mappedItemDelete.ok, true);
    const mappedConfig = dbContext.db
      .prepare(
        "SELECT deleted FROM config_entities WHERE schema = ? AND entity_id = ? AND profile = ?"
      )
      .get("agent_config", mappedConfigId, "bootstrap");
    assert.strictEqual(Number(mappedConfig.deleted), 1);

    const messageDeleteTombstone = dbContext.db
      .prepare(
        "SELECT retain_until FROM tombstones WHERE operation_id = ? AND entity_type = ?"
      )
      .get("message-delete-before-create", "message");
    assert.strictEqual(messageDeleteTombstone.retain_until, null);

    const topicCascadeChange = dbContext.db
      .prepare(
        "SELECT action FROM change_log WHERE operation_id = ? AND entity_type = ? AND entity_id = ?"
      )
      .get(
        "topic-delete.cascade.message.agent:agent-soft-delete:topic-1:msg-1",
        "message",
        "msg-1"
      );
    assert.strictEqual(topicCascadeChange.action, "delete");

    const itemCascadeTopicChange = dbContext.db
      .prepare(
        "SELECT action FROM change_log WHERE operation_id = ? AND entity_type = ? AND entity_id = ?"
      )
      .get(
        "item-delete-parent.cascade.topic.agent:agent-parent-delete:topic-parent-delete",
        "topic",
        "topic-parent-delete"
      );
    assert.strictEqual(itemCascadeTopicChange.action, "delete");

    const itemCascadeMessageChange = dbContext.db
      .prepare(
        "SELECT action FROM change_log WHERE operation_id = ? AND entity_type = ? AND entity_id = ?"
      )
      .get(
        "item-delete-parent.cascade.message.agent:agent-parent-delete:topic-parent-delete:msg-parent-seed",
        "message",
        "msg-parent-seed"
      );
    assert.strictEqual(itemCascadeMessageChange.action, "delete");

    const mappedConfigCascadeChange = dbContext.db
      .prepare(
        "SELECT action FROM change_log WHERE operation_id = ? AND entity_type = ? AND entity_id = ?"
      )
      .get(
        `mapped-item-delete.cascade.agent_config.agent_config:${mappedConfigId}:bootstrap`,
        "agent_config",
        mappedConfigId
      );
    assert.strictEqual(mappedConfigCascadeChange.action, "delete");

    const tombstoneOnlyTopicDelete = processOperation(dbContext.db, {
      operation_id: "topic-delete-before-create",
      device_id: "device-1",
      entity_type: "topic",
      action: "delete",
      item_type: "agent",
      item_id: "agent-topic-tombstone-only",
      topic_id: "topic-tombstone-parent-only",
      entity_id: "topic-tombstone-parent-only",
    });
    assert.strictEqual(tombstoneOnlyTopicDelete.ok, true);
    const createUnderTombstoneOnlyTopic = processOperation(dbContext.db, {
      operation_id: "message-create-after-topic-tombstone-only-delete",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-topic-tombstone-only",
      topic_id: "topic-tombstone-parent-only",
      entity_id: "msg-blocked-by-topic-tombstone",
      payload: {
        message: {
          id: "msg-blocked-by-topic-tombstone",
          item_type: "agent",
          item_id: "agent-topic-tombstone-only",
          topic_id: "topic-tombstone-parent-only",
          role: "user",
          content: "blocked by topic tombstone",
        },
      },
    });
    assert.strictEqual(createUnderTombstoneOnlyTopic.ok, true);
    assert.strictEqual(createUnderTombstoneOnlyTopic.deleted, true);
    assert.strictEqual(createUnderTombstoneOnlyTopic.resolution, "delete_wins");

    const tombstoneOnlyItemDelete = processOperation(dbContext.db, {
      operation_id: "item-delete-before-create",
      device_id: "device-1",
      entity_type: "item",
      action: "delete",
      item_type: "agent",
      item_id: "agent-item-tombstone-only",
      entity_id: "agent-item-tombstone-only",
    });
    assert.strictEqual(tombstoneOnlyItemDelete.ok, true);
    const createUnderTombstoneOnlyItem = processOperation(dbContext.db, {
      operation_id: "message-create-after-item-tombstone-only-delete",
      device_id: "device-1",
      entity_type: "message",
      action: "create",
      item_type: "agent",
      item_id: "agent-item-tombstone-only",
      topic_id: "topic-under-item-tombstone-only",
      entity_id: "msg-blocked-by-item-tombstone",
      payload: {
        message: {
          id: "msg-blocked-by-item-tombstone",
          item_type: "agent",
          item_id: "agent-item-tombstone-only",
          topic_id: "topic-under-item-tombstone-only",
          role: "user",
          content: "blocked by item tombstone",
        },
      },
    });
    assert.strictEqual(createUnderTombstoneOnlyItem.ok, true);
    assert.strictEqual(createUnderTombstoneOnlyItem.deleted, true);
    assert.strictEqual(createUnderTombstoneOnlyItem.resolution, "delete_wins");
  } finally {
    closeDatabase(dbContext);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("full soft delete smoke test passed");
}

main();
