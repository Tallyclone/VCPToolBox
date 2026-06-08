const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureDatabase, closeDatabase } = require("../core/db");
const {
  applyConfigOperation,
  checksumConfigDto,
} = require("../core/configService");
const { exportBaseline } = require("../core/bootstrapService");

function configOperation({ operationId, profile, dto, projectionFields }) {
  const payload = {
    dto_version: 1,
    schema: "agent_config",
    entity_id: "Agents/a/config.json",
    relative_path: "Agents/a/config.json",
    profile,
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
  return {
    operation_id: operationId,
    device_id: "device-1",
    entity_type: payload.schema,
    entity_id: payload.entity_id,
    action: "update",
    payload,
  };
}

function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vchat-sync-center-profile-")
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

  const bootstrapDto = {
    name: "bootstrap name",
    systemPrompt: "full prompt",
    advancedSystemPrompt: {
      blocks: [{ id: "block-1", content: "full baseline" }],
      hiddenBlocks: { base: { content: "base" } },
    },
  };
  const runtimeDto = {
    name: "runtime name",
    advancedSystemPrompt: {
      hiddenBlocks: { runtime: { content: "runtime" } },
    },
  };

  applyConfigOperation(
    dbContext.db,
    configOperation({
      operationId: "op-bootstrap",
      profile: "bootstrap",
      dto: bootstrapDto,
      projectionFields: ["name", "systemPrompt", "advancedSystemPrompt"],
    })
  );
  applyConfigOperation(
    dbContext.db,
    configOperation({
      operationId: "op-runtime",
      profile: "runtime",
      dto: runtimeDto,
      projectionFields: ["name", "advancedSystemPrompt.hiddenBlocks"],
    })
  );

  const rows = dbContext.db
    .prepare(
      "SELECT schema, entity_id, profile, safe_projection_json FROM config_entities ORDER BY profile"
    )
    .all();
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(
    rows.map((row) => `${row.profile}:${row.entity_id}`),
    ["bootstrap:Agents/a/config.json", "runtime:Agents/a/config.json"]
  );

  const exported = exportBaseline(runtime, { kind: "configs" });
  assert.strictEqual(exported.baseline.configs.length, 2);
  assert.deepStrictEqual(
    exported.baseline.configs.map(
      (config) => `${config.profile}:${config.entity_id}`
    ),
    ["bootstrap:Agents/a/config.json", "runtime:Agents/a/config.json"]
  );
  assert.deepStrictEqual(
    exported.baseline.configs[0].safe_projection_json,
    bootstrapDto
  );
  assert.deepStrictEqual(
    exported.baseline.configs[1].safe_projection_json,
    runtimeDto
  );

  closeDatabase(dbContext);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("config profile isolation smoke test passed");
}

main();
