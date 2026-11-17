const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createFirebaseMemoryStore } = require("../src/FirebaseMemoryStore.js");

test("network command polling reads and expires only the recipient device queue", async () => {
  const previousAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const previousProject = process.env.FIREBASE_PROJECT_ID;
  const previousFetch = global.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: "advis-test",
    client_email: "advis-test@example.iam.gserviceaccount.com",
    private_key: privateKey
  });
  process.env.FIREBASE_PROJECT_ID = "advis-test";

  const now = Date.now();
  const active = { id: "cmd_active", expiresAt: now + 60_000, targetDeviceId: "device_target_123456789" };
  const expired = { id: "cmd_expired", expiresAt: now - 1, targetDeviceId: "device_target_123456789" };
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed, method: options.method || "GET" });
    if (parsed.hostname === "oauth2.googleapis.com") {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if (options.method === "DELETE") return new Response(null, { status: 200 });
    return new Response(JSON.stringify({
      documents: [active, expired].map(command => ({
        name: "projects/advis-test/databases/(default)/documents/" + parsed.pathname.split("/documents/")[1] + "/" + command.id,
        fields: { payload: { stringValue: JSON.stringify(command) } }
      }))
    }), { status: 200 });
  };

  try {
    const store = createFirebaseMemoryStore();
    const commands = await store.listNetworkCommands(
      "network_12345678901234567890",
      "device_target_123456789"
    );
    assert.deepEqual(commands, [active]);

    const queueRequest = requests.find(item => item.url.pathname.includes("/commands"));
    assert.ok(queueRequest);
    assert.match(queueRequest.url.pathname, /\/devices\/device_target_123456789\/commands$/);

    const expiredDelete = requests.find(item => item.method === "DELETE");
    assert.ok(expiredDelete, "expired command should be deleted opportunistically");
    assert.match(expiredDelete.url.pathname, /\/commands\/cmd_expired$/);
  } finally {
    global.fetch = previousFetch;
    if (previousAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previousAccount;
    if (previousProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = previousProject;
  }
});
