function runIntegrityCheck(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  const value = row ? Object.values(row)[0] : 'unknown';
  return value === 'ok' ? 'ok' : String(value || 'unknown');
}

module.exports = {
  runIntegrityCheck,
};
