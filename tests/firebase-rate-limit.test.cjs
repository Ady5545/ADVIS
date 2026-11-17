const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createFirebaseMemoryStore } = require("../src/FirebaseMemoryStore.js");

test("Firestore rate limits atomically count requests and return retry windows", async () => {
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

  let record = null;
  let version = 0;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "oauth2.googleapis.com") {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    if ((options.method || "GET") === "GET") {
      if (!record) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      return new Response(JSON.stringify({
        updateTime: "version-" + version,
        fields: { payload: { stringValue: JSON.stringify(record) } }
      }), { status: 200 });
    }
    if (options.method === "PATCH") {
      record = JSON.parse(JSON.parse(options.body).fields.payload.stringValue);
      version += 1;
      return new Response(JSON.stringify({ updateTime: "version-" + version }), { status: 200 });
    }
    throw new Error("Unexpected Firestore method: " + options.method);
  };

  try {
    const store = createFirebaseMemoryStore();
    const networkId = "network_12345678901234567890";
    const deviceId = "device_123456789012345678";
    const first = await store.consumeNetworkRateLimit(networkId, deviceId, "send_command", 2, 60_000, 1000);
    const second = await store.consumeNetworkRateLimit(networkId, deviceId, "send_command", 2, 60_000, 2000);
    const third = await store.consumeNetworkRateLimit(networkId, deviceId, "send_command", 2, 60_000, 3000);

    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);
    assert.deepEqual(third, { allowed: false, remaining: 0, retryAfterMs: 58_000 });
    assert.equal(record.count, 2);
    assert.equal(record.windowStart, 1000);
  } finally {
    global.fetch = previousFetch;
    if (previousAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previousAccount;
    if (previousProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = previousProject;
  }
});
