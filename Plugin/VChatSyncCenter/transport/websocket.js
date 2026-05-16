function initializeWebSocket(runtime) {
  runtime.logger.info('VChatSyncCenter standalone WebSocket transport is disabled in Cycle 0', { wsEnabled: runtime.config.wsEnabled });
  return null;
}

module.exports = {
  initializeWebSocket,
};
