const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchCloudflareIceServers,
  validateCloudflareTurnKeyId,
  validateCloudflareTurnKeyToken
} = require("../src/CloudflareTurn.cjs");

const KEY_ID = "a".repeat(32);
const KEY_TOKEN = "b".repeat(64);

test("Cloudflare TURN key identifiers and tokens are validated", () => {
  assert.equal(validateCloudflareTurnKeyId(KEY_ID), true);
  assert.equal(validateCloudflareTurnKeyId("invalid"), false);
  assert.equal(validateCloudflareTurnKeyToken(KEY_TOKEN), true);
  assert.equal(validateCloudflareTurnKeyToken("not-a-secret"), false);
});

test("Cloudflare ICE credentials are requested server-side and returned unchanged", async () => {
  let requestedUrl = "";
  let requestOptions;
  const expected = [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "temporary-user",
      credential: "temporary-password"
    }
  ];

  const result = await fetchCloudflareIceServers({
    keyId: KEY_ID,
    keyToken: KEY_TOKEN,
    ttlSeconds: 3600,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return { ok: true, json: async () => ({ iceServers: expected }) };
    }
  });

  assert.equal(requestedUrl, `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers.Authorization, `Bearer ${KEY_TOKEN}`);
  assert.deepEqual(JSON.parse(requestOptions.body), { ttl: 3600 });
  assert.deepEqual(result, expected);
});

test("Cloudflare TURN credential lifetime is clamped to 48 hours", async () => {
  let body;
  await fetchCloudflareIceServers({
    keyId: KEY_ID,
    keyToken: KEY_TOKEN,
    ttlSeconds: 999999,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ iceServers: [{ urls: "turns:turn.cloudflare.com:443" }] }) };
    }
  });
  assert.deepEqual(body, { ttl: 48 * 60 * 60 });
});

test("Cloudflare TURN helper rejects missing credentials and failed API responses", async () => {
  await assert.rejects(
    fetchCloudflareIceServers({ keyId: "", keyToken: KEY_TOKEN }),
    /key ID is missing or invalid/
  );
  await assert.rejects(
    fetchCloudflareIceServers({ keyId: KEY_ID, keyToken: "bad" }),
    /key token is missing or invalid/
  );
  await assert.rejects(
    fetchCloudflareIceServers({
      keyId: KEY_ID,
      keyToken: KEY_TOKEN,
      fetchImpl: async () => ({ ok: false, status: 401 })
    }),
    /HTTP 401/
  );
});

test("Cloudflare TURN helper rejects malformed ICE server payloads", async () => {
  await assert.rejects(
    fetchCloudflareIceServers({
      keyId: KEY_ID,
      keyToken: KEY_TOKEN,
      fetchImpl: async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "javascript:alert(1)" }] }) })
    }),
    /unsupported ICE server URL/
  );
});
