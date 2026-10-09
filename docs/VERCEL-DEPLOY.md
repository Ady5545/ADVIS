# Deploying ADVIS Core on Vercel

This repository can serve its Vite frontend as static output and expose the existing Express API through a Vercel Node Function.

## Vercel project

- Repository: `Ady5545/ADVIS`
- Production branch: use the proposed `feat/vercel-mobile-backend` branch for the first preview deployment; merge the pull request only after the preview is verified.
- Framework preset: Vite
- Root directory: `./`
- Build command: `npm run build`
- Output directory: `dist`

Vercel detects the catch-all function at `api/[...path].js`. The existing API paths are retained, including `/api/advis`, `/api/jarvis`, `/api/mobile/health`, and `/api/mobile/advis`.

## Environment variables

Set these in Vercel Project Settings → Environment Variables. Do not commit secrets or put them in the Android app:

- `GEMINI_API_KEY`: a valid Google Gemini API key.
- `ADVIS_MOBILE_API_TOKEN`: a private random bearer token at least 32 characters long. Use the same token in the Android app's secure configuration.

Add them for Preview and Production as appropriate, then redeploy the preview. Never paste the values into a GitHub issue or chat.

## Important persistence limitation

Vercel Functions have an ephemeral filesystem and may be restarted or run in parallel. ADVIS now writes its existing JSON data files under `/tmp/advis-data` on Vercel so requests do not attempt to write into the read-only deployment bundle. That avoids filesystem write errors, but it does **not** provide durable memory/history across cold starts or different function instances.

Before relying on long-term ADVIS memories or conversation history in production, connect a persistent database and migrate these JSON-backed stores. Do not assume the preview has durable memory.

## Smoke checks

After deployment:

1. Open `/api/health` and confirm `{ "status": "ok", "service": "advis-core" }`.
2. Request `/api/mobile/health` without authorization and confirm it does not return a successful health response.
3. Request `/api/mobile/health` with `Authorization: Bearer <your token>` and confirm the mobile API reports healthy.
4. Send a small test message from the Android app and check Vercel Function logs if it fails.

The mobile health route is protected by the bearer token. Keep the Gemini key on the server only.
