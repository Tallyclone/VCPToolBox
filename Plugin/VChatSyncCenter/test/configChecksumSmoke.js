const assert = require("assert");
const {
  checksumConfigDto,
  normalizeConfigOperation,
} = require("../core/configService");

function main() {
  const dto = {
    name: "agent",
    topics: [
      { id: "topic-1", name: "Topic", createdAt: 1 },
    ],
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

  console.log("config checksum smoke test passed");
}

main();
