const crypto = require("crypto");

const TOKEN_BYTES = 32;

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function constantTimeHexEqual(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeNetworkId(value) {
  return /^[A-Za-z0-9_-]{20,100}$/.test(String(value || ""));
}

function safeDeviceId(value) {
  return /^[A-Za-z0-9_-]{12,100}$/.test(String(value || ""));
}

function createToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function createInvitationCode() {
  return crypto.randomBytes(24).toString("base64url");
}

function createTurnCredentials({ secret, deviceId, ttlSeconds = 600, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!secret || !safeDeviceId(deviceId)) return null;
  const expiresAt = nowSeconds + Math.max(60, Math.min(3600, Number(ttlSeconds) || 600));
  const username = expiresAt + ":" + deviceId;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiresAt };
}

module.exports = {
  hashSecret,
  constantTimeHexEqual,
  safeNetworkId,
  safeDeviceId,
  createToken,
  createInvitationCode,
  createTurnCredentials
};
