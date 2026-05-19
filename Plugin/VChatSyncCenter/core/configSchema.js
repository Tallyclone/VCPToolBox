const SENSITIVE_KEY_PATTERN =
  /key|token|secret|password|cookie|credential|auth|apikey|bearer/i;

const AGENT_BOOTSTRAP_ALLOWED = new Set([
  "name",
  "systemPrompt",
  "originalSystemPrompt",
  "advancedSystemPrompt",
  "advancedSystemPrompt.hiddenBlocks",
  "advancedSystemPrompt.warehouseOrder",
  "advancedSystemPrompt.viewMode",
  "advancedSystemPrompt.blocks",
  "syncPrompt",
  "promptMode",
  "model",
  "temperature",
  "contextTokenLimit",
  "maxOutputTokens",
  "streamOutput",
  "topics",
  "presetSystemPrompt",
  "selectedPreset",
  "disableCustomColors",
  "useThemeColorsInChat",
  "avatarBorderColor",
  "nameTextColor",
  "customCss",
  "cardCss",
  "chatCss",
  "ttsVoicePrimary",
  "ttsRegexPrimary",
  "ttsVoiceSecondary",
  "ttsSpeed",
  "stripRegexes",
  "regex_rules",
]);

const AGENT_RUNTIME_DENYLIST = new Set([
  "systemPrompt",
  "originalSystemPrompt",
  "advancedSystemPrompt",
  "advancedSystemPrompt.blocks",
  "syncPrompt",
  "model",
  "temperature",
  "contextTokenLimit",
  "maxOutputTokens",
  "streamOutput",
  "ttsVoicePrimary",
  "ttsRegexPrimary",
  "ttsVoiceSecondary",
  "ttsSpeed",
  "customCss",
  "cardCss",
  "chatCss",
  "avatarBorderColor",
  "nameTextColor",
  "uiCollapseStates",
  "stripRegexes",
  "regex_rules",
]);

const GROUP_BOOTSTRAP_ALLOWED = new Set([
  "name",
  "description",
  "avatarCalculatedColor",
  "avatarBorderColor",
  "nameTextColor",
  "members",
  "topics",
  "groupPrompt",
  "invitePrompt",
  "mode",
  "tagMatchMode",
  "memberTags",
  "useUnifiedModel",
  "unifiedModel",
]);

const GROUP_RUNTIME_DENYLIST = new Set([
  "groupPrompt",
  "invitePrompt",
  "useUnifiedModel",
  "unifiedModel",
]);

const TOPIC_ALLOWED = new Set([
  "id",
  "name",
  "createdAt",
  "locked",
  "unread",
  "creatorSource",
]);

const CONFIG_SCHEMAS = {
  agent_config: {
    allowed: AGENT_BOOTSTRAP_ALLOWED,
    runtimeDenylist: AGENT_RUNTIME_DENYLIST,
    nestedArrays: { topics: TOPIC_ALLOWED },
  },
  group_config: {
    allowed: GROUP_BOOTSTRAP_ALLOWED,
    runtimeDenylist: GROUP_RUNTIME_DENYLIST,
    nestedArrays: { topics: TOPIC_ALLOWED },
  },
  global_prompt_warehouse: {
    allowed: new Set(["$"]),
    runtimeDenylist: new Set(),
    wholeDocument: true,
    nestedArrays: {},
  },
  system_prompt_preset: {
    allowed: new Set(["$"]),
    runtimeDenylist: new Set(),
    wholeDocument: true,
    nestedArrays: {},
  },
  settings: {
    allowed: new Set([
      "displayName",
      "username",
      "theme",
      "fontSize",
      "chatFontSize",
      "messageSpacing",
      "bubbleStyle",
      "sortOrder",
      "ttsVoicePrimary",
      "ttsVoiceSecondary",
      "ttsSpeed",
      "streamOutput",
    ]),
    runtimeDenylist: new Set(),
    nestedArrays: {},
  },
  forum_config: {
    allowed: new Set(["replyUsername"]),
    runtimeDenylist: new Set(),
    nestedArrays: {},
  },
};

function normalizeProfile(profile) {
  return profile === "runtime" || profile === "manual" ? profile : "bootstrap";
}

function scanNoSensitiveKeys(value, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`sensitive config field is not syncable: ${childPath}`);
    }
    if (child && typeof child === "object")
      scanNoSensitiveKeys(child, childPath);
  }
}

function validateNestedValue(schema, key, value, path) {
  const definition = CONFIG_SCHEMAS[schema];
  const nestedAllowed = definition && definition.nestedArrays[key];
  if (!nestedAllowed || !Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    for (const childKey of Object.keys(item)) {
      if (!nestedAllowed.has(childKey)) {
        throw new Error(
          `unsupported config field for ${schema}: ${path}[${index}].${childKey}`
        );
      }
    }
  });
}

function validateProjectionFields(
  schema,
  projectionFields,
  profile = "bootstrap"
) {
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);
  if (projectionFields === undefined || projectionFields === null) return null;
  if (!Array.isArray(projectionFields)) {
    throw new Error("config projection_fields must be a string array");
  }
  const normalizedProfile = normalizeProfile(profile);
  for (const field of projectionFields) {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error("config projection_fields must be a string array");
    }
    if (!definition.allowed.has(field)) {
      throw new Error(`unsupported projection field for ${schema}: ${field}`);
    }
    if (
      normalizedProfile === "runtime" &&
      definition.runtimeDenylist.has(field)
    ) {
      throw new Error(
        `runtime projection field is denied for ${schema}: ${field}`
      );
    }
  }
  return projectionFields;
}

function flattenDtoLeafPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix] : [];
  const paths = [];
  for (const [key, child] of entries) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      paths.push(...flattenDtoLeafPaths(child, childPath));
    } else {
      paths.push(childPath);
    }
  }
  return paths;
}

function collapseCoveredPaths(fields) {
  const sorted = fields.filter(Boolean).sort((a, b) => a.length - b.length);
  const out = [];
  for (const field of sorted) {
    if (
      out.some((parent) => field !== parent && field.startsWith(`${parent}.`))
    )
      continue;
    out.push(field);
  }
  return out;
}

function validateSafeConfigDto(schema, dto, options = {}) {
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);
  if (!dto || typeof dto !== "object" || Array.isArray(dto)) {
    throw new Error("config safe_projection_json must be an object");
  }
  scanNoSensitiveKeys(dto);
  const projectionFields = validateProjectionFields(
    schema,
    options.projection_fields,
    options.profile
  );
  if (
    normalizeProfile(options.profile) === "runtime" &&
    (schema === "agent_config" || schema === "group_config") &&
    !projectionFields
  ) {
    throw new Error(
      "runtime agent/group config operation requires projection_fields"
    );
  }
  if (!definition.wholeDocument) {
    const allowed = new Set(
      projectionFields || collapseCoveredPaths([...definition.allowed])
    );
    for (const leafPath of flattenDtoLeafPaths(dto)) {
      const matched = [...allowed].some(
        (fieldPath) =>
          fieldPath === leafPath || leafPath.startsWith(`${fieldPath}.`)
      );
      if (!matched) {
        throw new Error(`unsupported config field for ${schema}: ${leafPath}`);
      }
    }
    for (const [key, value] of Object.entries(dto)) {
      validateNestedValue(schema, key, value, key);
    }
  }
  return dto;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  CONFIG_SCHEMAS,
  normalizeProfile,
  scanNoSensitiveKeys,
  validateProjectionFields,
  validateSafeConfigDto,
};
