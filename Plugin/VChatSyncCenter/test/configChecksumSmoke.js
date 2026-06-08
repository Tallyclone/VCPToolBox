const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase, closeDatabase } = require("../core/db");
const {
  checksumConfigDto,
  normalizeConfigOperation,
} = require("../core/configService");
const { processOperation } = require("../core/operationProcessor");

function main() {
  const dto = {
    name: "agent",
    topics: [{ id: "topic-1", name: "Topic", createdAt: 1 }],
  };
  const checksum = checksumConfigDto({
    dto_version: 1,
    schema: "agent_config",
    entity_id: "Agents/a/config.json",
    safe_projection_json: dto,
  });

  const normalized = normalizeConfigOperation({
    operation_id: "op-1",
    device_id: "device-1",
    entity_type: "agent_config",
    entity_id: "Agents/a/config.json",
    action: "update",
    payload: {
      dto_version: 1,
      schema: "agent_config",
      entity_id: "Agents/a/config.json",
      relative_path: "Agents/a/config.json",
      safe_projection_json: dto,
      checksum,
    },
  });

  assert.strictEqual(normalized.checksum, checksum);
  assert.throws(
    () =>
      normalizeConfigOperation({
        entity_type: "agent_config",
        entity_id: "Agents/a/config.json",
        payload: {
          dto_version: 1,
          schema: "agent_config",
          entity_id: "Agents/a/config.json",
          safe_projection_json: dto,
          checksum: "bad-checksum",
        },
      }),
    /checksum mismatch/
  );

  const warehouseDto = [
    { id: "prompt-1", content: "hello" },
    { id: "prompt-2", content: "world" },
  ];
  const warehouseChecksum = checksumConfigDto({
    dto_version: 1,
    schema: "global_prompt_warehouse",
    entity_id: "global_prompt_warehouse.json",
    safe_projection_json: warehouseDto,
    projection_fields: ["$"],
  });
  const normalizedWarehouse = normalizeConfigOperation({
    operation_id: "op-warehouse",
    device_id: "device-1",
    entity_type: "global_prompt_warehouse",
    entity_id: "global_prompt_warehouse.json",
    action: "update",
    payload: {
      dto_version: 1,
      schema: "global_prompt_warehouse",
      entity_id: "global_prompt_warehouse.json",
      relative_path: "global_prompt_warehouse.json",
      projection_fields: ["$"],
      safe_projection_json: warehouseDto,
      checksum: warehouseChecksum,
    },
  });
  assert.deepStrictEqual(normalizedWarehouse.dto, warehouseDto);
  assert.strictEqual(normalizedWarehouse.checksum, warehouseChecksum);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vchat-config-op-"));
  const config = {
    dbPath: path.join(tempRoot, "center.db"),
    attachmentDir: path.join(tempRoot, "attachments"),
    backupDir: path.join(tempRoot, "backups"),
    maxLimit: 5000,
  };
  const logger = { warn() {}, info() {}, error() {} };
  const dbContext = ensureDatabase(config, logger);
  try {
    const runtimeWarehouse = [{ id: "prompt-runtime", content: "runtime" }];
    const runtimeWarehouseChecksum = checksumConfigDto({
      dto_version: 1,
      schema: "global_prompt_warehouse",
      entity_id: "global_prompt_warehouse.json",
      profile: "runtime",
      projection_fields: ["$"],
      safe_projection_json: runtimeWarehouse,
    });
    const result = processOperation(dbContext.db, {
      operation_id: "op-runtime-warehouse",
      device_id: "device-1",
      entity_type: "global_prompt_warehouse",
      entity_id: "global_prompt_warehouse.json",
      action: "update",
      payload: {
        dto_version: 1,
        schema: "global_prompt_warehouse",
        entity_id: "global_prompt_warehouse.json",
        relative_path: "global_prompt_warehouse.json",
        profile: "runtime",
        projection_fields: ["$"],
        safe_projection_json: runtimeWarehouse,
        checksum: runtimeWarehouseChecksum,
      },
    });
    assert.strictEqual(result.ok, true);
    const row = dbContext.db
      .prepare(
        "SELECT profile, safe_projection_json FROM config_entities WHERE schema = ? AND entity_id = ?"
      )
      .get("global_prompt_warehouse", "global_prompt_warehouse.json");
    assert.strictEqual(row.profile, "runtime");
    assert.deepStrictEqual(
      JSON.parse(row.safe_projection_json),
      runtimeWarehouse
    );
  } finally {
    closeDatabase(dbContext);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("config checksum smoke test passed");
}

main();
