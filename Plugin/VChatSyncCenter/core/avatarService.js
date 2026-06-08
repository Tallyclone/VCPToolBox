const { appendChange, getOperationResult } = require("./changeLog");
const { safeJsonParse, safeJsonStringify } = require("../utils/safeJson");

const VALID_OWNER_TYPES = new Set(["agent", "group", "user"]);

function nowIso() {
  return new Date().toISOString();
}

function avatarEntityId(ownerType, ownerId) {
  return `${ownerType}:${ownerId}`;
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function sanitizeExt(ext) {
  const raw = String(ext || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const normalized = raw.startsWith(".") ? raw : `.${raw}`;
  return /^\.[a-z0-9]{1,16}$/.test(normalized) ? normalized : "";
}

function assertSafePathSegment(segment, label = "path segment") {
  const value = String(segment || "");
  const normalized = normalizeSlashes(value);
  if (
    !value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/")
  ) {
    throw new Error(`unsafe ${label}: ${segment}`);
  }
  return value;
}

function defaultAvatarRelativePath(ownerType, ownerId, ext) {
  const normalizedExt = sanitizeExt(ext) || ".png";
  if (ownerType === "agent") return `Agents/${ownerId}/avatar${normalizedExt}`;
  if (ownerType === "group")
    return `AgentGroups/${ownerId}/avatar${normalizedExt}`;
  return `user_avatar${normalizedExt}`;
}

function parseAvatarIdentity(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  let match = /^Agents\/([^/]+)\/avatar\.[^/]+$/i.exec(normalized);
  if (match)
    return { owner_type: "agent", owner_id: decodeURIComponent(match[1]) };
  match = /^AgentGroups\/([^/]+)\/avatar\.[^/]+$/i.exec(normalized);
  if (match)
    return { owner_type: "group", owner_id: decodeURIComponent(match[1]) };
  if (/^user_avatar\.[^/]+$/i.test(normalized)) {
    return { owner_type: "user", owner_id: "local_user" };
  }
  if (/^avatarimage\/[^/]+\.(?:png|jpe?g|webp|gif)$/i.test(normalized)) {
    return { owner_type: "user", owner_id: "local_user" };
  }
  return null;
}

function normalizeAvatarRelativePath(ownerType, ownerId, ext, relativePath) {
  const normalized = relativePath
    ? normalizeSlashes(String(relativePath))
    : defaultAvatarRelativePath(ownerType, ownerId, ext);
  const parsed = parseAvatarIdentity(normalized);
  if (!parsed) {
    throw new Error(`unsafe avatar relative_path: ${normalized}`);
  }
  if (parsed.owner_type !== ownerType || parsed.owner_id !== ownerId) {
    throw new Error(`avatar relative_path owner mismatch: ${normalized}`);
  }
  return normalized;
}

function normalizeAvatarPayload(operation) {
  const payload = operation.payload || {};
  const ownerType = String(
    payload.owner_type || payload.ownerType || operation.owner_type || ""
  ).trim();
  const ownerId = String(
    payload.owner_id ||
      payload.ownerId ||
      operation.owner_id ||
      operation.entity_id ||
      ""
  ).trim();
  if (!VALID_OWNER_TYPES.has(ownerType)) {
    throw new Error("avatar owner_type must be agent, group, or user");
  }
  const safeOwnerId = assertSafePathSegment(ownerId, "avatar owner_id");
  const ext = sanitizeExt(payload.ext || "");
  return {
    owner_type: ownerType,
    owner_id: safeOwnerId,
    hash: payload.hash ? String(payload.hash).toLowerCase() : null,
    mime_type: payload.mime_type || payload.mime || null,
    ext,
    relative_path: normalizeAvatarRelativePath(
      ownerType,
      safeOwnerId,
      ext,
      payload.relative_path
    ),
    metadata: payload.metadata || {},
    deleted_at: payload.deleted_at || nowIso(),
  };
}

function attachmentExists(db, hash) {
  return Boolean(
    db.prepare("SELECT 1 FROM attachments WHERE hash = ? LIMIT 1").get(hash)
  );
}

function getAvatar(db, ownerType, ownerId) {
  const row = db
    .prepare(
      "SELECT * FROM avatars WHERE owner_type = ? AND owner_id = ? LIMIT 1"
    )
    .get(ownerType, ownerId);
  if (!row) return null;
  return {
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    hash: row.hash,
    mime_type: row.mime_type || null,
    ext: row.ext || "",
    relative_path: row.relative_path || null,
    metadata: safeJsonParse(row.metadata_json, {}),
    version: Number(row.version || 0),
    deleted: Number(row.deleted || 0) === 1,
    deleted_at: row.deleted_at || null,
    updated_at: row.updated_at,
  };
}

function applyAvatarOperation(db, operation) {
  const previous = getOperationResult(db, operation.operation_id);
  if (previous) return previous;

  const normalized = normalizeAvatarPayload(operation);
  const entityId = avatarEntityId(normalized.owner_type, normalized.owner_id);
  const current = getAvatar(db, normalized.owner_type, normalized.owner_id);
  const nextVersion =
    Number(current && current.version ? current.version : 0) + 1;
  const updatedAt = nowIso();

  if (operation.action === "delete") {
    db.prepare(
      `
INSERT INTO avatars(owner_type, owner_id, hash, mime_type, ext, relative_path, metadata_json, version, deleted, deleted_at, updated_at)
VALUES (?, ?, NULL, NULL, '', ?, ?, ?, 1, ?, ?)
ON CONFLICT(owner_type, owner_id) DO UPDATE SET
  hash = NULL,
  mime_type = NULL,
  ext = '',
  relative_path = excluded.relative_path,
  metadata_json = excluded.metadata_json,
  version = excluded.version,
  deleted = 1,
  deleted_at = excluded.deleted_at,
  updated_at = excluded.updated_at
`
    ).run(
      normalized.owner_type,
      normalized.owner_id,
      normalized.relative_path,
      safeJsonStringify(normalized.metadata),
      nextVersion,
      normalized.deleted_at,
      updatedAt
    );
    const seq = appendChange(db, {
      operation_id: operation.operation_id,
      device_id: operation.device_id || null,
      entity_type: "avatar",
      entity_id: entityId,
      action: "delete",
      version: nextVersion,
      payload: {
        owner_type: normalized.owner_type,
        owner_id: normalized.owner_id,
        relative_path: normalized.relative_path,
        deleted_at: normalized.deleted_at,
      },
    });
    return {
      ok: true,
      seq,
      entity_type: "avatar",
      entity_id: entityId,
      action: "delete",
      version: nextVersion,
      deleted: true,
    };
  }

  if (!normalized.hash || !/^[a-f0-9]{64}$/.test(normalized.hash)) {
    throw new Error("avatar hash must be sha256 hex");
  }
  if (!attachmentExists(db, normalized.hash)) {
    throw new Error(`avatar attachment not found: ${normalized.hash}`);
  }

  db.prepare(
    `
INSERT INTO avatars(owner_type, owner_id, hash, mime_type, ext, relative_path, metadata_json, version, deleted, deleted_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
ON CONFLICT(owner_type, owner_id) DO UPDATE SET
  hash = excluded.hash,
  mime_type = excluded.mime_type,
  ext = excluded.ext,
  relative_path = excluded.relative_path,
  metadata_json = excluded.metadata_json,
  version = excluded.version,
  deleted = 0,
  deleted_at = NULL,
  updated_at = excluded.updated_at
`
  ).run(
    normalized.owner_type,
    normalized.owner_id,
    normalized.hash,
    normalized.mime_type,
    normalized.ext,
    normalized.relative_path,
    safeJsonStringify(normalized.metadata),
    nextVersion,
    updatedAt
  );

  const seq = appendChange(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id || null,
    entity_type: "avatar",
    entity_id: entityId,
    action: current && !current.deleted ? "update" : "create",
    version: nextVersion,
    payload: {
      owner_type: normalized.owner_type,
      owner_id: normalized.owner_id,
      hash: normalized.hash,
      mime_type: normalized.mime_type,
      ext: normalized.ext,
      relative_path: normalized.relative_path,
      metadata: normalized.metadata,
    },
  });
  return {
    ok: true,
    seq,
    entity_type: "avatar",
    entity_id: entityId,
    action: "upsert",
    version: nextVersion,
  };
}

module.exports = {
  applyAvatarOperation,
  avatarEntityId,
  getAvatar,
};
