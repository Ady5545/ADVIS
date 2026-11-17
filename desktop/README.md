# ADVIS Desktop Agent

This native companion is the required path for full-computer capture and input. The ADVIS website remains available without installing it.

## Initial implementation
- One-time owner-invitation enrolment.
- OS-backed Electron safeStorage for the device credential.
- Visible app window and system-tray entry.
- Authenticated heartbeat and command polling.
- Full-display WebRTC session path when local unattended access is explicitly enabled.
- Visible active-session state and local Stop control.
- Platform input adapters for macOS System Events, Windows User32 and Linux xdotool on X11.

## Trust and permissions
Unattended access is OFF by default. Enabling it is a local choice on the target computer. macOS still requires the user to grant Screen Recording and Accessibility permissions. The agent does not bypass OS privacy prompts, install hidden services, or conceal its active state. A network owner can revoke a device; the target user can stop a session or quit the agent.

The website itself can share only its browser tab and remains subject to the browser screen-share chooser. Full desktop access is provided by this installed agent, not by a webpage.

## Development
Run `npm install` then `npm run desktop:dev`.

## Packaging
Run `npm run desktop:package`. The configured targets are a macOS DMG, Windows NSIS and Linux AppImage. Signing, notarisation, OS permissions and target-OS test matrices remain release gates.

## Current limitations
- macOS hover and scroll injection are not implemented in this adapter.
- Windows and Linux input adapters have not yet been exercised in target-OS builds in this environment.
- Electron screen capture and native input require end-to-end testing on each supported OS before the agent can be called production-ready.
- The Android agent is a separate ADVIS Mobile integration and is not included in this desktop package.