function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return null;
  }
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableJsonStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
    .join(",")}}`;
}

module.exports = {
  safeJsonParse,
  safeJsonStringify,
  stableJsonStringify,
};
