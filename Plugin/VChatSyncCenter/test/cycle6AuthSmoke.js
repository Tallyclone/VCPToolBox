const assert = require("assert");
const { validateSyncAuth } = require("../core/auth");

function main() {
  const runtime = {
    config: { enabled: true, syncKey: "super-secret-key" },
  };

  assert.strictEqual(
    validateSyncAuth(runtime, {
      headers: { authorization: "Bearer super-secret-key" },
    }).ok,
    true
  );

  assert.strictEqual(
    validateSyncAuth(runtime, {
      headers: { "x-vchat-sync-key": "super-secret-key" },
    }).ok,
    true
  );

  const queryOnly = validateSyncAuth(runtime, {
    headers: {},
    query: { token: "super-secret-key" },
  });
  assert.strictEqual(queryOnly.ok, false);
  assert.strictEqual(queryOnly.status, 403);

  const disabled = validateSyncAuth(
    { config: { enabled: false, syncKey: "super-secret-key" } },
    { headers: { authorization: "Bearer super-secret-key" } }
  );
  assert.strictEqual(disabled.ok, false);
  assert.strictEqual(disabled.status, 404);

  console.log("cycle6 auth smoke test passed");
}

main();
