# ADVIS Core

This repository contains the ADVIS web interface and its Node/Express intelligence API.

## Run locally

Install dependencies, build the React app and bundled server, then start it:

```bash
npm ci
npm run build
npm start
```

The server listens on `process.env.PORT` when supplied by a hosting provider, and falls back to port 3000 for local use. `GET /health` returns a small deployment health response.

## Deploy the mobile Core endpoint

A `render.yaml` Blueprint is included for a Node web service. Import this repository into Render and supply both secrets in the service's environment settings:

- `GEMINI_API_KEY`: your Gemini API key. Keep it in the host's secret environment variables; never put it in the Android app or commit it.
- `ADVIS_MOBILE_API_TOKEN`: a separate random token of at least 32 characters for the Android client's authenticated API. This is not the Gemini key.

After deployment, verify `GET https://YOUR-SERVICE/health` reports `status: ok`. In the Android app, tap **LINK CORE**, enter the service root URL and the same `ADVIS_MOBILE_API_TOKEN` value, then use **Save & test**. The mobile client uses these protected routes:

- `GET /api/mobile/health` — verifies the mobile token without spending an AI request.
- `POST /api/mobile/advis` — forwards a prompt to the existing ADVIS turn-processing code.

The existing browser routes `/api/advis` and `/api/jarvis` remain unchanged for the web interface. The mobile routes are protected separately so a public service does not expose the phone's bearer token or require a Gemini key in the APK.

**Important:** The included host blueprint does not make the service live automatically. A hosting account must import the Blueprint and the required secrets must be entered in its environment settings. Free web services may sleep while idle, and local JSON persistence can be ephemeral on hosts without a persistent disk.
