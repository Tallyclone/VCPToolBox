const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const express = require("express");
const Database = require("better-sqlite3");
const { runMigrations } = require("../core/migrations");
const { createSyncRoutes } = require("../routes/syncRoutes");

function installHostAuth(app, serverKey) {
  // Execute the real host middleware without starting server.js and its
  // production services or loading any environment/configuration files.
  const source = fs.readFileSync(path.resolve(__dirname, "../../../server.js"), "utf8");
  const start = source.indexOf("// General API authentication (Bearer token)");
  const end = source.indexOf("// This function is no longer needed", start);
  assert(start >= 0 && end > start, "host auth middleware must be located");
  vm.runInNewContext(source.slice(start, end), { app, serverKey });
}

function request(server, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1", port: server.address().port,
      path: requestPath, headers, agent: false,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

async function withServer(app, action) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await action(server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main() {
  const db = new Database(":memory:");
  const logger = { info() {}, warn() {}, error() {} };
  runMigrations(db, logger);
  const sharedKey = "test-shared-host-sync-key";
  const runtime = {
    config: { enabled: true, syncKey: sharedKey, maxLimit: 1000 },
    dbContext: { db }, logger,
  };
  const namespace = "/api/plugins/VChatSyncCenter";
  const sharedHeader = { authorization: `Bearer ${sharedKey}` };
  const wrongHeader = { authorization: "Bearer wrong" };
  try {
    const app = express();
    installHostAuth(app, sharedKey);
    const router = express.Router();
    createSyncRoutes(router, runtime);
    app.use(namespace, router);
    app.get("/v1/models", (req, res) => res.json({ ok: true }));
    app.get("/api/plugins/:plugin/changes", (req, res) => res.json({ ok: true }));
    await withServer(app, async (server) => {
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 200);
      assert.strictEqual(await request(server, `${namespace}/changes?after_seq=0`, sharedHeader), 200);
      assert.strictEqual(await request(server, "/API/PLUGINS/vchatsynccenter/changes", sharedHeader), 200);
      assert.strictEqual(await request(server, `${namespace}/changes`), 401);
      assert.strictEqual(await request(server, `${namespace}/changes`, wrongHeader), 401);
      // The unchanged host requires its Bearer header before the plugin can
      // inspect its own key. The plugin-only header cannot replace it.
      assert.strictEqual(await request(server, `${namespace}/changes`, { "x-vchat-sync-key": sharedKey }), 401);

      runtime.config.syncKey = "different-sync-key";
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 401);
      assert.strictEqual(await request(server, `${namespace}/changes`, { authorization: "Bearer different-sync-key" }), 401);
      assert.strictEqual(await request(server, `${namespace}/changes`, {
        ...sharedHeader, "x-vchat-sync-key": "different-sync-key",
      }), 401);
      runtime.config.syncKey = sharedKey;
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 200);

      for (const neighbor of ["VChatSyncCenterOther", "VChatSyncCenter.json", "VChatSyncCenter%2FOther"]) {
        assert.strictEqual(await request(server, `/api/plugins/${neighbor}/changes`), 401);
        assert.strictEqual(await request(server, `/api/plugins/${neighbor}/changes`, wrongHeader), 401);
        assert.strictEqual(await request(server, `/api/plugins/${neighbor}/changes`, sharedHeader), 200);
      }
      assert.strictEqual(await request(server, "/v1/models"), 401);
      assert.strictEqual(await request(server, "/v1/models", wrongHeader), 401);
      assert.strictEqual(await request(server, "/v1/models", sharedHeader), 200);

      runtime.config.enabled = false;
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 404);
      assert.strictEqual(await request(server, `${namespace}/changes`), 401);
      runtime.config.enabled = true;
      runtime.config.syncKey = "change-me";
      assert.strictEqual(await request(server, `${namespace}/changes`, { authorization: "Bearer change-me" }), 401);
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 401);
      runtime.config.syncKey = "";
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 401);
    });

    const withoutPlugin = express();
    installHostAuth(withoutPlugin, sharedKey);
    await withServer(withoutPlugin, async (server) => {
      assert.strictEqual(await request(server, `${namespace}/changes`, sharedHeader), 404);
      assert.strictEqual(await request(server, `${namespace}/changes`), 401);
      assert.strictEqual(await request(server, `${namespace}/changes`, wrongHeader), 401);
    });
    console.log("cycle6 host auth smoke test passed");
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
