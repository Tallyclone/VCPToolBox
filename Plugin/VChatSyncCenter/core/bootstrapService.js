const { appendChange, getLatestSeq, getChanges } = require("./changeLog");
const { registerDevice } = require("./operationProcessor");
const { applyCreate } = require("./messageService");
const { applyConfigOperation } = require("./configService");
const { applyAvatarOperation } = require("./avatarService");
const { ensureItem } = require("./itemService");
const { applyTopicUpsert } = require("./topicService");
const {
  listThemeAssets,
  upsertThemePackage,
  upsertThemeAssetMetadata,
} = require("./themeService");
const { validateSyncAuth } = require("./auth");
const { safeJsonParse, safeJsonStringify } = require("../utils/safeJson");

function parseJson(value, fallback) {
  return safeJsonParse(value, fallback);
}

function audit(runtime, action, detail = {}) {
  const logger = runtime && runtime.logger;
  if (logger && logger.warn)
    logger.warn(`VChatSyncCenter bootstrap ${action}`, detail);
}

function requireBootstrapAuth(runtime, req) {
  const result = validateSyncAuth(runtime, req);
  if (!result.ok) {
    const error = new Error(result.error || "authorization failed");
    error.statusCode = result.status || 401;
    throw error;
  }
}

function centerIsEmpty(db) {
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM config_entities) AS configs,
        (SELECT COUNT(*) FROM attachments) AS attachments,
        (SELECT COUNT(*) FROM theme_packages WHERE deleted = 0) AS themes,
        (SELECT COUNT(*) FROM change_log) AS changes`
    )
    .get();
  return (
    !row ||
    (row.messages === 0 &&
      row.items === 0 &&
      row.topics === 0 &&
      row.configs === 0 &&
      row.attachments === 0 &&
      row.themes === 0 &&
      row.changes === 0)
  );
}

function insertBaselineChange(db, input) {
  return appendChange(db, {
    operation_id: input.operation_id,
    device_id: input.device_id || null,
    item_type: input.item_type || null,
    item_id: input.item_id || null,
    topic_id: input.topic_id || null,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    action: input.action || "baseline",
    version: input.version || 1,
    payload: input.payload || {},
  });
}

function startBootstrapSession(db, manifest, counts) {
  const sessionId =
    manifest.session_id ||
    manifest.sessionId ||
    `bootstrap.${
      manifest.device_id || manifest.deviceId || "unknown"
    }.${Date.now()}`;
  db.prepare(
    `INSERT INTO bootstrap_sessions(id, mode, device_id, status, checkpoint_json, audit_json)
     VALUES (?, ?, ?, 'started', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       device_id = excluded.device_id,
       status = 'started',
       checkpoint_json = excluded.checkpoint_json,
       audit_json = excluded.audit_json,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(
    sessionId,
    manifest.mode || "bootstrap_primary",
    manifest.device_id || manifest.deviceId || null,
    safeJsonStringify({ stage: "started", counts }),
    safeJsonStringify({ started_at: new Date().toISOString() })
  );
  return sessionId;
}

function updateBootstrapSession(
  db,
  sessionId,
  status,
  checkpoint = {},
  auditDetail = {}
) {
  db.prepare(
    `UPDATE bootstrap_sessions
     SET status = ?, checkpoint_json = ?, audit_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    status,
    safeJsonStringify(checkpoint),
    safeJsonStringify({ ...auditDetail, updated_at: new Date().toISOString() }),
    sessionId
  );
}

function parseCursor(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildPageInfo(kind, cursor, limit, rows) {
  return {
    kind,
    cursor,
    limit,
    has_more: rows.length > limit,
    next_cursor: rows.length > limit ? cursor + limit : null,
  };
}
function takePage(rows, limit) {
  return rows.length > limit ? rows.slice(0, limit) : rows;
}

function normalizeBootstrapThemeAssets(themeEntry, theme) {
  const assets = Array.isArray(themeEntry.assets)
    ? themeEntry.assets
    : Array.isArray(theme.assets)
    ? theme.assets
    : [];
  return assets.map((asset) => ({
    asset_hash: asset.asset_hash || asset.hash,
    asset_type: asset.asset_type || asset.assetType || "wallpaper",
    slot: asset.slot || "default",
    filename: asset.filename,
    mime_type: asset.mime_type || asset.mime,
    size_bytes: asset.size_bytes || asset.sizeBytes || 0,
    checksum: asset.checksum || asset.asset_hash || asset.hash,
    storage_path: asset.storage_path || asset.storagePath || null,
    relative_path: asset.relative_path || asset.relativePath || null,
  }));
}

function loadThemeAssetsForExport(db, themeId) {
  return listThemeAssets(db, themeId).map((asset) => ({
    asset_hash: asset.asset_hash,
    asset_type: asset.asset_type,
    slot: asset.slot,
    filename: asset.filename,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    checksum: asset.checksum,
    relative_path: asset.relative_path || null,
    download_url: asset.download_url,
    binary_strategy: "download_by_hash",
  }));
}

function configOwnerIdentity(configPayload = {}) {
  const schema = configPayload.schema;
  if (schema !== "agent_config" && schema !== "group_config") return null;
  const entityId = String(
    configPayload.entity_id || configPayload.relative_path || ""
  ).replace(/\\/g, "/");
  const match = /^(Agents|AgentGroups)\/([^/]+)\/config\.json$/i.exec(entityId);
  if (!match) return null;
  return {
    item_type: match[1].toLowerCase() === "agentgroups" ? "group" : "agent",
    item_id: match[2],
  };
}

function loadTopicsForConfigExport(db, owner) {
  if (!owner || !owner.item_type || !owner.item_id) return [];
  return db
    .prepare(
      `SELECT * FROM topics
       WHERE deleted = 0 AND item_type = ? AND item_id = ?
       ORDER BY COALESCE(order_rank, 2147483647), created_at, id`
    )
    .all(owner.item_type, owner.item_id)
    .map((row) => {
      const metadata = parseJson(row.metadata_json, {});
      return {
        id: row.id,
        topic_id: row.id,
        title: row.title,
        name: metadata.name || metadata.title || row.title || row.id,
        metadata,
        order_rank:
          row.order_rank === undefined || row.order_rank === null
            ? null
            : Number(row.order_rank),
        msg_count:
          row.msg_count === undefined || row.msg_count === null
            ? undefined
            : Number(row.msg_count),
        created_at: row.created_at,
        updated_at: row.updated_at,
        content_updated_at: row.content_updated_at,
        order_updated_at: row.order_updated_at,
      };
    });
}

function backfillConfigTopicsForExport(db, config) {
  const profile = config.profile || "bootstrap";
  if (profile === "runtime") return config;
  const owner = configOwnerIdentity(config);
  if (!owner) return config;
  const topics = loadTopicsForConfigExport(db, owner);
  return {
    ...config,
    safe_projection_json: {
      ...(config.safe_projection_json || {}),
      topics,
    },
  };
}

function deriveBootstrapTopicsFromConfigs(db, configs, deviceId) {
  const seen = new Set();
  for (const config of configs) {
    const payload = config.payload || config;
    const owner = configOwnerIdentity(payload);
    if (!owner) continue;
    const dto =
      payload.safe_projection_json || payload.dto || payload.config || {};
    const topics = Array.isArray(dto.topics) ? dto.topics : [];
    if (topics.length === 0) continue;
    ensureItem(db, owner.item_type, owner.item_id, {
      title: dto.name || owner.item_id,
      source: "bootstrap_config_topics",
    });
    for (const topic of topics) {
      const topicId = topic && (topic.id || topic.topic_id || topic.topicId);
      if (!topicId) continue;
      const key = `${owner.item_type}:${owner.item_id}:${topicId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      applyTopicUpsert(db, {
        operation_id: `bootstrap.topic.${deviceId || "unknown"}.${
          owner.item_type
        }.${owner.item_id}.${topicId}`,
        device_id: deviceId,
        entity_type: "topic",
        entity_id: topicId,
        item_type: owner.item_type,
        item_id: owner.item_id,
        topic_id: topicId,
        action: "upsert",
        payload: { topic },
      });
    }
  }
  return seen.size;
}

function importBootstrap(runtime, manifest = {}) {
  const db = runtime.dbContext.db;
  const deviceId = manifest.device_id || manifest.deviceId || null;
  const mode = manifest.mode || "bootstrap_primary";
  if (mode === "bootstrap_primary" && !centerIsEmpty(db)) {
    throw new Error("center is not empty; bootstrap_primary refused");
  }
  const messages = Array.isArray(manifest.messages) ? manifest.messages : [];
  const configs = Array.isArray(manifest.configs) ? manifest.configs : [];
  const attachments = Array.isArray(manifest.attachments)
    ? manifest.attachments
    : [];
  const avatars = Array.isArray(manifest.avatars) ? manifest.avatars : [];
  const themes = Array.isArray(manifest.themes) ? manifest.themes : [];
  const conflicts = Array.isArray(manifest.conflicts) ? manifest.conflicts : [];
  const sessionId = startBootstrapSession(db, manifest, {
    messages: messages.length,
    configs: configs.length,
    attachments: attachments.length,
    avatars: avatars.length,
    themes: themes.length,
    conflicts: conflicts.length,
  });

  const tx = db.transaction(() => {
    if (deviceId) {
      registerDevice(db, {
        device_id: deviceId,
        name: manifest.device_name || manifest.deviceName || deviceId,
        platform: manifest.platform || null,
        trusted: true,
        metadata: { bootstrap_mode: mode },
      });
    }

    for (const config of configs) {
      const payload = config.payload || config;
      applyConfigOperation(db, {
        operation_id:
          payload.operation_id ||
          `bootstrap.config.${deviceId || "unknown"}.${payload.schema}.${
            payload.entity_id
          }`,
        device_id: deviceId,
        entity_type: payload.schema,
        entity_id: payload.entity_id || payload.relative_path,
        action: "create",
        payload,
      });
    }

    deriveBootstrapTopicsFromConfigs(db, configs, deviceId);

    for (const entry of messages) {
      const message = entry.message || entry.raw_json || entry;
      applyCreate(db, {
        operation_id:
          entry.operation_id ||
          `bootstrap.message.${deviceId || "unknown"}.${entry.item_type}.${
            entry.item_id
          }.${entry.topic_id}.${message.id}`,
        device_id: deviceId,
        entity_type: "message",
        entity_id: message.id || entry.id,
        item_type: entry.item_type || message.item_type,
        item_id: entry.item_id || message.item_id,
        topic_id: entry.topic_id || message.topic_id,
        action: "create",
        payload: {
          item: entry.item || null,
          topic: entry.topic || null,
          message,
          local_order: entry.local_order,
          attachments: entry.attachments || message.attachments || [],
        },
      });
    }

    const seenAttachmentOperationIds = new Set();
    for (const attachment of attachments) {
      const hash = String(attachment.hash || "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const operationId =
        attachment.operation_id ||
        `bootstrap.attachment.${deviceId || "unknown"}.${hash}`;
      if (seenAttachmentOperationIds.has(operationId)) continue;
      seenAttachmentOperationIds.add(operationId);
      db.prepare(
        `
INSERT INTO attachments(hash, algorithm, size_bytes, mime_type, ext, storage_path, metadata_json)
VALUES (?, 'sha256', ?, ?, ?, ?, ?)
ON CONFLICT(hash) DO UPDATE SET
  size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE attachments.size_bytes END,
  mime_type = COALESCE(excluded.mime_type, attachments.mime_type),
  ext = COALESCE(NULLIF(excluded.ext, ''), attachments.ext),
  storage_path = COALESCE(NULLIF(attachments.storage_path, ''), excluded.storage_path),
  metadata_json = excluded.metadata_json,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`
      ).run(
        hash,
        Number(attachment.size_bytes || attachment.sizeBytes || 0),
        attachment.mime_type || attachment.mime || null,
        attachment.ext || "",
        attachment.storage_path || `bootstrap-missing/${hash}`,
        safeJsonStringify({
          filename: attachment.filename || null,
          relative_path: attachment.relative_path || null,
          relative_paths: attachment.relative_paths || null,
          bootstrap_placeholder: true,
          uploaded_by: deviceId || null,
        })
      );
      insertBaselineChange(db, {
        operation_id: operationId,
        device_id: deviceId,
        entity_type: "attachment",
        entity_id: hash,
        action: "baseline",
        payload: { ...attachment, hash },
      });
    }

    for (const avatar of avatars) {
      applyAvatarOperation(db, {
        operation_id:
          avatar.operation_id ||
          `bootstrap.avatar.${deviceId || "unknown"}.${avatar.owner_type}:${
            avatar.owner_id
          }`,
        device_id: deviceId,
        entity_type: "avatar",
        entity_id: `${avatar.owner_type}:${avatar.owner_id}`,
        action: avatar.deleted ? "delete" : "create",
        payload: avatar,
      });
    }

    for (const themeEntry of themes) {
      const theme = themeEntry.theme || themeEntry.payload || themeEntry;
      const assets = normalizeBootstrapThemeAssets(themeEntry, theme);
      const packagePayload = {
        ...theme,
        device_id: deviceId || theme.device_id || theme.source_device_id,
      };
      upsertThemePackage(db, packagePayload);
      for (const asset of assets) {
        const metadata = upsertThemeAssetMetadata(db, {
          ...asset,
          theme_id: theme.theme_id,
          storage_path:
            asset.storage_path ||
            `bootstrap-missing/${asset.asset_hash || asset.hash}`,
        });
        insertBaselineChange(db, {
          operation_id:
            asset.operation_id ||
            `bootstrap.theme_asset.${deviceId || "unknown"}.${
              metadata.asset_hash
            }`,
          device_id: deviceId,
          entity_type: "theme_asset",
          entity_id: metadata.asset_hash,
          action: "baseline",
          version: 1,
          payload: {
            ...metadata,
            binary_available: metadata.binary_available === true,
            binary_strategy:
              metadata.binary_available === true ? "local" : "download_by_hash",
          },
        });
      }
      insertBaselineChange(db, {
        operation_id:
          theme.operation_id ||
          `bootstrap.theme_package.${deviceId || "unknown"}.${theme.theme_id}`,
        device_id: deviceId,
        entity_type: "theme_package",
        entity_id: theme.theme_id,
        action: theme.deleted ? "delete" : "baseline",
        version: theme.version || 1,
        payload: packagePayload,
      });
    }

    for (const conflict of conflicts) {
      db.prepare(
        `INSERT INTO conflicts(operation_id, device_id, entity_type, entity_key, base_version, incoming_json, current_json, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(
        conflict.operation_id || `bootstrap.conflict.${Date.now()}`,
        deviceId,
        conflict.entity_type || conflict.type || "bootstrap",
        conflict.entity_key || conflict.normalized_id || "unknown",
        conflict.base_version || null,
        safeJsonStringify(conflict.incoming || conflict),
        safeJsonStringify(conflict.current || null)
      );
    }

    return getLatestSeq(db);
  });

  let latestSeq = 0;
  try {
    latestSeq = tx();
    updateBootstrapSession(
      db,
      sessionId,
      "completed",
      {
        stage: "completed",
        latest_seq: latestSeq,
        imported: {
          messages: messages.length,
          configs: configs.length,
          attachments: attachments.length,
          avatars: avatars.length,
          themes: themes.length,
          conflicts: conflicts.length,
        },
      },
      { mode, device_id: deviceId }
    );
  } catch (error) {
    updateBootstrapSession(
      db,
      sessionId,
      "failed",
      { stage: "failed", error: error.message },
      { mode, device_id: deviceId }
    );
    throw error;
  }
  audit(runtime, "import", {
    mode,
    session_id: sessionId,
    device_id: deviceId,
    messages: messages.length,
    configs: configs.length,
    attachments: attachments.length,
    avatars: avatars.length,
    themes: themes.length,
    conflicts: conflicts.length,
    latest_seq: latestSeq,
  });
  return {
    ok: true,
    mode,
    session_id: sessionId,
    imported: {
      messages: messages.length,
      configs: configs.length,
      attachments: attachments.length,
      avatars: avatars.length,
      themes: themes.length,
      conflicts: conflicts.length,
    },
    latest_seq: latestSeq,
  };
}

function exportBaseline(runtime, options = {}) {
  const db = runtime.dbContext.db;
  const afterSeq = Math.max(Number(options.after_seq || 0) || 0, 0);
  const limit = Math.min(
    Math.max(Number(options.limit || 5000) || 5000, 1),
    runtime.config.maxLimit || 5000
  );
  const kind = String(options.kind || "all").toLowerCase();
  const cursor = parseCursor(options.cursor);
  const pageLimit = limit + 1;

  const loadMessages = kind === "all" || kind === "messages";
  const loadTopics = kind === "all" || kind === "topics";
  const loadConfigs = kind === "all" || kind === "configs";
  const loadAttachments = kind === "all" || kind === "attachments";
  const loadMessageAttachments =
    kind === "all" ||
    kind === "message_attachments" ||
    kind === "messageattachments";
  const loadAvatars = kind === "all" || kind === "avatars";
  const loadThemes = kind === "all" || kind === "themes";

  const topicRows = loadTopics
    ? db
        .prepare(
          `SELECT * FROM topics WHERE deleted = 0 ORDER BY item_type, item_id, COALESCE(order_rank, 2147483647), created_at, id LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const topics = takePage(topicRows, limit).map((row) => {
    const metadata = parseJson(row.metadata_json, {});
    return {
      item_type: row.item_type,
      item_id: row.item_id,
      owner_type: row.item_type,
      owner_id: row.item_id,
      id: row.id,
      topic_id: row.id,
      title: row.title,
      name: metadata.name || metadata.title || row.title || row.id,
      metadata,
      version: row.version,
      order_rank:
        row.order_rank === undefined || row.order_rank === null
          ? null
          : Number(row.order_rank),
      msg_count:
        row.msg_count === undefined || row.msg_count === null
          ? undefined
          : Number(row.msg_count),
      created_at: row.created_at,
      updated_at: row.updated_at,
      content_updated_at: row.content_updated_at,
      order_updated_at: row.order_updated_at,
    };
  });

  const messageRows = loadMessages
    ? db
        .prepare(
          `SELECT * FROM messages WHERE deleted = 0 ORDER BY item_type, item_id, topic_id, COALESCE(local_order, 2147483647), server_seq, id LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const messages = takePage(messageRows, limit).map((row) => ({
    item_type: row.item_type,
    item_id: row.item_id,
    topic_id: row.topic_id,
    id: row.id,
    version: row.version,
    message: parseJson(row.raw_json, null),
    checksum: row.checksum,
    local_order:
      row.local_order === undefined || row.local_order === null
        ? null
        : Number(row.local_order),
  }));
  const configRows = loadConfigs
    ? db
        .prepare(
          `SELECT * FROM config_entities WHERE deleted = 0 AND COALESCE(profile, 'bootstrap') IN ('bootstrap', 'runtime') ORDER BY schema, entity_id, COALESCE(profile, 'bootstrap') LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const configs = takePage(configRows, limit).map((row) =>
    backfillConfigTopicsForExport(db, {
      schema: row.schema,
      entity_id: row.entity_id,
      dto_version: row.dto_version,
      safe_projection_json: parseJson(row.safe_projection_json, {}),
      profile: row.profile || "bootstrap",
      projection_fields: parseJson(row.projection_fields_json, []),
      checksum: row.checksum,
      version: row.version,
    })
  );
  const attachmentRows = loadAttachments
    ? db
        .prepare(`SELECT * FROM attachments ORDER BY hash LIMIT ? OFFSET ?`)
        .all(pageLimit, cursor)
    : [];

  const attachments = takePage(attachmentRows, limit).map((row) => ({
    hash: row.hash,
    algorithm: row.algorithm,
    size_bytes: row.size_bytes,
    mime_type: row.mime_type,
    ext: row.ext,
    storage_path: row.storage_path,
    metadata: parseJson(row.metadata_json, {}),
  }));
  const messageAttachmentRows = loadMessageAttachments
    ? db
        .prepare(
          `SELECT * FROM message_attachments ORDER BY item_type, item_id, topic_id, message_id, sort_order, attachment_hash LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const message_attachments = takePage(messageAttachmentRows, limit).map(
    (row) => ({
      item_type: row.item_type,
      item_id: row.item_id,
      topic_id: row.topic_id,
      msg_id: row.message_id,
      message_id: row.message_id,
      hash: row.attachment_hash,
      attachment_hash: row.attachment_hash,
      attachment_order: Number(row.sort_order || 0),
      usage: row.usage,
      metadata: parseJson(row.metadata_json, {}),
      created_at: row.created_at,
    })
  );
  const avatarRows = loadAvatars
    ? db
        .prepare(
          `SELECT * FROM avatars WHERE deleted = 0 ORDER BY owner_type, owner_id LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const avatars = takePage(avatarRows, limit).map((row) => ({
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    hash: row.hash,
    mime_type: row.mime_type,
    ext: row.ext,
    relative_path: row.relative_path,
    metadata: parseJson(row.metadata_json, {}),
    version: row.version,
  }));
  const themeRows = loadThemes
    ? db
        .prepare(
          `SELECT * FROM theme_packages WHERE deleted = 0 ORDER BY updated_at DESC, theme_id LIMIT ? OFFSET ?`
        )
        .all(pageLimit, cursor)
    : [];
  const themes = takePage(themeRows, limit).map((row) => {
    const assets = loadThemeAssetsForExport(db, row.theme_id);
    return {
      theme_id: row.theme_id,
      display_name: row.display_name,
      version: row.version,
      source_device_id: row.source_device_id,
      mode: row.mode,
      variables: {
        dark: parseJson(row.variables_dark_json, {}),
        light: parseJson(row.variables_light_json, {}),
      },
      extra_css: row.extra_css || "",
      manifest_json: parseJson(row.manifest_json, {}),
      manifest: parseJson(row.manifest_json, {}),
      assets,
      asset_count: assets.length,
      binary_strategy: "download_assets_by_hash",
      checksum: row.checksum,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
  const changes = afterSeq > 0 ? getChanges(db, afterSeq, limit) : [];
  return {
    ok: true,
    exported_at: new Date().toISOString(),
    latest_seq: getLatestSeq(db),
    after_seq: afterSeq,
    changes,
    has_more_changes:
      changes.length === limit &&
      changes.length > 0 &&
      changes[changes.length - 1].seq < getLatestSeq(db),
    next_after_seq:
      changes.length > 0 ? changes[changes.length - 1].seq : afterSeq,
    page: {
      kind,
      messages: buildPageInfo("messages", cursor, limit, messageRows),
      topics: buildPageInfo("topics", cursor, limit, topicRows),
      configs: buildPageInfo("configs", cursor, limit, configRows),
      attachments: buildPageInfo("attachments", cursor, limit, attachmentRows),
      message_attachments: buildPageInfo(
        "message_attachments",
        cursor,
        limit,
        messageAttachmentRows
      ),
      avatars: buildPageInfo("avatars", cursor, limit, avatarRows),
      themes: buildPageInfo("themes", cursor, limit, themeRows),
    },
    baseline: {
      topics,
      messages,
      configs,
      attachments,
      message_attachments,
      avatars,
      themes,
    },
  };
}

module.exports = {
  requireBootstrapAuth,
  centerIsEmpty,
  importBootstrap,
  exportBaseline,
};
