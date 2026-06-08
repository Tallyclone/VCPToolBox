const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureDatabase, closeDatabase } = require("../core/db");
const {
  registerDevice,
  processOperation,
} = require("../core/operationProcessor");
const { exportBaseline, importBootstrap } = require("../core/bootstrapService");
const {
  listThemes,
  getTheme,
  upsertThemeAsset,
  upsertThemeAssetMetadata,
  getThemeAsset,
  readThemeAssetFile,
  computeThemeChecksum,
  normalizeThemeInput,
} = require("../core/themeService");
const { getChanges } = require("../core/changeLog");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function tinyPngBuffer() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWtyQAAAABJRU5ErkJggg==",
    "base64"
  );
}

function createRuntime(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const config = {
    dbPath: path.join(tempRoot, "center.db"),
    attachmentDir: path.join(tempRoot, "attachments"),
    backupDir: path.join(tempRoot, "backups"),
    maxLimit: 5000,
    maxAttachmentMb: 16,
    maxThemeAssetMb: 16,
    bootstrapKey: "test-bootstrap-key",
    requireDeviceBinding: false,
  };
  const logger = { warn() {}, info() {}, error() {} };
  const dbContext = ensureDatabase(config, logger);
  return {
    tempRoot,
    runtime: { config, logger, dbContext },
  };
}

function destroyRuntime(holder) {
  if (!holder) return;
  closeDatabase(holder.runtime.dbContext);
  fs.rmSync(holder.tempRoot, { recursive: true, force: true });
}

async function main() {
  const holder = createRuntime("vchat-theme-center-");
  let importHolder = null;
  try {
    const { runtime } = holder;
    const db = runtime.dbContext.db;
    registerDevice(db, {
      device_id: "device-theme-1",
      name: "Theme Test Device",
      trusted: true,
    });

    const png = tinyPngBuffer();
    const assetHash = sha256(png);
    const themePayload = {
      theme_id: "theme-smoke",
      display_name: "Theme Smoke",
      version: 1,
      mode: "dual",
      variables: {
        dark: { "--color-bg": "#000000" },
        light: { "--color-bg": "#ffffff" },
      },
      extra_css: ":root { --theme-smoke: 1; }",
      assets: [
        {
          asset_hash: assetHash,
          asset_type: "wallpaper",
          slot: "default",
          filename: "wallpaper.png",
          mime_type: "image/png",
          size_bytes: png.length,
        },
      ],
    };
    const normalized = normalizeThemeInput(themePayload);
    assert.strictEqual(normalized.checksum, computeThemeChecksum(normalized));
    assert.throws(
      () => normalizeThemeInput({ ...themePayload, checksum: "0".repeat(64) }),
      /theme package checksum mismatch/
    );

    const packageResult = processOperation(db, {
      operation_id: "theme-package-upsert-smoke",
      device_id: "device-theme-1",
      entity_type: "theme_package",
      entity_id: "theme-smoke",
      action: "upsert",
      payload: themePayload,
    });
    assert.strictEqual(packageResult.ok, true);
    assert.strictEqual(packageResult.action, "upsert");

    const packageChange = db
      .prepare("SELECT action FROM change_log WHERE operation_id = ?")
      .get("theme-package-upsert-smoke");
    assert(packageChange, "theme package change should exist");
    assert.strictEqual(packageChange.action, "upsert");

    const uploaded = await upsertThemeAsset(runtime, {
      buffer: png,
      theme_id: "theme-smoke",
      asset_hash: assetHash,
      asset_type: "wallpaper",
      slot: "default",
      mime_type: "image/png",
      filename: "wallpaper.png",
      device_id: "device-theme-1",
      operation_id: "theme-asset-upsert-smoke",
    });
    assert.strictEqual(uploaded.asset.asset_hash, assetHash);
    assert.strictEqual(uploaded.asset.binary_available, true);
    assert(uploaded.latest_seq >= uploaded.seq);

    assert.rejects(
      () =>
        upsertThemeAsset(runtime, {
          buffer: Buffer.from("not-a-png"),
          asset_hash: sha256(Buffer.from("not-a-png")),
          mime_type: "image/png",
        }),
      /theme asset PNG magic mismatch/
    );

    const theme = getTheme(db, "theme-smoke");
    assert(theme, "theme detail should exist");
    assert.strictEqual(theme.assets.length, 1);
    assert.strictEqual(theme.assets[0].asset_hash, assetHash);
    assert.strictEqual(
      listThemes(db, { include_assets: true })[0].assets.length,
      1
    );

    const asset = getThemeAsset(db, runtime.config, assetHash);
    const downloaded = await readThemeAssetFile(asset);
    assert.strictEqual(sha256(downloaded), assetHash);

    const events = getChanges(db, 0, 20);
    assert(events.some((event) => event.entity_type === "theme_package"));
    assert(events.some((event) => event.entity_type === "theme_asset"));

    assert.throws(
      () =>
        processOperation(db, {
          operation_id: "theme-asset-operation-unsupported",
          device_id: "device-theme-1",
          entity_type: "theme_asset",
          entity_id: assetHash,
          action: "upsert",
          payload: { asset_hash: assetHash },
        }),
      /theme_package.*operations are supported/
    );

    const baseline = exportBaseline(runtime, { kind: "themes", limit: 10 });
    assert.strictEqual(baseline.ok, true);
    assert.strictEqual(baseline.baseline.themes.length, 1);
    assert.strictEqual(baseline.baseline.themes[0].assets.length, 1);
    assert.strictEqual(
      baseline.baseline.themes[0].binary_strategy,
      "download_assets_by_hash"
    );

    importHolder = createRuntime("vchat-theme-import-");
    const imported = importBootstrap(importHolder.runtime, {
      mode: "bootstrap_incremental",
      device_id: "device-theme-2",
      themes: baseline.baseline.themes,
    });
    assert.strictEqual(imported.ok, true);
    assert.strictEqual(imported.imported.themes, 1);

    const importedTheme = getTheme(
      importHolder.runtime.dbContext.db,
      "theme-smoke"
    );
    assert(importedTheme, "imported theme should exist");
    assert.strictEqual(importedTheme.assets.length, 1);
    const importedAsset = getThemeAsset(
      importHolder.runtime.dbContext.db,
      importHolder.runtime.config,
      assetHash
    );
    assert.strictEqual(importedAsset.binary_available, false);
    assert.strictEqual(importedAsset.binary_strategy, "download_by_hash");
    await assert.rejects(
      () => readThemeAssetFile(importedAsset),
      /theme asset binary is not available; download by hash from source center/
    );

    const restoredAsset = upsertThemeAssetMetadata(
      importHolder.runtime.dbContext.db,
      {
        asset_hash: assetHash,
        theme_id: "theme-smoke",
        asset_type: "wallpaper",
        slot: "default",
        filename: "wallpaper.png",
        mime_type: "image/png",
        size_bytes: png.length,
        checksum: assetHash,
        storage_path: `bootstrap-missing/${assetHash}`,
      }
    );
    assert.strictEqual(restoredAsset.binary_available, false);

    console.log("theme center smoke test passed");
  } finally {
    destroyRuntime(importHolder);
    destroyRuntime(holder);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
