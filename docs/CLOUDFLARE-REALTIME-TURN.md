# ADVIS Cloudflare Realtime TURN setup

ADVIS uses Cloudflare Realtime TURN for managed WebRTC relay connectivity. The Cloudflare TURN key token is a server-side secret: never put it in browser code, commit it to Git, or paste it into chat.

## 1. Create a TURN key

1. Have a parent or guardian manage the Cloudflare account and any billing settings.
2. Open the Cloudflare dashboard and select the account that will own ADVIS Realtime TURN.
3. Open Realtime / TURN and create a TURN key named `ADVIS production`.
4. Record the key ID (32-character UID) and the key token/secret (64-character value) in a password manager. The token is a bearer credential; treat it like a password.
5. Do not create a long-lived TURN username/password for browser use. ADVIS requests short-lived ICE credentials from Cloudflare for each connection.

If the dashboard does not expose key creation, an account administrator can use the Cloudflare API. Creating a TURN key requires an API token with the `Calls Write` permission and the account ID. The API response contains the TURN key UID and bearer secret. Keep the account API token private and do not add it to ADVIS; only the TURN key ID and TURN key token are needed by the ADVIS server.

## 2. Add Production environment variables in Vercel

In the Vercel dashboard:

1. Open the `advis` project under the `ady17` team.
2. Open Settings → Environment Variables.
3. Add these two variables and select **Production** (add Preview too only if you want to test a preview deployment):
   - `ADVIS_CLOUDFLARE_TURN_KEY_ID` — the 32-character TURN key UID.
   - `ADVIS_CLOUDFLARE_TURN_KEY_TOKEN` — the 64-character TURN key bearer secret.
4. Save both values. Do not put either value in `VITE_*` variables, client-side code, GitHub files, or chat.
5. Redeploy the production deployment after the routing and TURN changes have been merged and the Vercel deployment limit permits it.

ADVIS uses a one-hour credential TTL. The long-lived TURN key stays on the server; the browser receives only temporary ICE server credentials. The Cloudflare TURN key API token is not the same as an account-wide Cloudflare API token.

## 3. Verify the configuration

1. Open ADVIS in two browsers/devices that you own or are authorized to test.
2. Enroll the second device using the one-time invitation.
3. Start a remote session and approve the browser's screen-sharing prompt on the receiving device.
4. During the test, open Chrome's `chrome://webrtc-internals` on both computers. Inspect the selected candidate pair. A candidate pair using a `relay` candidate indicates TURN relay use; a `host` or `srflx` pair can indicate a direct connection.
5. To test TURN specifically, the test build can temporarily set `iceTransportPolicy: "relay"` on the peer connection. Do not leave relay-only mode enabled in normal production because it forces all traffic through the relay and may increase usage/latency.
6. Stop the session from either side and confirm that the stream and input channel close.

## 4. Cost and security notes

- Cloudflare documents a 1,000 GB free usage tier and then $0.05 per GB of outbound TURN data, subject to its current billing terms. Check the account's current Realtime pricing and usage dashboard before testing large screen streams.
- Screen sharing can use substantial bandwidth. Keep test sessions short and monitor usage.
- Cloudflare TURN relays encrypted WebRTC packets; DTLS encrypts the WebRTC media/data between the peers. TURN does not replace ADVIS device enrollment, per-session consent, or disconnect controls.
- Rotate/revoke the TURN key if it is exposed. Update the Vercel Production environment variable with the replacement key token and redeploy.
- A successful TURN configuration improves connectivity but cannot guarantee every firewall/network will permit every transport.
