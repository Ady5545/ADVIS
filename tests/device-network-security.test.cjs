const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { hashSecret, constantTimeHexEqual, safeNetworkId, safeDeviceId, createToken, createInvitationCode, createTurnCredentials } = require("../src/DeviceNetworkSecurity.cjs");

test("device tokens and invitation codes are high-entropy url-safe values", () => {
  const token = createToken();
  const invitation = createInvitationCode();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(invitation, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(token, invitation);
});

test("network secret comparisons are constant-time and reject mismatches", () => {
  const digest = hashSecret("trusted-device-secret");
  assert.equal(constantTimeHexEqual(digest, hashSecret("trusted-device-secret")), true);
  assert.equal(constantTimeHexEqual(digest, hashSecret("other-secret")), false);
  assert.equal(constantTimeHexEqual("", digest), false);
});

test("network and device identifiers are constrained", () => {
  assert.equal(safeNetworkId("network_12345678901234567890"), true);
  assert.equal(safeNetworkId("short"), false);
  assert.equal(safeDeviceId("device_123456789012345678"), true);
  assert.equal(safeDeviceId("bad id"), false);
});

test("TURN credentials are timestamped, bounded and server-secret derived", () => {
  const secret = "server-only-turn-shared-secret";
  const first = createTurnCredentials({ secret, deviceId: "device_123456789012345678", ttlSeconds: 600, nowSeconds: 1000 });
  const second = createTurnCredentials({ secret, deviceId: "device_123456789012345678", ttlSeconds: 600, nowSeconds: 1000 });
  const expectedUser = "1600:device_123456789012345678";
  const expectedCredential = crypto.createHmac("sha1", secret).update(expectedUser).digest("base64");
  assert.deepEqual(first, { username: expectedUser, credential: expectedCredential, expiresAt: 1600 });
  assert.deepEqual(second, first);
  assert.equal(createTurnCredentials({ secret: "", deviceId: "device_123456789012345678" }), null);
  assert.equal(createTurnCredentials({ secret, deviceId: "bad id" }), null);
});