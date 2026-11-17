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
| Device list | Firestore device documents, polled by client | Firestore connectivity and production enrollment need verification |
| Identity | Browser localStorage device ID | Native stable identity and secure storage needed |
| Rename | Editable web-panel name sent on heartbeat | Test cloud persistence and native agent sync |
| Enrollment | Private network ID/secret invitation link | Improve to one-time QR/pairing code with owner approval, expiry, replay protection |
| Presence | 3-second heartbeat; 35-second online timeout | Agent lifecycle, stale status, retry/backoff, last-seen UX |
| Commands | ADVIS-specific actions | Not full OS input |
| WebRTC | Browser-tab offer/answer prototype | Not full desktop capture, and cross-network relay is not configured |
| Desktop agent | No Electron main/preload or native capture/input implementation in repository | Entire agent needs implementation |
| Android agent | Separate ADVIS Mobile project exists | Needs integration with directory and Android's supported projection/input flows |
| TURN | Client can read a STUN URL; no production TURN configuration verified | TURN relay and short-lived credentials required |
| Revocation/audit | Basic per-device bearer token and command records | Device revocation, token rotation, session ownership, audit history |

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
- [ ] Probe Firestore itself (OAuth plus harmless collection read); adapter-method existence alone is not sufficient.
- [ ] Distinguish missing variables, malformed service account, OAuth failure, Firestore permission/database failure, and healthy.
- [ ] Verify the production diagnostic endpoint and device create/join/heartbeat/list operations.
- [ ] Add request timeout, input validation, rate limits, and sanitized diagnostics.

**Exit:** Production reports Firestore healthy; two test clients can enroll, rename, heartbeat, and see each other in one private network.

### Phase 1 — Device identity, enrollment, presence, revocation (P0)
- [ ] Define stable installation IDs for web, desktop, and Android; separate tabs must not masquerade as separate physical devices.
- [ ] Add expiring, one-time QR/pairing-code enrollment with replay prevention and first-time owner approval.
- [ ] Preserve identity across restart and app update; migrate existing invite-linked devices.
- [ ] Add authenticated rename, agent/platform/capability updates, online/offline state, last-seen time, and retry/backoff.
- [ ] Add revoke/remove, token rotation, and session/audit history.

**Exit:** Two devices on different networks enroll once, see each other, rename independently, restart, and reconnect. Revocation blocks new sessions immediately.

### Phase 2 — Reliable global session transport (P0)
- [ ] Implement authenticated session state machine: requested, accepted, connecting, connected, reconnecting, ended, revoked, expired.
- [ ] Finish offer/answer/ICE exchange and TURN fallback with short-lived server-minted credentials.
- [ ] Bind signaling and data-channel identity to the two enrolled device tokens.
- [ ] Test same LAN, separate home networks, mobile hotspot, restrictive NAT, network loss, and relay outage.

**Exit:** Two browser clients can establish a full-screen browser test session across separate networks with reliable disconnect. This is a transport milestone, not yet full desktop.

### Phase 3 — Native desktop agent and full desktop control (P0)
- [ ] Add Electron main/preload, packaging, startup option, secure IPC, update path, and local agent status.
- [ ] Enumerate displays and stream the full selected display.
- [ ] Implement supported pointer, click, keyboard, scroll, and optional clipboard input.
- [ ] Add OS-permission onboarding and persistent unattended-access opt-in.
- [ ] Test macOS first (the user's MacBook Air M2), Windows second, Linux after a supported portal/input matrix.
- [ ] Show live session and Stop control on the target; allow remote disconnect and owner revocation.

**Exit:** Two enrolled desktop agents on different networks can Connect with one click after initial setup, view the entire selected desktop, and operate supported input. Both sides can end the session immediately.

### Phase 4 — Android agent (P1)
- [ ] Integrate Android identity and directory presence with ADVIS Mobile.
- [ ] Implement foreground-session lifecycle and MediaProjection capture.
- [ ] Add only supported, explicitly enabled remote input capabilities.
- [ ] Test Android versions, rotation, app backgrounding, battery restrictions, reconnect, and session stop.

**Exit:** Supported Android devices appear in the same owner directory and report their real capture/input capability. Connect works only for supported, configured sessions.

### Phase 5 — Security, reliability, production hardening (P0 before general availability)
- [ ] Threat-model enrollment, device tokens, signaling, screen streams, and remote input.
- [ ] Add session limits, rate limits, replay protection, token rotation, device revocation, and revoke-all.
- [ ] Validate every remote input event and ensure it is accepted only inside the authenticated active session.
- [ ] Verify no secrets are in client bundles, logs, or public source.
- [ ] Add cross-platform integration tests, app restart tests, cold-start tests, relay failover tests, and an OS permission/revocation test matrix.
- [ ] Publish a capability matrix; do not mark any OS or capability supported before its test suite passes.

**Release criteria:** No stranger can enumerate devices; no silent enrollment; unattended access is an explicit device setting; active sessions are visible and stoppable; no unsupported platform is advertised as ready.

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
| 2026-11-17 | Added a server-side device-network status endpoint and explicit Devices-panel API/configuration errors. | Production build READY; live Firestore probe and cross-network enrollment remain pending. |
| 2026-11-17 | Audited the current repository: browser localStorage identity, Firestore polling relay, and a browser-tab WebRTC prototype exist; no native Electron main/preload or desktop agent is present. | GitHub main tree and Vercel production deployment history inspected. |
| 2026-11-17 | Added Firestore connectivity probe and updated /api/network/status to report missing setup, adapter initialization failure, live database connectivity, permission errors, and missing database/path separately. | Source committed; production build pending and live Firestore test still required. |
