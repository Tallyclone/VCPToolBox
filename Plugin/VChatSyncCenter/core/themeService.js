const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const {
  safeJsonParse,
  safeJsonStringify,
  stableJsonStringify,
} = require("../utils/safeJson");
const {
  appendChange,
  getLatestSeq,
  getOperationResult,
} = require("./changeLog");

const IMAGE_MIME_ALLOWLIST = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const THEME_MODE_ALLOWLIST = new Set(["dark", "light", "dual"]);
const THEME_ASSET_TYPE_ALLOWLIST = new Set([
  "wallpaper",
  "preview",
  "background",
  "icon",
]);

function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(value, label = "id") {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 160) {
    throw new Error(`${label} is required`);
  }
  if (normalized === "." || normalized === "..") {
    throw new Error(`unsafe ${label}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`unsafe ${label}`);
  }
  return normalized;
}

function sanitizeOptionalId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return sanitizeId(value, label);
}

function sanitizeToken(value, label, fallback = "default") {
  const normalized = String(value || fallback).trim();
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(normalized)) {
    throw new Error(`unsafe ${label}`);
  }
  return normalized;
}

function sanitizeMode(value) {
  const mode = String(value || "dual").toLowerCase();
  if (!THEME_MODE_ALLOWLIST.has(mode))
    throw new Error("unsupported theme mode");
  return mode;
}

function sanitizeAssetType(value) {
  const assetType = String(value || "wallpaper").toLowerCase();
  if (!THEME_ASSET_TYPE_ALLOWLIST.has(assetType)) {
    throw new Error("unsupported theme asset_type");
  }
  return assetType;
}

function sanitizeFilename(value, fallback = "asset.bin") {
  const base = path.basename(String(value || fallback)).replace(/[\r\n]/g, "");
  const name = base.slice(0, 180);
  return name || fallback;
}

function filenameForMime(hash, filename, mimeType) {
  const safeName = sanitizeFilename(
    filename,
    `${hash}${MIME_EXT[mimeType] || ".bin"}`
  );
  const ext = MIME_EXT[mimeType] || ".bin";
  const parsedExt = path.extname(safeName).toLowerCase();
  return parsedExt === ext
    ? safeName
    : `${path.basename(safeName, parsedExt)}${ext}`;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeHash(value) {
  const hash = String(value || "")
    .replace(/^sha256[:-]/i, "")
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("asset hash must be sha256 hex");
  return hash;
}

function safeJson(value, fallback) {
  return safeJsonParse(value, fallback);
}

function verifyImageMagic(buffer, mimeType) {
  if (mimeType === "image/png") {
    if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
      throw new Error("theme asset PNG magic mismatch");
    }
    return;
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    if (
      buffer.length < 3 ||
      buffer[0] !== 0xff ||
      buffer[1] !== 0xd8 ||
      buffer[2] !== 0xff
    ) {
      throw new Error("theme asset JPEG magic mismatch");
    }
    return;
  }
  if (mimeType === "image/webp") {
    if (
      buffer.length < 12 ||
      buffer.toString("ascii", 0, 4) !== "RIFF" ||
      buffer.toString("ascii", 8, 12) !== "WEBP"
    ) {
      throw new Error("theme asset WebP magic mismatch");
    }
    return;
  }
  throw new Error("theme asset must be an allowed image type");
}

function normalizeAssetRef(ref = {}) {
  const hashValue = ref.asset_hash || ref.hash;
  if (!hashValue) return null;
  const assetHash = normalizeHash(hashValue);
  const assetType = sanitizeAssetType(
    ref.asset_type || ref.assetType || "wallpaper"
  );
  const slot = sanitizeToken(ref.slot || assetType, "theme asset slot");
  const mimeType =
    ref.mime_type || ref.mime
      ? String(ref.mime_type || ref.mime).toLowerCase()
      : null;
  return {
    asset_hash: assetHash,
    asset_type: assetType,
    slot,
    filename: ref.filename
      ? sanitizeFilename(ref.filename, `${assetHash}.bin`)
      : null,
    mime_type: mimeType && IMAGE_MIME_ALLOWLIST.has(mimeType) ? mimeType : null,
    size_bytes: Number(ref.size_bytes || ref.sizeBytes || 0) || 0,
    checksum: ref.checksum ? normalizeHash(ref.checksum) : assetHash,
    storage_path: ref.storage_path || ref.storagePath || null,
    relative_path: ref.relative_path || ref.relativePath || null,
  };
}

function collectAssetRefs(input = {}, manifest = {}) {
  const refs = [];
  const add = (ref, defaults = {}) => {
    if (!ref || typeof ref !== "object") return;
    const normalized = normalizeAssetRef({ ...defaults, ...ref });
    if (normalized) refs.push(normalized);
  };
  const directAssets = input.assets || manifest.assets;
  if (Array.isArray(directAssets)) directAssets.forEach((ref) => add(ref));
  const wallpapers = input.wallpapers || manifest.wallpapers;
  if (wallpapers && typeof wallpapers === "object") {
    for (const [slot, ref] of Object.entries(wallpapers)) {
      add(ref, { asset_type: "wallpaper", slot });
    }
  }
  add(input.preview || manifest.preview, {
    asset_type: "preview",
    slot: "preview",
  });
  const unique = new Map();
  for (const ref of refs) {
    unique.set(`${ref.asset_hash}:${ref.asset_type}:${ref.slot}`, ref);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.asset_type}:${a.slot}:${a.asset_hash}`.localeCompare(
      `${b.asset_type}:${b.slot}:${b.asset_hash}`
    )
  );
}

function normalizeThemeInput(input = {}) {
  const rawManifest =
    input.manifest_json && typeof input.manifest_json === "object"
      ? input.manifest_json
      : input.manifest && typeof input.manifest === "object"
      ? input.manifest
      : {};
  const themeId = sanitizeId(
    input.theme_id ||
      input.themeId ||
      rawManifest.theme_id ||
      rawManifest.themeId ||
      input.file_name ||
      input.fileName,
    "theme_id"
  );
  const sourceDeviceId =
    input.source_device_id ||
    input.device_id ||
    rawManifest.source_device_id ||
    rawManifest.device_id ||
    null;
  const variablesSource =
    input.variables && typeof input.variables === "object"
      ? input.variables
      : rawManifest.variables && typeof rawManifest.variables === "object"
      ? rawManifest.variables
      : {};
  const dark =
    variablesSource.dark && typeof variablesSource.dark === "object"
      ? variablesSource.dark
      : {};
  const light =
    variablesSource.light && typeof variablesSource.light === "object"
      ? variablesSource.light
      : {};
  const mode = sanitizeMode(input.mode || rawManifest.mode);
  const displayName = String(
    input.display_name ||
      input.displayName ||
      rawManifest.display_name ||
      rawManifest.displayName ||
      themeId
  ).slice(0, 160);
  const version = Math.max(
    Number.parseInt(input.version || rawManifest.version || 1, 10) || 1,
    1
  );
  const extraCss = String(
    input.extra_css ||
      input.extraCss ||
      rawManifest.extra_css ||
      rawManifest.extraCss ||
      ""
  ).slice(0, 200000);
  const assets = collectAssetRefs(input, rawManifest);
  const manifest = {
    ...rawManifest,
    theme_id: themeId,
    display_name: displayName,
    version,
    mode,
    variables: { dark, light },
    extra_css: extraCss,
    assets,
  };
  delete manifest.operation_id;
  delete manifest.operationId;
  delete manifest.device_id;
  delete manifest.deviceId;
  delete manifest.source_device_id;
  delete manifest.deleted;
  delete manifest.checksum;
  const normalized = {
    theme_id: themeId,
    display_name: displayName,
    version,
    source_device_id: sourceDeviceId,
    mode,
    variables: { dark, light },
    extra_css: extraCss,
    manifest,
    assets,
  };
  const checksum = computeThemeChecksum(normalized);
  if (input.checksum) {
    const incoming = String(input.checksum)
      .replace(/^sha256[:-]/i, "")
      .toLowerCase();
    const acceptableChecksums = new Set([checksum]);
    acceptableChecksums.add(
      computeThemeChecksum({
        theme_id: input.theme_id || input.themeId || themeId,
        display_name: input.display_name || input.displayName || displayName,
        version: input.version || version,
        mode: input.mode || mode,
        variables: input.variables || { dark, light },
        extra_css: input.extra_css || input.extraCss || extraCss,
        manifest: input.manifest || input.manifest_json || rawManifest,
        assets: input.assets || rawManifest.assets || [],
      })
    );
    if (sourceDeviceId) {
      acceptableChecksums.add(
        computeThemeChecksum({
          ...normalized,
          manifest: { ...manifest, source_device_id: sourceDeviceId },
        })
      );
    }
    if (!acceptableChecksums.has(incoming))
      throw new Error("theme package checksum mismatch");
  }
  normalized.checksum = checksum;
  return normalized;
}

function packageRowToDto(row) {
  if (!row) return null;
  const manifest = safeJson(row.manifest_json, {});
  return {
    theme_id: row.theme_id,
    display_name: row.display_name,
    version: Number(row.version || 1),
    source_device_id: row.source_device_id || null,
    mode: row.mode || "dual",
    variables: {
      dark: safeJson(row.variables_dark_json, {}),
      light: safeJson(row.variables_light_json, {}),
    },
    extra_css: row.extra_css || "",
    manifest,
    manifest_json: manifest,
    checksum: row.checksum,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function assetRowToDto(row) {
  if (!row) return null;
  return {
    asset_hash: row.asset_hash,
    theme_id: row.theme_id,
    asset_type: row.asset_type,
    slot: row.slot,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes || 0),
    checksum: row.checksum,
    relative_path: row.relative_path || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    download_url: `/themes/assets/${row.asset_hash}`,
  };
}

function computeThemeChecksum(input) {
  return crypto
    .createHash("sha256")
    .update(
      stableJsonStringify({
        theme_id: input.theme_id,
        display_name: input.display_name,
        version: Number(input.version || 1),
        mode: input.mode || "dual",
        variables: input.variables || {},
        extra_css: input.extra_css || "",
        manifest: input.manifest || input.manifest_json || {},
        assets: input.assets || [],
      })
    )
    .digest("hex");
}

function ensureThemeAssetDir(config) {
  const dir =
    config.themeAssetDir || path.join(config.attachmentDir, "theme_assets");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("unsafe theme asset storage_path");
  }
  return target;
}

function storagePathFor(config, hash, filename) {
  const ext = path.extname(filename || "") || ".bin";
  const prefix = hash.slice(0, 2) || "00";
  return ensureInside(
    ensureThemeAssetDir(config),
    path.join(ensureThemeAssetDir(config), prefix, `${hash}${ext}`)
  );
}

function relativeThemeAssetPath(config, absolutePath) {
  const base = ensureThemeAssetDir(config);
  return path
    .relative(base, ensureInside(base, absolutePath))
    .replace(/\\/g, "/");
}

function listThemes(db, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 1000);
  const includeAssets =
    options.include_assets === "1" || options.include_assets === true;
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM theme_package_assets pa WHERE pa.theme_id = p.theme_id) AS asset_count
       FROM theme_packages p
       WHERE p.deleted = 0
       ORDER BY p.updated_at DESC, p.theme_id ASC LIMIT ?`
    )
    .all(limit);
  return rows.map((row) => {
    const dto = packageRowToDto(row);
    dto.asset_count = Number(row.asset_count || 0);
    if (includeAssets) dto.assets = listThemeAssets(db, dto.theme_id);
    return dto;
  });
}

function listThemeAssets(db, themeId) {
  return db
    .prepare(
      `SELECT a.*, COALESCE(pa.slot, a.slot) AS slot, COALESCE(pa.asset_type, a.asset_type) AS asset_type
       FROM theme_package_assets pa
       JOIN theme_assets a ON a.asset_hash = pa.asset_hash
       WHERE pa.theme_id = ?
       ORDER BY pa.asset_type, pa.slot, a.filename`
    )
    .all(themeId)
    .map(assetRowToDto);
}

function getTheme(db, themeId) {
  const id = sanitizeId(themeId, "theme_id");
  const row = db
    .prepare(
      "SELECT * FROM theme_packages WHERE theme_id = ? AND deleted = 0 LIMIT 1"
    )
    .get(id);
  const theme = packageRowToDto(row);
  if (!theme) return null;
  theme.assets = listThemeAssets(db, id);
  theme.asset_count = theme.assets.length;
  return theme;
}

function ensureThemeExists(db, themeId) {
  if (!themeId) return;
  const row = db
    .prepare(
      "SELECT theme_id FROM theme_packages WHERE theme_id = ? AND deleted = 0"
    )
    .get(themeId);
  if (!row) throw new Error("theme package must exist before linking asset");
}

function syncThemeAssetMappings(db, themeId, assets = []) {
  db.prepare("DELETE FROM theme_package_assets WHERE theme_id = ?").run(
    themeId
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO theme_package_assets(theme_id, asset_hash, slot, asset_type)
     SELECT ?, asset_hash, ?, ? FROM theme_assets WHERE asset_hash = ?`
  );
  for (const asset of assets) {
    insert.run(themeId, asset.slot, asset.asset_type, asset.asset_hash);
  }
}

function backfillThemeAssetMappings(db, assetHash, slot, assetType) {
  const rows = db
    .prepare(
      "SELECT theme_id, manifest_json FROM theme_packages WHERE deleted = 0"
    )
    .all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO theme_package_assets(theme_id, asset_hash, slot, asset_type)
     VALUES (?, ?, ?, ?)`
  );
  for (const row of rows) {
    const manifest = safeJson(row.manifest_json, {});
    const refs = collectAssetRefs(manifest, manifest);
    for (const ref of refs) {
      if (ref.asset_hash === assetHash) {
        insert.run(
          row.theme_id,
          assetHash,
          ref.slot || slot,
          ref.asset_type || assetType
        );
      }
    }
  }
}

function upsertThemePackage(db, input = {}) {
  const normalized = normalizeThemeInput(input);
  const now = nowIso();
  db.prepare(
    `INSERT INTO theme_packages(theme_id, display_name, version, source_device_id, mode, variables_dark_json, variables_light_json, extra_css, manifest_json, checksum, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(theme_id) DO UPDATE SET
       display_name = excluded.display_name,
       version = excluded.version,
       source_device_id = excluded.source_device_id,
       mode = excluded.mode,
       variables_dark_json = excluded.variables_dark_json,
       variables_light_json = excluded.variables_light_json,
       extra_css = excluded.extra_css,
       manifest_json = excluded.manifest_json,
       checksum = excluded.checksum,
       deleted = 0,
       updated_at = excluded.updated_at`
  ).run(
    normalized.theme_id,
    normalized.display_name,
    normalized.version,
    normalized.source_device_id,
    normalized.mode,
    safeJsonStringify(normalized.variables.dark),
    safeJsonStringify(normalized.variables.light),
    normalized.extra_css,
    safeJsonStringify(normalized.manifest),
    normalized.checksum,
    now,
    now
  );
  syncThemeAssetMappings(db, normalized.theme_id, normalized.assets);
  return getTheme(db, normalized.theme_id);
}

function applyThemePackageOperation(db, operation = {}) {
  const action = operation.action || "upsert";
  const payload = operation.payload || {};
  const themeId = sanitizeId(
    operation.entity_id || payload.theme_id || payload.themeId,
    "theme_id"
  );
  let theme = null;
  if (action === "delete") {
    const now = nowIso();
    db.prepare(
      `UPDATE theme_packages SET deleted = 1, updated_at = ? WHERE theme_id = ?`
    ).run(now, themeId);
    db.prepare("DELETE FROM theme_package_assets WHERE theme_id = ?").run(
      themeId
    );
    theme = { theme_id: themeId, deleted: true, updated_at: now };
  } else if (["create", "update", "upsert"].includes(action)) {
    theme = upsertThemePackage(db, {
      ...payload,
      theme_id: themeId,
      device_id: operation.device_id,
    });
  } else {
    throw new Error("unsupported theme_package action");
  }
  const version = theme && theme.version ? theme.version : payload.version || 1;
  const seq = appendChange(db, {
    operation_id: operation.operation_id,
    device_id: operation.device_id || null,
    entity_type: "theme_package",
    entity_id: themeId,
    action,
    version,
    payload: theme || payload,
  });
  return {
    ok: true,
    seq,
    entity_type: "theme_package",
    action,
    version,
    theme,
  };
}

function upsertThemeAssetMetadata(db, input = {}) {
  const assetHash = normalizeHash(input.asset_hash || input.hash);
  const themeId = sanitizeOptionalId(
    input.theme_id || input.themeId,
    "theme_id"
  );
  ensureThemeExists(db, themeId);
  const assetType = sanitizeAssetType(
    input.asset_type || input.assetType || "wallpaper"
  );
  const slot = sanitizeToken(input.slot || "default", "theme asset slot");
  const mimeType = String(
    input.mime_type || input.mime || "application/octet-stream"
  ).toLowerCase();
  const filename = sanitizeFilename(
    input.filename,
    `${assetHash}${MIME_EXT[mimeType] || ".bin"}`
  );
  if (!IMAGE_MIME_ALLOWLIST.has(mimeType)) {
    throw new Error("theme asset must be an allowed image type");
  }
  const storagePath = String(
    input.storage_path || input.storagePath || `bootstrap-missing/${assetHash}`
  );
  const relativePath = input.relative_path || input.relativePath || null;
  const binaryAvailable =
    input.binary_available === false ||
    storagePath.startsWith("bootstrap-missing/")
      ? 0
      : 1;
  const now = nowIso();
  db.prepare(
    `INSERT INTO theme_assets(asset_hash, theme_id, asset_type, slot, filename, mime_type, size_bytes, storage_path, relative_path, checksum, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(asset_hash) DO UPDATE SET
       theme_id = COALESCE(excluded.theme_id, theme_assets.theme_id),
       asset_type = excluded.asset_type,
       slot = excluded.slot,
       filename = excluded.filename,
       mime_type = excluded.mime_type,
       size_bytes = excluded.size_bytes,
       storage_path = excluded.storage_path,
       relative_path = COALESCE(excluded.relative_path, theme_assets.relative_path),
       checksum = excluded.checksum,
       updated_at = excluded.updated_at`
  ).run(
    assetHash,
    themeId,
    assetType,
    slot,
    filename,
    mimeType,
    Number(input.size_bytes || input.sizeBytes || 0) || 0,
    storagePath,
    relativePath,
    input.checksum ? normalizeHash(input.checksum) : assetHash,
    now,
    now
  );
  if (themeId) {
    db.prepare(
      `INSERT OR IGNORE INTO theme_package_assets(theme_id, asset_hash, slot, asset_type)
       VALUES (?, ?, ?, ?)`
    ).run(themeId, assetHash, slot, assetType);
  }
  backfillThemeAssetMappings(db, assetHash, slot, assetType);
  const asset = assetRowToDto(
    db.prepare("SELECT * FROM theme_assets WHERE asset_hash = ?").get(assetHash)
  );
  asset.binary_available = binaryAvailable === 1;
  if (!asset.binary_available) asset.binary_strategy = "download_by_hash";
  return asset;
}

async function upsertThemeAsset(runtime, input = {}) {
  const db = runtime.dbContext.db;
  const config = runtime.config;
  const themeId = sanitizeOptionalId(
    input.theme_id || input.themeId,
    "theme_id"
  );
  if (themeId) {
    const row = db
      .prepare(
        "SELECT theme_id FROM theme_packages WHERE theme_id = ? AND deleted = 0"
      )
      .get(themeId);
    if (!row) throw new Error("theme package must exist before linking asset");
  }
  const buffer = Buffer.isBuffer(input.buffer)
    ? input.buffer
    : Buffer.from(input.buffer || "");
  if (!buffer.length) throw new Error("theme asset content is required");
  const maxBytes =
    Number(config.maxThemeAssetMb || config.maxAttachmentMb || 512) *
    1024 *
    1024;
  if (buffer.length > maxBytes)
    throw new Error("theme asset exceeds max allowed size");
  const computedHash = sha256Buffer(buffer);
  const expectedHash =
    input.asset_hash || input.hash
      ? normalizeHash(input.asset_hash || input.hash)
      : computedHash;
  if (computedHash !== expectedHash)
    throw new Error("theme asset hash mismatch");

  const operationId =
    input.operation_id ||
    `theme_asset.${themeId || "unlinked"}.${expectedHash}.${Date.now()}`;
  const previousOperation = getOperationResult(db, operationId);
  if (previousOperation) {
    const row = db
      .prepare("SELECT * FROM theme_assets WHERE asset_hash = ?")
      .get(expectedHash);
    const existing = assetRowToDto(row);
    if (existing) {
      existing.binary_available = !String(row?.storage_path || "").startsWith(
        "bootstrap-missing/"
      );
      if (!existing.binary_available)
        existing.binary_strategy = "download_by_hash";
    }
    return {
      asset: existing,
      seq: previousOperation.seq,
      latest_seq: getLatestSeq(db),
      operation_id: operationId,
      idempotent: true,
    };
  }

  const assetType = sanitizeAssetType(
    input.asset_type || input.assetType || "wallpaper"
  );
  const slot = sanitizeToken(input.slot || "default", "theme asset slot");
  const mimeType = String(
    input.mime_type || input.mime || "application/octet-stream"
  ).toLowerCase();
  if (!IMAGE_MIME_ALLOWLIST.has(mimeType))
    throw new Error("theme asset must be an allowed image type");
  verifyImageMagic(buffer, mimeType);

  const filename = filenameForMime(expectedHash, input.filename, mimeType);
  const target = storagePathFor(config, expectedHash, filename);
  let createdFile = false;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const existingHash = sha256Buffer(await fsp.readFile(target));
    if (existingHash !== expectedHash) {
      throw new Error("theme asset existing file checksum mismatch");
    }
  } else {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buffer);
    if (sha256Buffer(await fsp.readFile(tmp)) !== expectedHash) {
      await fsp.rm(tmp, { force: true });
      throw new Error("theme asset tmp checksum mismatch");
    }
    await fsp.rename(tmp, target).catch(async () => {
      await fsp.copyFile(tmp, target);
      await fsp.rm(tmp, { force: true });
    });
    createdFile = true;
  }

  try {
    const asset = upsertThemeAssetMetadata(db, {
      asset_hash: expectedHash,
      theme_id: themeId,
      asset_type: assetType,
      slot,
      filename,
      mime_type: mimeType,
      size_bytes: buffer.length,
      storage_path: relativeThemeAssetPath(config, target),
      relative_path: input.relative_path || input.relativePath || null,
      checksum: expectedHash,
    });
    const seq = appendChange(db, {
      operation_id: operationId,
      device_id: input.device_id || input.deviceId || null,
      entity_type: "theme_asset",
      entity_id: expectedHash,
      action: "upsert",
      version: 1,
      payload: asset,
    });
    return {
      asset,
      seq,
      latest_seq: getLatestSeq(db),
      operation_id: operationId,
    };
  } catch (error) {
    if (createdFile) await fsp.rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

function getThemeAsset(db, config, hash) {
  const assetHash = normalizeHash(hash);
  const row = db
    .prepare("SELECT * FROM theme_assets WHERE asset_hash = ? LIMIT 1")
    .get(assetHash);
  const asset = assetRowToDto(row);
  if (!asset) return null;
  if (String(row.storage_path || "").startsWith("bootstrap-missing/")) {
    asset.binary_available = false;
    asset.binary_strategy = "download_by_hash";
    return asset;
  }
  const base = ensureThemeAssetDir(config);
  asset.absolute_path = ensureInside(
    base,
    path.resolve(base, row.storage_path)
  );
  asset.binary_available = true;
  return asset;
}

async function readThemeAssetFile(asset) {
  if (!asset.absolute_path || asset.binary_available === false) {
    throw new Error(
      "theme asset binary is not available; download by hash from source center"
    );
  }
  const buffer = await fsp.readFile(asset.absolute_path);
  if (sha256Buffer(buffer) !== asset.asset_hash) {
    throw new Error("theme asset file checksum mismatch");
  }
  return buffer;
}

module.exports = {
  listThemes,
  getTheme,
  listThemeAssets,
  upsertThemePackage,
  applyThemePackageOperation,
  upsertThemeAsset,
  upsertThemeAssetMetadata,
  getThemeAsset,
  readThemeAssetFile,
  computeThemeChecksum,
  normalizeThemeInput,
};
