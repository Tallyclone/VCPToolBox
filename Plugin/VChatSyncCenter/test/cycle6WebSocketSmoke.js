const assert = require("assert");
const http = require("http");
const WebSocket = require("ws");
const webSocketServer = require("../../../WebSocketServer");

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForCloseOrError(ws) {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("close"));
    ws.once("error", () => resolve("error"));
  });
}

async function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
    ws.once("error", reject);
  });
}

async function main() {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  webSocketServer.initialize(server, { debugMode: false, vcpKey: "host-key" });
  webSocketServer.registerVChatSyncAuthValidator((req) => {
    const header = (req.headers && req.headers.authorization) || "";
    return header === "Bearer sync-key";
  });

  const missingAuthWs = new WebSocket(
    `ws://127.0.0.1:${port}/vchat-sync/latest-seq`
  );
  assert.notStrictEqual(await waitForCloseOrError(missingAuthWs), "open");

  const wrongAuthWs = new WebSocket(
    `ws://127.0.0.1:${port}/vchat-sync/latest-seq`,
    { headers: { Authorization: "Bearer wrong" } }
  );
  assert.notStrictEqual(await waitForCloseOrError(wrongAuthWs), "open");

  const ws = new WebSocket(`ws://127.0.0.1:${port}/vchat-sync/latest-seq`, {
    headers: { Authorization: "Bearer sync-key" },
  });
  await waitForOpen(ws);

  const sent = webSocketServer.broadcastVChatSyncLatestSeq(42, {
    operation_id: "op-42",
  });
  assert.strictEqual(sent, 1);

  const message = await waitForMessage(ws);
  assert.strictEqual(message.type, "vchat_sync_latest_seq");
  assert.strictEqual(message.latest_seq, 42);
  assert.strictEqual(message.data.operation_id, "op-42");

  ws.close();
  await webSocketServer.shutdown();
  await new Promise((resolve) => server.close(resolve));
  console.log("cycle6 websocket latest_seq smoke test passed");
}

main().catch(async (error) => {
  console.error(error);
  try {
    await webSocketServer.shutdown();
  } catch (_) {}
  process.exit(1);
});
