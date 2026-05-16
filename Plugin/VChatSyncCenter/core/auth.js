const crypto = require("crypto");

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBearerToken(req) {
  const headers = (req && req.headers) || {};
  const header = headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1];
  return headers["x-vchat-sync-key"] || "";
}

function validateSyncAuth(runtime, req) {
  if (!runtime.config.enabled) {
    return { ok: false, status: 404, error: "VChatSyncCenter is disabled" };
  }

  const configuredKey = runtime.config.syncKey;
  if (!configuredKey || configuredKey === "change-me") {
    return {
      ok: false,
      status: 403,
      error: "VChatSyncCenter sync key is not configured",
    };
  }

  const token = readBearerToken(req);
  if (!timingSafeEqualString(token, configuredKey)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true };
}

function requireSyncAuth(runtime) {
  return (req, res, next) => {
    const result = validateSyncAuth(runtime, req);
    if (!result.ok) {
      if (runtime.logger && result.status === 403) {
        runtime.logger.warn("Rejected unauthorized VChatSyncCenter request", {
          path: req.path,
          ip: req.ip,
        });
      }
      return res.status(result.status).json({ ok: false, error: result.error });
    }

    return next();
  };
}

module.exports = {
  requireSyncAuth,
  validateSyncAuth,
};
