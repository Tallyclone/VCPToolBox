function redactValue(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/(token|key|password)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const output = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/token|key|password|secret|authorization/i.test(key)) {
      output[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      output[key] = redactValue(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function createLogger(options = {}) {
  const debug = !!options.debug;
  const vcpLogFunctions = options.vcpLogFunctions || null;

  function write(level, message, meta) {
    const safeMeta = sanitizeMeta(meta);
    const line = `[VChatSyncCenter] ${message}`;
    if (level === 'error') console.error(line, safeMeta || '');
    else if (level === 'warn') console.warn(line, safeMeta || '');
    else if (debug || level === 'info') console.log(line, safeMeta || '');

    if (vcpLogFunctions && typeof vcpLogFunctions.pushVcpInfo === 'function') {
      vcpLogFunctions.pushVcpInfo({ plugin: 'VChatSyncCenter', level, message, meta: safeMeta, time: new Date().toISOString() });
    }
  }

  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    debug: (message, meta) => { if (debug) write('debug', message, meta); },
  };
}

module.exports = {
  createLogger,
  sanitizeMeta,
};
