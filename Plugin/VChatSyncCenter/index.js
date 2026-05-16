const { createSyncRoutes } = require("./routes/syncRoutes");
const { createLogger } = require("./utils/logger");
const { buildRuntimeConfig } = require("./core/config");
const { ensureDatabase, closeDatabase } = require("./core/db");
const { validateSyncAuth } = require("./core/auth");

let runtime = null;

async function initialize(pluginConfig = {}, dependencies = {}) {
  const config = buildRuntimeConfig(
    pluginConfig,
    pluginConfig.PROJECT_BASE_PATH || process.cwd()
  );
  const logger = createLogger({
    debug: !!config.debug,
    vcpLogFunctions: dependencies.vcpLogFunctions,
  });

  runtime = {
    config,
    logger,
    dbContext: null,
    initializedAt: new Date().toISOString(),
    initError: null,
    webSocketServer: null,
  };

  try {
    runtime.dbContext = ensureDatabase(config, logger);
    logger.info("VChatSyncCenter initialized", {
      enabled: config.enabled,
      dbPath: config.dbPath,
      attachmentDir: config.attachmentDir,
    });
  } catch (error) {
    runtime.initError = error;
    logger.error("VChatSyncCenter initialization failed", {
      error: error.message,
    });
    throw error;
  }
}

function registerApiRoutes(
  router,
  pluginConfig = {},
  projectBasePath,
  webSocketServer
) {
  if (!runtime) {
    const config = buildRuntimeConfig(
      { ...pluginConfig, PROJECT_BASE_PATH: projectBasePath },
      projectBasePath
    );
    const logger = createLogger({ debug: !!config.debug });
    runtime = {
      config,
      logger,
      dbContext: null,
      initializedAt: new Date().toISOString(),
      initError: null,
      webSocketServer: null,
    };
    try {
      runtime.dbContext = ensureDatabase(config, logger);
    } catch (error) {
      runtime.initError = error;
      logger.error("VChatSyncCenter lazy initialization failed", {
        error: error.message,
      });
    }
  }

  runtime.webSocketServer = webSocketServer || null;
  if (
    webSocketServer &&
    typeof webSocketServer.registerVChatSyncAuthValidator === "function"
  ) {
    webSocketServer.registerVChatSyncAuthValidator((req) => {
      const result = validateSyncAuth(runtime, req);
      if (!result.ok && runtime.logger && runtime.logger.warn) {
        runtime.logger.warn(
          "Rejected unauthorized VChatSyncCenter websocket request",
          {
            status: result.status,
          }
        );
      }
      return result.ok === true;
    });
  }
  createSyncRoutes(router, runtime, { webSocketServer });
}

async function shutdown() {
  if (runtime && runtime.dbContext) {
    closeDatabase(runtime.dbContext);
  }
  runtime = null;
}

module.exports = {
  initialize,
  registerApiRoutes,
  shutdown,
};
