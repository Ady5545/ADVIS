# ADVIS private Firebase memory setup

ADVIS is a single-owner personal system. It does not introduce user accounts, a registration page, email/password sign-in, or a recurring login flow. A trusted browser/device is paired once with a private owner code. The server then issues an HttpOnly, Secure, SameSite=Strict cookie for that device. Each of your other devices can be paired with the same code.

## 1. Firebase project

Use the Firebase project you already own, if one exists. Enable **Cloud Firestore** and create its default database in Native mode. Choose a region close to the Vercel deployment region where possible.

Create or select a server service account for the project and grant it the minimum IAM permission required to read and write Cloud Firestore (Cloud Datastore User is sufficient for the document operations used here). Generate a service-account JSON key only for the server. Never put this JSON in React code, a VITE_ variable, Git, or a public file.

## 2. Vercel environment variables

In the Vercel project named `advis`, add these variables to **Preview only first**. Creating a Firebase project and Firestore database does not connect the app by itself; these server-side Vercel variables are the connection. Add the same variables to **Production only after the Preview memory tests pass and the owner approves a production rollout**:

- `FIREBASE_SERVICE_ACCOUNT_JSON` — the complete service-account JSON document as one secret value.
- `FIREBASE_PROJECT_ID` — optional if the JSON already contains `project_id`.
- `ADVIS_OWNER_PAIRING_CODE` — a long random code used only when pairing a new device.
- `ADVIS_OWNER_TOKEN_SECRET` — a different, long random secret used by the server to sign device cookies.

Generate two different random values locally, for example with `openssl rand -hex 32`. Do not reuse the Firebase private key as either pairing secret. Keep `GEMINI_API_KEY` as a separate server-side secret.

## 3. First device and additional devices

After the deployment has the variables, open the ADVIS domain. The first-time device screen will ask for the owner pairing code once. The server stores a signed, HttpOnly cookie in that browser. On another device or browser, enter the same code once. No account or email address is created.

The pairing code is a bearer secret: anyone who obtains it can pair another device. Keep it private and rotate it if you believe it has been exposed. Rotating `ADVIS_OWNER_TOKEN_SECRET` invalidates existing device cookies, requiring each device to pair again.

## 4. What is persisted

The Firestore owner namespace stores memories, project records, and a shared recent conversation history under a single fixed owner. It is not a per-browser or per-device collection. ADVIS retrieves a bounded, relevance-ranked selection of durable memories on each Butler turn, while keeping pinned and global profile memories in its baseline context.

The browser/device ID remains only for client compatibility; it is no longer the ownership key for persistent memory or conversation history.

## 5. Verification checklist

1. Pair the first browser once.
2. Save a test preference or project decision in ADVIS.
3. Open ADVIS in a second browser/device and pair with the same code.
4. Ask ADVIS about the saved preference; it should retrieve the same owner memory.
5. Add a new memory from the second device; reload the first device and confirm the shared memory appears.
6. Confirm a request without a paired owner cookie receives an authorization error.
7. Confirm the Firebase service-account credential is absent from all client bundles and browser network responses.

If Firebase variables are missing, the production app deliberately reports that the private cloud-memory connection is not configured instead of silently claiming that Vercel's temporary filesystem is durable.
