const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSessionSignal, SESSION_LIFETIME_MS } = require("../src/DeviceNetworkSessionSecurity.cjs");

const base = {
  id: "sess_123456789012345678901234",
  networkId: "network_12345678901234567890",
  controllerDeviceId: "controller_123456789012",
  targetDeviceId: "target_12345678901234",
  status: "OFFERED",
  createdAt: 1000,
  updatedAt: 1000,
  expiresAt: 1000 + SESSION_LIFETIME_MS
};

test("only a fresh OFFER creates a session for an exact enrolled device pair", () => {
  const result = validateSessionSignal({
    session: null, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.controllerDeviceId, targetDeviceId: base.targetDeviceId,
    signalType: "OFFER", now: 1000
  });
  assert.equal(result.ok, true);
  assert.equal(result.createSession.status, "OFFERED");
  assert.equal(result.createSession.expiresAt, 1000 + SESSION_LIFETIME_MS);
});

test("an OFFER retry is idempotent but cannot reuse a session for another pair", () => {
  assert.equal(validateSessionSignal({
    session: base, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.controllerDeviceId, targetDeviceId: base.targetDeviceId,
    signalType: "OFFER", now: 1100
  }).duplicate, true);
  assert.equal(validateSessionSignal({
    session: base, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: "other_device_12345678", targetDeviceId: base.targetDeviceId,
    signalType: "OFFER", now: 1100
  }).ok, false);
});

test("only the selected target can answer and state advances to CONNECTING", () => {
  const denied = validateSessionSignal({
    session: base, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.controllerDeviceId, targetDeviceId: base.targetDeviceId,
    signalType: "ANSWER", now: 1200
  });
  assert.equal(denied.ok, false);
  const accepted = validateSessionSignal({
    session: base, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.targetDeviceId, targetDeviceId: base.controllerDeviceId,
    signalType: "ANSWER", now: 1200
  });
  assert.equal(accepted.nextSession.status, "CONNECTING");
});

test("only session participants can signal and ended sessions cannot be revived", () => {
  const outsider = validateSessionSignal({
    session: base, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: "outsider_device_123456", targetDeviceId: base.controllerDeviceId,
    signalType: "END", now: 1200
  });
  assert.equal(outsider.status, 403);
  const ended = { ...base, status: "ENDED", endedAt: 1300 };
  assert.equal(validateSessionSignal({
    session: ended, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.controllerDeviceId, targetDeviceId: base.targetDeviceId,
    signalType: "ANSWER", now: 1400
  }).status, 410);
});

test("END is allowed from either participant and repeated END is harmless", () => {
  const result = validateSessionSignal({
    session: base, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.targetDeviceId, targetDeviceId: base.controllerDeviceId,
    signalType: "END", now: 1500
  });
  assert.equal(result.nextSession.status, "ENDED");
  assert.equal(validateSessionSignal({
    session: result.nextSession, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.controllerDeviceId, targetDeviceId: base.targetDeviceId,
    signalType: "END", now: 1600
  }).duplicate, true);
});

test("expired sessions cannot be used for new connection signals", () => {
  const expired = { ...base, expiresAt: 999 };
  assert.equal(validateSessionSignal({
    session: expired, networkId: base.networkId, sessionId: base.id,
    senderDeviceId: base.targetDeviceId, targetDeviceId: base.controllerDeviceId,
    signalType: "ANSWER", now: 1000
  }).status, 410);
});
