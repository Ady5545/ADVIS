/**
 * ADVIS Firebase Firestore persistence adapter.
 *
 * Uses Google's service-account JWT OAuth flow and the Firestore REST API.
 * No browser Firebase Admin credentials are ever exposed to the client, and
 * no extra runtime package is required on Vercel.
 *
 * All records are scoped below advisPrivate/primary. Firestore's Admin
 * credentials bypass client security rules; keep the service-account JSON
 * only in server-side environment variables.
 */
const crypto = require("crypto");

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createFirebaseMemoryStore() {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) return null;

  let serviceAccount;
  try {
    const normalized = rawServiceAccount.trim();
    const json = normalized.startsWith("{")
      ? normalized
      : Buffer.from(normalized, "base64").toString("utf8");
    serviceAccount = JSON.parse(json);
  } catch (error) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON (raw JSON or base64-encoded JSON).");
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id;
  const clientEmail = serviceAccount.client_email;
  const privateKey = String(serviceAccount.private_key || "").replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase service account is missing project_id, client_email, or private_key.");
  }

  const apiRoot = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  let cachedToken = null;
  let tokenExpiresAt = 0;
  let tokenRequest = null;

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
    if (tokenRequest) return tokenRequest;

    tokenRequest = (async () => {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = [
        base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
        base64url(JSON.stringify({
          iss: clientEmail,
          scope: "https://www.googleapis.com/auth/datastore",
          aud: "https://oauth2.googleapis.com/token",
          iat: now,
          exp: now + 3600
        }))
      ].join(".");
      const signer = crypto.createSign("RSA-SHA256");
      signer.update(unsigned);
      signer.end();
      const assertion = unsigned + "." + signer.sign(privateKey).toString("base64url");

      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.access_token) {
        throw new Error("Firebase OAuth token request failed: " + (result.error_description || result.error || response.status));
      }
      cachedToken = result.access_token;
      tokenExpiresAt = Date.now() + (Number(result.expires_in) || 3600) * 1000;
      return cachedToken;
    })();

    try {
      return await tokenRequest;
    } finally {
      tokenRequest = null;
    }
  }

  async function request(path, options = {}) {
    const token = await getAccessToken();
    const response = await fetch(apiRoot + "/" + path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    const body = text ? (() => { try { return JSON.parse(text); } catch (_) { return { raw: text }; } })() : null;
    if (!response.ok) {
      const message = body?.error?.message || body?.message || response.statusText;
      const error = new Error("Firestore request failed (" + response.status + "): " + message);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function safeDocumentId(id) {
    const value = String(id || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
    return value || crypto.randomUUID();
  }

  function decodeDocument(document) {
    try {
      const serialized = document?.fields?.payload?.stringValue;
      if (!serialized) return null;
      return JSON.parse(serialized);
    } catch (_) {
      return null;
    }
  }

  async function listCollection(collectionPath) {
    const output = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const result = await request(collectionPath + "?" + query.toString());
      for (const document of result?.documents || []) {
        const value = decodeDocument(document);
        if (value) output.push(value);
      }
      pageToken = result?.nextPageToken || "";
    } while (pageToken);
    return output;
  }

  async function setDocument(documentPath, value) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > 900_000) {
      throw new Error("A single ADVIS memory record exceeds Firestore's safe document-size budget.");
    }
    await request(documentPath + "?updateMask.fieldPaths=payload", {
      method: "PATCH",
      body: JSON.stringify({ fields: { payload: { stringValue: serialized } } })
    });
  }

  async function deleteDocument(documentPath) {
    try {
      await request(documentPath, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  async function syncCollection(collectionPath, records) {
    const normalized = (records || []).filter(Boolean);
    const desired = new Map(normalized.map(record => [safeDocumentId(record.id), record]));
    const existingRecords = await listCollection(collectionPath);
    const existingById = new Map(existingRecords.map(record => [safeDocumentId(record.id), JSON.stringify(record)]));

    // Upsert changed records only. Deletion is explicit per document, avoiding
    // broad collection replacement races between two paired devices.
    const writes = Array.from(desired.entries()).filter(([id, record]) =>
      existingById.get(id) !== JSON.stringify(record)
    );
    for (let i = 0; i < writes.length; i += 8) {
      await Promise.all(writes.slice(i, i + 8).map(([id, record]) => setDocument(collectionPath + "/" + id, record)));
    }
  }

  const ownerRoot = "advisPrivate/primary";
  const memoryCollection = ownerRoot + "/memories";
  const projectCollection = ownerRoot + "/projects";
  const historyDocument = ownerRoot + "/history/primary";

  async function loadState() {
    const [memories, projects, historyResult] = await Promise.all([
      listCollection(memoryCollection),
      listCollection(projectCollection),
      request(historyDocument).catch(error => error.status === 404 ? null : Promise.reject(error))
    ]);
    return {
      memories,
      projects,
      history: (decodeDocument(historyResult)?.messages || [])
    };
  }

  async function saveState(state) {
    const history = Array.isArray(state.history) ? state.history.slice(-200) : [];
    await Promise.all([
      syncCollection(memoryCollection, state.memories || []),
      syncCollection(projectCollection, state.projects || []),
      setDocument(historyDocument, { id: "primary", messages: history })
    ]);
  }

  return {
    projectId,
    loadState,
    saveState,
    deleteMemory: id => deleteDocument(memoryCollection + "/" + safeDocumentId(id)),
    deleteProject: id => deleteDocument(projectCollection + "/" + safeDocumentId(id))
  };
}

module.exports = { createFirebaseMemoryStore };
