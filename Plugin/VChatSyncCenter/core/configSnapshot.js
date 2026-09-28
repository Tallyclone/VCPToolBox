const { CONFIG_SCHEMAS } = require("./configSchema");
const { sha256 } = require("../utils/checksum");
const {
  safeJsonParse,
  safeJsonStringify,
  stableJsonStringify,
} = require("../utils/safeJson");

function buildConfigChecksumSource(input) {
  return {
    dto_version: Number(input.dto_version || 1),
    schema: input.schema,
    entity_id: input.entity_id,
    safe_projection_json: input.safe_projection_json,
    projection_fields: Array.isArray(input.projection_fields)
      ? input.projection_fields
      : undefined,
    deleted_fields: Array.isArray(input.deleted_fields)
      ? input.deleted_fields
      : undefined,
    profile: input.profile || "bootstrap",
  };
}

function checksumConfigDto(input) {
  return sha256(stableJsonStringify(buildConfigChecksumSource(input)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function orderedFields(fields) {
  return [...new Set(fields)].sort((a, b) => {
    const depth = a.split(".").length - b.split(".").length;
    return depth || (a < b ? -1 : a > b ? 1 : 0);
  });
}

function pathParts(field) {
  const parts = String(field).split(".");
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new Error(`unsafe config projection path: ${field}`);
  }
  return parts;
}

function valueAt(source, field) {
  let value = source;
  for (const part of pathParts(field)) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { present: false };
    }
    value = value[part];
  }
  return { present: true, value };
}

function setAt(target, field, value) {
  const parts = pathParts(field);
  let parent = target;
  for (const part of parts.slice(0, -1)) {
    if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) {
      parent[part] = {};
    }
    parent = parent[part];
  }
  parent[parts[parts.length - 1]] = clone(value);
}

function deleteAt(target, field, projectedFields) {
  const parts = pathParts(field);
  const parents = [target];
  let parent = target;
  for (const part of parts.slice(0, -1)) {
    if (!parent[part] || typeof parent[part] !== "object") return;
    parent = parent[part];
    parents.push(parent);
  }
  delete parent[parts[parts.length - 1]];
  // Keep an explicitly projected empty object: replacing that parent must still
  // erase older bootstrap children. Undeclared empty containers are omitted:
  // declaring them would overwrite client siblings outside this projection.
  for (let i = parents.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join(".");
    if (Object.keys(parents[i]).length || projectedFields.has(prefix)) break;
    delete parents[i - 1][parts[i - 1]];
  }
}

function effectiveFields(snapshot) {
  if (Array.isArray(snapshot.projection_fields)) return snapshot.projection_fields;
  const definition = CONFIG_SCHEMAS[snapshot.schema];
  return definition ? [...definition.allowed].filter((field) => !field.includes(".")) : [];
}

// The change log keeps the submitted patch. This separate representation is the
// cumulative projection a new device needs after applying its bootstrap row.
function materializeConfigSnapshot(previous, input) {
  const snapshot = {
    dto_version: Number(input.dto_version || 1),
    schema: input.schema,
    entity_id: input.entity_id,
    profile: input.profile || "bootstrap",
    projection_fields: input.projection_fields,
    deleted_fields: input.deleted_fields || [],
    safe_projection_json: clone(input.safe_projection_json || {}),
  };
  if (snapshot.profile === "runtime" && !CONFIG_SCHEMAS[snapshot.schema]?.wholeDocument) {
    const incomingDeleted = new Set(snapshot.deleted_fields);
    // Declaring an absent runtime field is a no-op, not authority over a
    // container already populated by an earlier child projection.
    const incomingFields = effectiveFields(snapshot).filter(
      (field) => incomingDeleted.has(field) || valueAt(snapshot.safe_projection_json, field).present
    );
    const fields = new Set([...(previous ? effectiveFields(previous) : []), ...incomingFields]);
    const dto = clone(previous?.safe_projection_json || {});
    const deleted = new Set(previous?.deleted_fields || []);
    for (const field of incomingFields) {
      const value = valueAt(snapshot.safe_projection_json, field);
      if (incomingDeleted.has(field)) {
        deleteAt(dto, field, fields);
        for (const old of deleted) {
          if (old.startsWith(`${field}.`)) deleted.delete(old);
        }
        deleted.add(field);
      } else if (value.present) {
        setAt(dto, field, value.value);
        for (const old of deleted) {
          if (
            old === field ||
            old.startsWith(`${field}.`) ||
            field.startsWith(`${old}.`)
          ) deleted.delete(old);
        }
        // A restored child makes its previously deleted ancestor an explicit
        // object replacement. The ancestor remains in fields, so old bootstrap
        // siblings stay removed and deleting the final child can retain {}.
      }
    }
    snapshot.safe_projection_json = dto;
    snapshot.projection_fields = orderedFields([...fields]);
    snapshot.deleted_fields = orderedFields([...deleted]);
  }
  snapshot.checksum = checksumConfigDto(snapshot);
  return snapshot;
}

function configSnapshotFromRow(row) {
  return {
    schema: row.schema,
    entity_id: row.entity_id,
    dto_version: row.dto_version,
    profile: row.profile || "bootstrap",
    projection_fields: safeJsonParse(row.projection_fields_json, null),
    deleted_fields: safeJsonParse(row.deleted_fields_json, []),
    safe_projection_json: safeJsonParse(row.safe_projection_json, {}),
    checksum: row.checksum,
    version: row.version,
  };
}

function rebuildConfigSnapshots(db) {
  const rows = db.prepare("SELECT * FROM config_entities WHERE deleted = 0").all();
  const history = db.prepare(
    "SELECT entity_id, action, payload_json FROM change_log WHERE entity_type = ? AND (entity_id = ? OR entity_id = ?) ORDER BY seq"
  );
  const update = db.prepare(
    `UPDATE config_entities SET safe_projection_json = ?, projection_fields_json = ?,
     deleted_fields_json = ?, checksum = ? WHERE schema = ? AND entity_id = ? AND profile = ?`
  );
  for (const row of rows) {
    if (!CONFIG_SCHEMAS[row.schema]) continue;
    const current = configSnapshotFromRow(row);
    let snapshot = null;
    let lastPayload = null;
    for (const event of history.iterate(row.schema, row.entity_id, `${row.profile}:${row.entity_id}`)) {
      const payload = safeJsonParse(event.payload_json, null);
      if (!payload) continue;
      // v6 canonicalized row IDs but did not rewrite older change-log entries.
      // Only their explicit runtime:/manual: ID prefix can replace a missing
      // profile; an unprefixed event without metadata is still bootstrap.
      const legacyProfile =
        ["runtime", "manual"].includes(current.profile) &&
        event.entity_id === `${current.profile}:${row.entity_id}`
          ? current.profile
          : "bootstrap";
      const eventProfile = payload.profile || legacyProfile;
      if (eventProfile !== current.profile) continue;
      if (event.action === "delete") {
        // Legacy member removals used a cascaded config "delete" event while
        // leaving the config itself active. Replay the edit, not an entity reset.
        if (row.schema === "group_config" && payload.cascaded_from === "group_member") {
          if (snapshot && payload.removed_member_id) {
            const memberId = String(payload.removed_member_id);
            const dto = clone(snapshot.safe_projection_json);
            if (Array.isArray(dto.members)) {
              dto.members = dto.members.filter((id) => String(id) !== memberId);
            }
            if (dto.memberTags && typeof dto.memberTags === "object" && !Array.isArray(dto.memberTags)) {
              delete dto.memberTags[memberId];
            }
            snapshot = { ...snapshot, safe_projection_json: dto };
          }
          continue;
        }
        snapshot = null;
        lastPayload = null;
        continue;
      }
      if (!["create", "update", "baseline"].includes(event.action) || !payload.safe_projection_json) continue;
      lastPayload = {
        ...payload,
        schema: row.schema,
        entity_id: row.entity_id,
        profile: eventProfile,
      };
      snapshot = materializeConfigSnapshot(snapshot, lastPayload);
    }
    // No usable history means there is nothing additional to recover. Leave
    // legacy rows (and their checksums) intact instead of inventing a baseline.
    if (!snapshot) continue;
    snapshot = materializeConfigSnapshot(snapshot, {
      ...current,
      deleted_fields: current.profile === "runtime"
        ? current.deleted_fields
        : lastPayload.deleted_fields || current.deleted_fields,
    });
    update.run(
      safeJsonStringify(snapshot.safe_projection_json),
      safeJsonStringify(snapshot.projection_fields ?? null),
      safeJsonStringify(snapshot.deleted_fields),
      snapshot.checksum,
      row.schema,
      row.entity_id,
      row.profile
    );
  }
}

module.exports = {
  buildConfigChecksumSource,
  checksumConfigDto,
  materializeConfigSnapshot,
  configSnapshotFromRow,
  rebuildConfigSnapshots,
};
