const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const networkApi = require("../api/network-handler");

test("nested ADVIS network status requests reach the Express API", async t => {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url || "/", "http://localhost");
    if (parsed.pathname.startsWith("/api/network/")) {
      const route = parsed.pathname.slice("/api/network/".length);
      parsed.searchParams.set("__advis_path", route);
      req.url = "/api/network-handler?" + parsed.searchParams.toString();
    }
    void networkApi(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/network/status?probe=route-test`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, "Firestore");
  assert.equal(typeof body.configured, "boolean");
  assert.equal(typeof body.databaseConnected, "boolean");
  assert.equal(typeof body.state, "string");
});

test("network API handler rejects malformed reconstructed paths", async t => {
  const server = http.createServer((req, res) => void networkApi(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/network-handler?__advis_path=..%2Fprivate`);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /Invalid ADVIS network route/);
});
