const SENSITIVE_KEY_PATTERN =
  /key|token|secret|password|cookie|credential|auth|apikey|bearer/i;

const AGENT_ALLOWED = new Set([
  "name",
  "systemPrompt",
  "originalSystemPrompt",
  "advancedSystemPrompt",
  "syncPrompt",
  "promptMode",
  "model",
  "temperature",
  "contextTokenLimit",
  "maxOutputTokens",
  "streamOutput",
  "topics",
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

const GROUP_ALLOWED = new Set([
  "name",
  "description",
  "avatarCalculatedColor",
  "avatarBorderColor",
  "nameTextColor",
  "members",
  "topics",
]);

const SETTINGS_ALLOWED = new Set([
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
    allowed: AGENT_ALLOWED,
    nestedArrays: {
      topics: TOPIC_ALLOWED,
    },
  },
  group_config: {
    allowed: GROUP_ALLOWED,
    nestedArrays: {
      topics: TOPIC_ALLOWED,
    },
  },
  settings: {
    allowed: SETTINGS_ALLOWED,
    nestedArrays: {},
  },
  forum_config: {
    allowed: new Set(["replyUsername"]),
    nestedArrays: {},
  },
};

function scanNoSensitiveKeys(value, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`sensitive config field is not syncable: ${childPath}`);
    }
    if (child && typeof child === "object") scanNoSensitiveKeys(child, childPath);
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

function validateSafeConfigDto(schema, dto) {
  const definition = CONFIG_SCHEMAS[schema];
  if (!definition) throw new Error(`unsupported config schema: ${schema}`);
  if (!dto || typeof dto !== "object" || Array.isArray(dto)) {
    throw new Error("config safe_projection_json must be an object");
  }
  scanNoSensitiveKeys(dto);
  for (const [key, value] of Object.entries(dto)) {
    if (!definition.allowed.has(key)) {
      throw new Error(`unsupported config field for ${schema}: ${key}`);
    }
    validateNestedValue(schema, key, value, key);
  }
  return dto;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  CONFIG_SCHEMAS,
  scanNoSensitiveKeys,
  validateSafeConfigDto,
};
