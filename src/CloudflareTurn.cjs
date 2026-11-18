const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

function validateCloudflareTurnKeyId(value) {
  return /^[a-f0-9]{32}$/i.test(String(value || ""));
}

function validateCloudflareTurnKeyToken(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ""));
}

async function fetchCloudflareIceServers({
  keyId,
  keyToken,
  ttlSeconds = 3600,
  fetchImpl = globalThis.fetch
}) {
  if (!validateCloudflareTurnKeyId(keyId)) {
    throw new Error("Cloudflare TURN key ID is missing or invalid.");
  }
  if (!validateCloudflareTurnKeyToken(keyToken)) {
    throw new Error("Cloudflare TURN key token is missing or invalid.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch().");
  }

  const ttl = Math.max(60, Math.min(48 * 60 * 60, Math.floor(Number(ttlSeconds) || 3600)));
  const response = await fetchImpl(
    `${CLOUDFLARE_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl })
    }
  );

  if (!response || !response.ok) {
    const status = Number(response?.status || 0);
    throw new Error(`Cloudflare TURN credential request failed (HTTP ${status || "unknown"}).`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.iceServers) || payload.iceServers.length === 0) {
    throw new Error("Cloudflare returned an invalid ICE server configuration.");
  }

  for (const server of payload.iceServers) {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    if (!urls.length || urls.some(url =>
      typeof url !== "string" || !/^(stun|stuns|turn|turns):/i.test(url)
    )) {
      throw new Error("Cloudflare returned an unsupported ICE server URL.");
    }
  }

  return payload.iceServers;
}

module.exports = {
  fetchCloudflareIceServers,
  validateCloudflareTurnKeyId,
  validateCloudflareTurnKeyToken
};
