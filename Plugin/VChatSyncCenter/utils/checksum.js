const crypto = require('crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

module.exports = {
  sha256,
};
