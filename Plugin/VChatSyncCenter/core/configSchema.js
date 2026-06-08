const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(key|token|secret|password|cookie|credential|auth|apikey|bearer)([_-]|$)/i;

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
  "uiCollapseStates",
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
  "ttsRegexSecondary",
  "ttsSpeed",
  "stripRegexes",
  "regex_rules",
]);

const AGENT_RUNTIME_DENYLIST = new Set();

const GROUP_BOOTSTRAP_ALLOWED = new Set([
  "id",
  "name",
  "description",
  "avatar",
  "createdAt",
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
  "useUnifiedModel",
  "unifiedModel",
  "tagMatchMode",
]);

const TOPIC_ALLOWED = new Set([
  "id",
  "name",
  "createdAt",
  "locked",
  "unread",
  "creatorSource",
]);

const SETTINGS_ALLOWED = new Set([
  "userName",
  "userAvatarUrl",
  "enableAgentBubbleTheme",
  "assistantAgent",
  "voiceMode",
  "speechRecognizerBrowserPath",
  "speechRecognizerPagePath",
  "voiceLocalSettings.sovitsUrl",
  "voiceLocalSettings.sovitsKey",
  "voiceNetworkSettings.providerUrl",
  "voiceNetworkSettings.providerKey",
  "enableDistributedServer",
  "enableVcpToolInjection",
  "enableThoughtChainInjection",
  "enableAiMessageButtons",
  "enableContextSanitizer",
  "contextSanitizerDepth",
  "agentMusicControl",
  "topicSummaryModel",
  "enableDistributedServerLogs",
  "continueWritingPrompt",
  "flowlockContinueDelay",
  "enableMiddleClickQuickAction",
  "middleClickQuickAction",
  "enableRegenerateConfirmation",
  "enableMiddleClickAdvanced",
  "middleClickAdvancedDelay",
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
    allowed: SETTINGS_ALLOWED,
    runtimeDenylist: new Set(),
    allowSensitiveFields: SETTINGS_ALLOWED,
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

function isSensitiveFieldAllowed(definition, fieldPath) {
  return Boolean(
    definition &&
      definition.allowSensitiveFields &&
      definition.allowSensitiveFields.has(fieldPath)
  );
}

function scanNoSensitiveKeys(value, path = "", definition = null) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      SENSITIVE_KEY_PATTERN.test(key) &&
      !isSensitiveFieldAllowed(definition, childPath)
    ) {
      throw new Error(`sensitive config field is not syncable: ${childPath}`);
    }
    if (child && typeof child === "object")
      scanNoSensitiveKeys(child, childPath, definition);
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

function normalizeDeletedFields(deletedFields) {
  if (deletedFields === undefined || deletedFields === null) return [];
  if (!Array.isArray(deletedFields)) {
    throw new Error("config deleted_fields must be a string array");
  }
  const normalized = [];
  for (const field of deletedFields) {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error("config deleted_fields must be a string array");
    }
    normalized.push(field.trim());
  }
  return [...new Set(normalized)];
}

function validateDeletedFields(
  schema,
  deletedFields,
  projectionFields,
  profile = "bootstrap"
) {
  const normalized = normalizeDeletedFields(deletedFields);
  if (normalized.length === 0) return normalized;
  const validatedProjectionFields = validateProjectionFields(
    schema,
    projectionFields,
    profile
  );
  if (!validatedProjectionFields) {
    throw new Error("config deleted_fields requires projection_fields");
  }
  const projectionSet = new Set(validatedProjectionFields);
  for (const field of normalized) {
    if (!projectionSet.has(field)) {
      throw new Error(
        `deleted field must be declared in projection_fields: ${field}`
      );
    }
    validateProjectionFields(schema, [field], profile);
    const leaf = field.split(".").filter(Boolean).slice(-1)[0] || field;
    const definition = CONFIG_SCHEMAS[schema];
    if (
      SENSITIVE_KEY_PATTERN.test(leaf) &&
      !isSensitiveFieldAllowed(definition, field)
    ) {
      throw new Error(`sensitive deleted field is not syncable: ${field}`);
    }
  }
  return normalized;
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
  if (!dto || typeof dto !== "object") {
    throw new Error("config safe_projection_json must be an object");
  }
  if (Array.isArray(dto) && !definition.wholeDocument) {
    throw new Error("config safe_projection_json must be an object");
  }
  scanNoSensitiveKeys(dto, "", definition);
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
  normalizeDeletedFields,
  validateDeletedFields,
  validateSafeConfigDto,
};
