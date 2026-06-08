const path = require("path");

function boolValue(value, defaultValue = false) {
  if (value === undefined || value === null || value === "")
    return defaultValue;
  if (typeof value === "boolean") return value;
  return String(value).trim().toLowerCase() === "true";
}

function intValue(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function resolveFromBase(projectBasePath, value, fallback) {
  const raw = value || fallback;
  const normalized = path.normalize(String(raw));
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(projectBasePath, normalized);
}

function buildRuntimeConfig(
  pluginConfig = {},
  projectBasePath = process.cwd()
) {
  const base =
    projectBasePath || pluginConfig.PROJECT_BASE_PATH || process.cwd();

  return {
    enabled: boolValue(pluginConfig.VCHAT_SYNC_ENABLED, false),
    host: pluginConfig.VCHAT_SYNC_HOST || "127.0.0.1",
    syncKey: pluginConfig.VCHAT_SYNC_KEY || "",
    requireDeviceBinding: boolValue(
      pluginConfig.VCHAT_SYNC_REQUIRE_DEVICE_BINDING,
      true
    ),
    wsEnabled: boolValue(pluginConfig.VCHAT_SYNC_WS_ENABLED, false),
    dbPath: resolveFromBase(
      base,
      pluginConfig.VCHAT_DB_PATH,
      "./Plugin/VChatSyncCenter/data/vchat_data.db"
    ),
    attachmentDir: resolveFromBase(
      base,
      pluginConfig.VCHAT_ATTACHMENT_DIR,
      "./Plugin/VChatSyncCenter/data/vchat_attachments"
    ),
    backupDir: resolveFromBase(
      base,
      pluginConfig.VCHAT_BACKUP_DIR,
      "./Plugin/VChatSyncCenter/data/backups"
    ),
    backupInterval: pluginConfig.VCHAT_BACKUP_INTERVAL || "6h",
    backupRetentionDays: intValue(pluginConfig.VCHAT_BACKUP_RETENTION_DAYS, 30),
    releaseMode: pluginConfig.VCHAT_RELEASE_MODE || "mvp-local-only",
    maxLimit: intValue(pluginConfig.VCHAT_SYNC_MAX_LIMIT, 5000),
    maxAttachmentMb: intValue(pluginConfig.VCHAT_SYNC_MAX_ATTACHMENT_MB, 512),
    debug: boolValue(pluginConfig.DebugMode, false),
    projectBasePath: base,
  };
}

module.exports = {
  buildRuntimeConfig,
};
