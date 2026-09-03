const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase, closeDatabase } = require("../core/db");
const { processOperation } = require("../core/operationProcessor");
const { checksumConfigDto } = require("../core/configService");
const { exportBaseline } = require("../core/bootstrapService");

function configPayload(schema, entityId, dto) {
  const projectionFields =
    schema === "agent_config"
      ? ["name", "systemPrompt"]
      : ["id", "name", "groupPrompt"];
  const payload = {
    dto_version: 1,
    schema,
    entity_id: entityId,
    relative_path: entityId,
    profile: "bootstrap",
    projection_fields: projectionFields,
    deleted_fields: [],
    safe_projection_json: dto,
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

function createConfig(db, schema, entityId, dto, operationId) {
  const result = processOperation(db, {
    operation_id: operationId,
    device_id: "device-test",
    entity_type: schema,
    entity_id: entityId,
    action: "create",
    payload: configPayload(schema, entityId, dto),
  });
  assert.strictEqual(result.ok, true);
}

function deleteItem(db, itemType, itemId, operationId, payload = {}) {
  const result = processOperation(db, {
    operation_id: operationId,
    device_id: "device-test",
    entity_type: "item",
    action: "delete",
    item_type: itemType,
    item_id: itemId,
    entity_id: itemId,
    payload: { delete_config: true, ...payload },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deleted, true);
}

function assertConfigDeleted(db, schema, entityId) {
  const row = db
    .prepare(
      "SELECT deleted FROM config_entities WHERE schema = ? AND entity_id = ? AND profile = 'bootstrap'"
    )
    .get(schema, entityId);
  assert.ok(row);
  assert.strictEqual(Number(row.deleted), 1);
}

function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vchat-item-delete-config-path-")
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
    const legacyAgentId = "legacy agent";
    const legacyAgentConfigId = "Agents/legacy%20agent/config.json";
    createConfig(
      dbContext.db,
      "agent_config",
      legacyAgentConfigId,
      { name: "legacy agent", systemPrompt: "prompt" },
      "legacy-agent-config-create"
    );
    deleteItem(
      dbContext.db,
      "agent",
      legacyAgentId,
      "legacy-agent-item-delete"
    );
    assertConfigDeleted(dbContext.db, "agent_config", legacyAgentConfigId);

    const legacyGroupId = "legacy-group";
    const legacyGroupConfigId = "AgentGroups/legacy-group/config.json";
    createConfig(
      dbContext.db,
      "group_config",
      legacyGroupConfigId,
      { id: legacyGroupId, name: "legacy group", groupPrompt: "prompt" },
      "legacy-group-config-create"
    );
    deleteItem(
      dbContext.db,
      "group",
      legacyGroupId,
      "legacy-group-item-delete"
    );
    assertConfigDeleted(dbContext.db, "group_config", legacyGroupConfigId);

    const explicitConfigId = "Agents/custom-mapped/config.json";
    createConfig(
      dbContext.db,
      "agent_config",
      explicitConfigId,
      { name: "mapped", systemPrompt: "prompt" },
      "mapped-config-create"
    );
    deleteItem(dbContext.db, "agent", "different-item-id", "mapped-item-delete", {
      config_entity_id: explicitConfigId,
    });
    assertConfigDeleted(dbContext.db, "agent_config", explicitConfigId);

    const exportedIds = exportBaseline(runtime, { kind: "configs" }).baseline.configs.map(
      (entry) => entry.entity_id
    );
    assert.ok(!exportedIds.includes(legacyAgentConfigId));
    assert.ok(!exportedIds.includes(legacyGroupConfigId));
    assert.ok(!exportedIds.includes(explicitConfigId));

    const configTombstones = dbContext.db
      .prepare(
        "SELECT entity_type, entity_key FROM tombstones WHERE operation_id = ? ORDER BY id"
      )
      .all("legacy-agent-item-delete");
    assert.ok(
      configTombstones.some(
        (row) =>
          row.entity_type === "agent_config" &&
          row.entity_key.includes(legacyAgentConfigId)
      )
    );
  } finally {
    closeDatabase(dbContext);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("item delete config path smoke test passed");
}

main();
