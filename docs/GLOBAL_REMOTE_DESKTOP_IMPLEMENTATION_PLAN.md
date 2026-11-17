# ADVIS Global Remote Desktop — Implementation Plan

**Repository:** Ady5545/ADVIS  
**Branch:** main  
**Production project:** advis  
**Target experience:** A private online-device directory. Select an enrolled device and press Connect to view and operate its full desktop. Devices can run ADVIS in the foreground or as a visible background agent.

## 1. Product requirements

1. Every enrolled installation has a stable identity and editable device name.
2. Devices appear in an owner-only directory with online/offline state, last seen, platform, agent version, capabilities, and current session.
3. Enrollment happens once through a trusted pairing flow. Connections after enrollment do not ask for repeated ADVIS approval when the target has explicitly enabled unattended access.
4. A Connect action opens a full-screen session for the selected target display, not merely remote ADVIS buttons or the ADVIS browser tab.
5. Supported remote input includes pointer, click, keyboard, scroll, and optional clipboard, according to the OS capability matrix.
6. Both ends show a clear live-session indicator and have an immediate Stop/Disconnect action. The owner can revoke a device at any time.
7. The target agent starts visibly with the user's login session when configured to do so. It has a quit/disable control and does not masquerade as a hidden process.
8. Normal ADVIS usage remains direct-open. Device enrollment is an optional setup flow and must not become a global sign-in gate.

## 2. Current-state audit (17 Nov 2026)

| Capability | Current state | Gap |
|---|---|---|
| Device list | Firestore device documents; private per-network list is polled by clients | Production Firestore connectivity and two-device runtime enrollment remain unverified |
| Identity | Browser profile ID in localStorage; Electron agent stores a separate ID and token in OS-backed safeStorage | Stable hardware identity and browser-to-native identity migration remain open |
| Rename | Browser panel and desktop agent send the editable name on heartbeat | Live cross-device persistence is not yet verified |
| Enrollment | Server-generated owner capability plus hashed, single-use 10-minute invitation; Firestore updateTime precondition prevents replay | Legacy networks are rejected with HTTP 410 and must be recreated/re-enrolled; QR rendering is not added yet |
| Presence | Browser heartbeat about every 3 seconds; desktop agent heartbeat every 5 seconds; online timeout 35 seconds | Agent version, foreground/background state, robust retry/backoff and live restart test remain |
| Commands | ADVIS actions plus authenticated RTC signaling; desktop agent accepts RTC signaling and native input events | Full session state machine, audit history, strict input authorization and cross-network integration tests remain |
| WebRTC | Browser-tab path plus Electron display capture and native data-channel path; server can mint short-lived TURN credentials | TURN URL/secret and end-to-end relay tests are not verified; STUN-only networks may fail |
| Desktop agent | Electron main/preload, visible tray, secure credential storage, one-time enrollment, display preparation, WebRTC and OS input adapters are in source | Installers, signing/notarisation and per-OS runtime tests are not yet complete |
| Android agent | Not implemented in this repository | ADVIS Mobile repo access/integration and Android MediaProjection/foreground-service work remain |
| TURN | Backend can mint time-limited HMAC credentials from server-only ADVIS_TURN_URL and ADVIS_TURN_SECRET | TURN provider settings and relay availability need configuration and live verification |
| Revocation/audit | Owner-only revoke and revoke-all delete device records; agent stops sessions on 401/403/410 | Token rotation, durable audit history, immediate push revocation, session binding/rate limiting remain |

## 3. Target architecture

### 3.1 Owner-scoped control plane
- Keep the directory private to one trusted owner network. Never expose a global list of all ADVIS installations.
- Firestore stores networks, pairing attempts, enrolled devices, device heartbeats, sessions, revocations, and audit events.
- Server-only credentials stay on the server. Store token hashes, issue per-device tokens, and support rotation/revocation.
- Add one-time pairing through a short-lived QR/pairing code. A new device is clearly identified to the owner before it is enrolled. Pairing is not repeated for every Connect action.
- Device names and capabilities are changed through authenticated API operations and synchronized to every enrolled device.
- Presence includes platform, agent version, last heartbeat, foreground/background state, and capabilities. Offline devices remain listed.

### 3.2 Signaling and transport
- Authenticate every signaling request and bind each session to exactly two enrolled devices in the same owner network.
- Use WebRTC for encrypted media and data channels.
- Use STUN for direct connectivity and a TURN relay for networks where direct paths fail. No static TURN secret may be shipped in a VITE client variable; the server must mint short-lived TURN credentials.
- Start with Firestore-backed signaling for the first cross-network milestone, then move signaling to a realtime service if polling latency/cost tests require it. Firestore must never carry the actual video stream.
- Add reconnect/backoff, session expiry, rate limits, message-size limits, and server-side state validation.

### 3.3 Native desktop agent
- Add a separately packaged Electron application with a least-privilege main/preload boundary and explicit IPC.
- Agent startup is optional and visible in the user's login session. It reports device status and supports quit, disable startup, revoke, and disconnect.
- macOS: use supported display capture and input APIs; guide the user through Screen Recording and Accessibility/Input Monitoring permissions.
- Windows: use supported full-desktop capture and input APIs, with clear handling of locked/secure desktop boundaries.
- Linux: start with documented PipeWire/desktop-portal capture and tested input support; report unsupported desktop/compositor combinations.
- Never capture secure OS prompts, password dialogs, or lock screens; do not bypass OS permission controls.

### 3.4 Android agent
- Integrate with ADVIS Mobile rather than trying to keep a browser tab alive in the background.
- Use a visible foreground service for active sessions and Android MediaProjection for display capture.
- Follow the Android version's screen-sharing consent and notification requirements.
- Remote input is restricted to explicitly enabled accessibility capabilities and supported app contexts. Do not claim universal unattended Android control where the OS does not support it.

### 3.5 Devices UX
- Make the enrolled device directory the main Devices view; pairing is a setup state, not the main interaction.
- Device card: custom name, platform, online/offline, last seen, agent version, unattended-ready status, and active session.
- Primary button: Connect. Secondary actions: rename, reconnect, revoke, remove, and view recent activity.
- When a trusted target is ready, Connect starts a session without a recurring ADVIS approval popup. When it is not ready, show the exact missing setup/permission.
- Active session view: full-screen video, target display selector, connection quality, reconnect state, and prominent Disconnect. Target shows persistent session indicator and local Stop.

## 4. Delivery phases and exit criteria

### Phase 0 — Cloud directory diagnostics and recovery (P0)
- [x] Probe Firestore itself (OAuth plus harmless collection read); adapter-method existence alone is not sufficient.
- [x] Distinguish unconfigured adapter, authentication/permission errors, database read failure, and healthy response without exposing credentials.
- [ ] Verify the production diagnostic endpoint and device create/join/heartbeat/list operations against a live Firestore project.
- [ ] Add production API rate limits, stronger request timeouts, and operational alerts.

**Status:** Diagnostic code is committed. The earlier Phase 0 production build is READY, but live Firestore connectivity and two-device enrollment have not been independently verified.

### Phase 1 — Device identity, enrollment, presence, revocation (P0)
- [x] Add separate owner and device tokens; only token hashes are stored server-side.
- [x] Add owner-generated one-time invitations that expire after 10 minutes and use Firestore update-time preconditions to block replay.
- [x] Add owner-only revoke and revoke-all endpoints; stop a desktop session when the agent's next authenticated request is rejected.
- [x] Add browser setup UI for one-time invitations, owner/member roles, and revoke actions.
- [ ] Add QR rendering, durable native installation identity migration, token rotation, agent version/capability reporting, and a live two-device restart/re-enrollment test.
- [ ] Add automatic push revocation/session-ownership checks rather than waiting for the next poll.

**Status:** The new protocol is implemented in source. Legacy permanent-secret networks now receive HTTP 410 and must be disconnected and recreated, then all trusted devices re-enrolled. Production migration is not yet live-verified.

### Phase 2 — Reliable global session transport (P0)
- [x] Add server-authenticated ICE configuration and short-lived TURN credentials derived from server-only settings.
- [x] Add desktop-agent RTC offer/answer handling over the existing authenticated command channel.
- [ ] Configure and verify a TURN relay provider; without it, the server returns STUN-only configuration.
- [ ] Enforce a full session state machine, command/session binding, rate limits, reconnect/backoff, and session expiry.
- [ ] Test across separate home networks, mobile hotspot, restrictive NAT, and relay outage.

**Status:** Signaling and credential-minting code are present. Cross-network media connectivity is not yet proven because a live TURN relay has not been configured and tested.

### Phase 3 — Native desktop agent and full desktop control (P0)
- [x] Add Electron main/preload, visible tray, secure credential storage, local permissions panel, login-start setting, and packaging configuration.
- [x] Add one-time local enrollment and explicit unattended-access setting (OFF by default).
- [x] Add a local screen-preparation step so later Connect requests reuse a prepared display stream instead of requesting ADVIS approval each time while the agent stays running.
- [x] Add initial macOS, Windows, and Linux/X11 input adapters for pointer, click, keyboard, and scroll (platform-specific limitations are recorded).
- [x] Add macOS/Windows/Linux packaging workflow.
- [ ] Build, sign/notarise, install, and test the agent on actual Mac, Windows, and Linux target machines; verify display capture, input, launch-at-login, sleep/wake, and revoke behavior.
- [ ] Add clipboard support, macOS hover/scroll, Linux Wayland/PipeWire portal input matrix, and native update channel.

**Status:** Desktop-agent code and packaging workflows are in main. They are not yet validated as installable, signed, or production-ready remote-desktop installers. The unattended stream must be prepared locally after an agent process starts; no browser-only or hidden background capture is claimed.

### Phase 4 — Android agent (P1)
- [ ] Integrate Android identity and directory presence with ADVIS Mobile.
- [ ] Implement foreground-session lifecycle and MediaProjection capture.
- [ ] Add only supported, explicitly enabled remote input capabilities.
- [ ] Test Android versions, rotation, app backgrounding, battery restrictions, reconnect, and session stop.

**Status:** Not implemented in the separate ADVIS Mobile repository in this work.

### Phase 5 — Security, reliability, production hardening (P0 before general availability)
- [x] Add hashed per-device credentials, owner-only enrollment management, expiring single-use invites, input event validation, safe server-side TURN credential generation, and an agent-side Stop path on token rejection.
- [x] Add automated tests for Firestore health, invitation redemption/expiry, token helpers, TURN HMAC credentials, input validation, and source syntax.
- [ ] Add production rate limits, token rotation, detailed but safe audit history, full session binding and anti-replay checks.
- [ ] Run cross-network, cross-platform, OS permission/revocation, relay failover, sleep/wake, and cold-start test matrices.
- [ ] Publish a tested capability matrix; do not advertise any OS/capability as production ready before its tests pass.

**Release criteria:** No public device enumeration; no silent enrollment; target-side unattended access is explicit; active sessions are visible and stoppable; unsupported platform behavior is clearly labeled.
## 5. Dependencies and decisions
- A valid Firebase/Firestore project, database, and server-only service account.
- A TURN relay service and server-only secret for expiring credentials.
- Desktop signing/packaging for macOS and Windows; platform permission guidance.
- Android integration in the separate ADVIS Mobile project.
- A decision on initial native desktop support order: macOS first, Windows second; Linux and Android follow their platform-specific acceptance tests.
- Vercel functions remain stateless; persistent session state/signaling must not rely on in-memory WebSocket state.

## 6. Operating rules
- The device list is private to the owner's enrolled network, not a public global directory.
- One-time enrollment and OS setup are separate from Connect. After setup, Connect should not ask for recurring ADVIS approval.
- The target always shows a visible live-session state and local Stop control.
- Unattended access can be disabled and devices can be revoked at any time.
- Keep direct-open ADVIS intact; do not add an account/sign-in gate to ordinary use.
- A browser-only build must never be described as full operating-system remote control.

## 7. Implementation log

| Date | Change | Verification |
|---|---|---|
| 2026-11-17 | Added the server-side Firestore health probe and a diagnostic status endpoint; the Devices panel distinguishes API/configuration failures. | Historical Phase 0 production deployment reached READY; current live Firestore state has not been independently verified. |
| 2026-11-17 | Added v2 owner/device credentials, hashed one-time invitations, 10-minute expiry, atomic Firestore redemption, owner-only revoke/revoke-all, legacy-network rejection, and server-side TURN credential minting. | Source is on main; automated tests cover invitation replay/expiry and TURN HMAC generation. Production endpoint and real multi-device enrollment still need validation. |
| 2026-11-17 | Updated the browser Devices panel to create and join one-time invitations, identify owner/member devices, revoke members, and label native desktop Connect separately from browser-tab sharing. | Core build workflow passed; UI has not yet been verified against live Firestore devices. |
| 2026-11-17 | Added the Electron desktop-agent scaffold: visible tray/window, secure credential storage, device enrollment, heartbeat, authenticated RTC signaling, reusable local display preparation, and platform-specific input adapters. | JavaScript parser and input-validation tests passed in CI. No target-OS installer, signing, screen-capture or live input end-to-end test has run. |
| 2026-11-17 | Added native package scripts, Electron builder configuration, lockfile synchronization workflow, and macOS/Windows/Linux package workflow. | Lockfile sync and web/server core build workflows passed. The new multi-OS packaging workflow has not yet been confirmed. |
| 2026-11-17 | Expanded automated checks to 12 tests covering Firestore health, invitation replay/expiry, token and identifier helpers, TURN credentials, native input validation, and JS syntax. | GitHub Actions core build on commit 6cb4f1e2 passed: 12 passed, 0 failed; Vite and server bundles built. The later screen-preparation change is awaiting its next CI run. |
