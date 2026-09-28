const assert = require("assert");
const path = require("path");
const { materializeConfigSnapshot } = require("../core/configSnapshot");
const {
  validateSafeConfigDto,
  validateDeletedFields,
} = require("../core/configSchema");

const adapterDir =
  process.env.VCHAT_SYNC_ADAPTER_DIR ||
  path.resolve(__dirname, "../../../../VCPChat/VCPDistributedServer/Plugin/VChatSyncAdapter");
const { mergeProjectedConfig } = require(path.join(adapterDir, "core/configSchema"));

function patch(label, fields, dto, deleted = []) {
  return {
    label,
    dto_version: 1,
    schema: "agent_config",
    entity_id: "Agents/snapshot/config.json",
    profile: "runtime",
    projection_fields: fields,
    deleted_fields: deleted,
    safe_projection_json: dto,
  };
}

const patches = [
  patch("replace parent", ["advancedSystemPrompt"], {
    advancedSystemPrompt: { hiddenBlocks: ["one"], viewMode: "one" },
  }),
  patch("empty parent", ["advancedSystemPrompt"], { advancedSystemPrompt: {} }),
  patch("null parent", ["advancedSystemPrompt"], { advancedSystemPrompt: null }),
  patch("delete parent", ["advancedSystemPrompt"], {}, ["advancedSystemPrompt"]),
  patch("set child", ["advancedSystemPrompt.hiddenBlocks"], {
    advancedSystemPrompt: { hiddenBlocks: ["one"] },
  }),
  patch("set sibling", ["advancedSystemPrompt.viewMode"], {
    advancedSystemPrompt: { viewMode: "one" },
  }),
  patch("delete child", ["advancedSystemPrompt.hiddenBlocks"], {}, ["advancedSystemPrompt.hiddenBlocks"]),
  patch("delete sibling", ["advancedSystemPrompt.viewMode"], {}, ["advancedSystemPrompt.viewMode"]),
  patch("set name", ["name"], { name: "one" }),
  patch("absent parent", ["advancedSystemPrompt"], {}),
  patch("absent child", ["advancedSystemPrompt.hiddenBlocks"], {}),
  patch(
    "delete parent and restore child",
    ["advancedSystemPrompt", "advancedSystemPrompt.hiddenBlocks"],
    { advancedSystemPrompt: { hiddenBlocks: ["restored"] } },
    ["advancedSystemPrompt"]
  ),
  patch(
    "replace parent and delete child",
    ["advancedSystemPrompt", "advancedSystemPrompt.hiddenBlocks"],
    { advancedSystemPrompt: { hiddenBlocks: ["one"], viewMode: "one" } },
    ["advancedSystemPrompt.hiddenBlocks"]
  ),
];

function project(config, snapshot) {
  return mergeProjectedConfig(config, snapshot.safe_projection_json, snapshot);
}

// A child set followed by deletion can leave an implicit {} on a live client.
// A snapshot cannot force that container to exist without also replacing its
// unknown siblings. Only these undeclared empty ancestors are shape-equivalent;
// explicit empty values, deleted parents, and all actual field values are exact.
function omitImplicitEmptyAncestors(value, fields, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    const normalized = omitImplicitEmptyAncestors(child, fields, field);
    const implicitAncestor =
      fields.some((candidate) => candidate.startsWith(`${field}.`)) &&
      !fields.some((candidate) => candidate === field || field.startsWith(`${candidate}.`));
    if (
      implicitAncestor && normalized && typeof normalized === "object" &&
      !Array.isArray(normalized) && Object.keys(normalized).length === 0
    ) continue;
    result[key] = normalized;
  }
  return result;
}

function main() {
  for (const input of patches) {
    validateSafeConfigDto(input.schema, input.safe_projection_json, input);
    validateDeletedFields(input.schema, input.deleted_fields, input.projection_fields, input.profile);
  }
  const populated = {
    name: "base",
    advancedSystemPrompt: {
      hiddenBlocks: ["base"],
      warehouseOrder: ["base"],
      viewMode: "base",
    },
  };
  let checked = 0;
  for (const baseline of [populated, { name: "base" }]) {
    for (const first of patches) {
      for (const second of patches) {
        for (const third of patches) {
          const sequence = [first, second, third];
          let live = baseline;
          let snapshot = null;
          for (const input of sequence) {
            live = project(live, input);
            snapshot = materializeConfigSnapshot(snapshot, input);
          }
          validateSafeConfigDto(snapshot.schema, snapshot.safe_projection_json, snapshot);
          validateDeletedFields(snapshot.schema, snapshot.deleted_fields, snapshot.projection_fields, snapshot.profile);
          assert.deepStrictEqual(
            omitImplicitEmptyAncestors(project(baseline, snapshot), snapshot.projection_fields),
            omitImplicitEmptyAncestors(live, snapshot.projection_fields),
            sequence.map((input) => input.label).join(" -> ")
          );
          checked += 1;
        }
      }
    }
  }

  const child = patches.find((input) => input.label === "set child");
  const childDelete = patches.find((input) => input.label === "delete child");
  const absentParent = patches.find((input) => input.label === "absent parent");
  const parentDelete = patches.find((input) => input.label === "delete parent");
  let snapshot = materializeConfigSnapshot(null, child);
  snapshot = materializeConfigSnapshot(snapshot, absentParent);
  assert.deepStrictEqual(snapshot.projection_fields, ["advancedSystemPrompt.hiddenBlocks"]);
  assert.deepStrictEqual(project(populated, snapshot), project(populated, child));

  snapshot = materializeConfigSnapshot(null, parentDelete);
  snapshot = materializeConfigSnapshot(snapshot, child);
  snapshot = materializeConfigSnapshot(snapshot, childDelete);
  assert.deepStrictEqual(project(populated, snapshot), {
    name: "base",
    advancedSystemPrompt: {},
  });
  assert.ok(!snapshot.deleted_fields.includes("advancedSystemPrompt"));

  snapshot = materializeConfigSnapshot(materializeConfigSnapshot(null, child), childDelete);
  assert.deepStrictEqual(project(project({}, child), childDelete), { advancedSystemPrompt: {} });
  assert.deepStrictEqual(project({}, snapshot), {});
  assert.deepStrictEqual(snapshot.projection_fields, ["advancedSystemPrompt.hiddenBlocks"]);
  assert.deepStrictEqual(project({ advancedSystemPrompt: { localOnly: "keep" } }, snapshot), {
    advancedSystemPrompt: { localOnly: "keep" },
  });
  console.log(`config snapshot smoke test passed (${checked} patch sequences)`);
}

main();
