const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createFirebaseMemoryStore } = require("../src/FirebaseMemoryStore");

function createCredentials() {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    project_id: "advis-test-project",
    client_email: "advis-test@example.iam.gserviceaccount.com",
    private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  });
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

async function withFakeFirestore(firestoreResponse, run) {
  const previous = {
    account: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    project: process.env.FIREBASE_PROJECT_ID,
    fetch: global.fetch
  };
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = createCredentials();
  delete process.env.FIREBASE_PROJECT_ID;
  global.fetch = async url => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return jsonResponse(200, { access_token: "test-access-token", expires_in: 3600 });
    }
    if (String(url).includes("firestore.googleapis.com")) return firestoreResponse;
    throw new Error("Unexpected test request URL.");
  };

  try {
    await run();
  } finally {
    if (previous.account === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previous.account;
    if (previous.project === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = previous.project;
    global.fetch = previous.fetch;
  }
}

test("Firestore connectivity probe authenticates and reads the network collection", async () => {
  await withFakeFirestore(jsonResponse(200, { documents: [] }), async () => {
    const store = createFirebaseMemoryStore();
    assert.ok(store);
    const result = await store.checkConnection();
    assert.equal(result.ok, true);
    assert.ok(Number.isFinite(result.checkedAt));
  });
});

test("Firestore connectivity probe preserves permission failure status", async () => {
  await withFakeFirestore(jsonResponse(403, { error: { message: "Permission denied" } }), async () => {
    const store = createFirebaseMemoryStore();
    assert.ok(store);
    await assert.rejects(store.checkConnection(), error => {
      assert.equal(error.status, 403);
      assert.match(error.message, /403/);
      return true;
    });
  });
});

test("Firestore adapter reports unconfigured when no service account is supplied", async () => {
  const previous = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  try {
    assert.equal(createFirebaseMemoryStore(), null);
  } finally {
    if (previous !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previous;
  }
});
