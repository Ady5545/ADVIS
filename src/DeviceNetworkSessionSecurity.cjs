const { safeDeviceId } = require("./DeviceNetworkSecurity.cjs");
const SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
function validateSessionSignal({ session, networkId, sessionId, senderDeviceId, targetDeviceId, signalType, now = Date.now() }) {
  if (!safeDeviceId(sessionId) || !safeDeviceId(senderDeviceId) || !safeDeviceId(targetDeviceId) || senderDeviceId === targetDeviceId) return { ok: false, status: 400, error: "Invalid remote session identity." };
  const type = String(signalType || "");
  if (!["OFFER", "ANSWER", "ICE", "END"].includes(type)) return { ok: false, status: 400, error: "Unsupported remote session signal." };
  if (type === "OFFER") {
    if (!session) return { ok: true, createSession: { id: sessionId, networkId, controllerDeviceId: senderDeviceId, targetDeviceId, status: "OFFERED", createdAt: now, updatedAt: now, lastSignalAt: now, expiresAt: now + SESSION_LIFETIME_MS } };
    const exactPair = session.id === sessionId && session.networkId === networkId && session.controllerDeviceId === senderDeviceId && session.targetDeviceId === targetDeviceId;
    if (exactPair && session.status === "OFFERED" && Number(session.expiresAt) > now) return { ok: true, duplicate: true };
    return { ok: false, status: 409, error: "Remote session identifier is already active or belongs to another device pair." };
  }
  if (!session || session.id !== sessionId || session.networkId !== networkId) return { ok: false, status: 404, error: "Remote session was not found." };
  const isController = senderDeviceId === session.controllerDeviceId && targetDeviceId === session.targetDeviceId;
  const isTarget = senderDeviceId === session.targetDeviceId && targetDeviceId === session.controllerDeviceId;
  if (!isController && !isTarget) return { ok: false, status: 403, error: "This device is not a participant in that remote session." };
  if (type !== "END" && Number(session.expiresAt || 0) <= now) return { ok: false, status: 410, error: "Remote session has expired. Start a new connection." };
  if (session.status === "ENDED") return type === "END" ? { ok: true, duplicate: true } : { ok: false, status: 410, error: "Remote session has already ended." };
  if (type === "ANSWER") {
    if (!isTarget || !["OFFERED", "CONNECTING"].includes(session.status)) return { ok: false, status: 409, error: "Only the selected target can answer an outstanding offer." };
    if (session.status === "CONNECTING") return { ok: true, duplicate: true };
    return { ok: true, nextSession: { ...session, status: "CONNECTING", updatedAt: now, lastSignalAt: now } };
  }
  if (type === "ICE") {
    if (!["CONNECTING", "ACTIVE"].includes(session.status)) return { ok: false, status: 409, error: "ICE updates require an accepted remote session." };
    return { ok: true, nextSession: { ...session, lastSignalAt: now, updatedAt: now } };
  }
  if (type === "END") return { ok: true, nextSession: { ...session, status: "ENDED", endedAt: now, updatedAt: now, lastSignalAt: now } };
  return { ok: false, status: 400, error: "Invalid remote session transition." };
}
module.exports = { SESSION_LIFETIME_MS, validateSessionSignal };
