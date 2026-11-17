(() => {
  const $ = id => document.getElementById(id);
  const api = window.advisAgent;
  const statusBox = $("status");
  const endpoint = $("endpoint");
  const name = $("name");
  const invite = $("invite");
  const displaySelect = $("display");
  const unattended = $("unattended");
  const stopButton = $("stop");
  let config = null;
  let credentials = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let activePeer = null;
  let activeStream = null;
  let preparedStream = null;
  let activeSessionId = "";
  let activePeerDeviceId = "";
  const handledCommands = new Set();
  function status(message, state = "info") { statusBox.textContent = message; statusBox.className = "status " + state; }
  function safeEndpoint(raw) {
    const url = new URL(String(raw).trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname))) throw new Error("ADVIS server must use HTTPS. HTTP is allowed only for local development.");
    return url.origin;
  }
  async function apiJson(route, options = {}) {
    if (!credentials || !credentials.endpoint) throw new Error("Set the ADVIS server first.");
    const response = await fetch(credentials.endpoint + route, { ...options, headers: { "Content-Type": "application/json", ...(credentials.deviceToken ? { Authorization: "Bearer " + credentials.deviceToken } : {}), ...(options.headers || {}) } });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok) {
      const error = new Error(data.error || ("ADVIS server returned HTTP " + response.status));
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function persist(next) {
    config = await api.saveConfig({ ...config, ...next });
    credentials = await api.getCredentials();
    endpoint.value = config.endpoint;
    name.value = config.deviceName;
    unattended.checked = config.allowUnattended;
    return config;
  }
  async function refreshDisplays() {
    const screens = await api.listDisplays();
    displaySelect.replaceChildren();
    for (const display of screens) { const option = document.createElement("option"); option.value = display.id; option.textContent = display.name; displaySelect.appendChild(option); }
    if (config && config.displaySourceId && screens.some(item => item.id === config.displaySourceId)) displaySelect.value = config.displaySourceId;
  }
  async function enroll() {
    try {
      status("Validating one-time invitation…");
      const base = safeEndpoint(endpoint.value);
      const raw = invite.value.trim();
      let networkId = "", invitationCode = "";
      if (raw.startsWith("https://") || raw.startsWith("http://")) { const url = new URL(raw); networkId = url.searchParams.get("advisNetwork") || ""; invitationCode = url.searchParams.get("advisInvite") || ""; }
      else { const parts = raw.split("."); networkId = parts[0] || ""; invitationCode = parts[1] || ""; }
      if (!networkId || !invitationCode) throw new Error("Paste a complete owner-generated single-use invitation.");
      const deviceId = (config && config.deviceId) || crypto.randomUUID().replace(/-/g, "");
      const response = await fetch(base + "/api/network/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ networkId, invitationCode, deviceId, name: String(name.value || (config && config.deviceName) || "ADVIS Desktop").slice(0,48), platform: "ADVIS Desktop Agent · " + ((config && config.platform) || "desktop") }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Device enrollment failed.");
      config = await api.saveConfig({ endpoint: base, networkId, deviceId, deviceName: String(name.value || "ADVIS Desktop").slice(0,48), deviceToken: result.deviceToken, allowUnattended: false, startAtLogin: config && config.startAtLogin === true, displaySourceId: displaySelect.value });
      credentials = await api.getCredentials();
      invite.value = ""; unattended.checked = false; endpoint.value = config.endpoint; name.value = config.deviceName;
      await refreshDisplays(); startLoops();
      status("Enrolled successfully. Unattended sessions remain OFF until you enable them locally.", "good");
    } catch (error) { status(error.message || "Enrollment failed.", "danger"); }
  }
  async function saveSettings() {
    try {
      const allow = unattended.checked;
      if (allow && !(config && config.allowUnattended)) {
        const accepted = window.confirm("Allow enrolled devices in your private ADVIS network to start full desktop sessions without asking you each time? During this setup step, ADVIS will prepare a screen stream while the agent remains visible. You can stop or revoke access locally.");
        if (!accepted) { unattended.checked = false; return; }
      }
      const base = safeEndpoint(endpoint.value);
      const deviceName = String(name.value || (config && config.deviceName) || "ADVIS Desktop").slice(0,48);

      // Capture preparation is initiated by this local button click. Remote
      // offers later reuse the already-prepared stream instead of opening a
      // new screen-share picker for every Connect request.
      if (allow && (!preparedStream || preparedStream.getTracks().every(track => track.readyState !== "live"))) {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This desktop runtime cannot prepare a display stream.");
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 24 }, audio: false });
        if (!stream.getVideoTracks().some(track => track.readyState === "live")) {
          stream.getTracks().forEach(track => track.stop());
          throw new Error("No live display stream was selected.");
        }
        preparedStream = stream;
        stream.getTracks().forEach(track => track.addEventListener("ended", () => {
          if (preparedStream === stream) {
            preparedStream = null;
            if (activeSessionId) void stopSession(true);
            status("Screen capture was stopped by the operating system. Prepare it again before the next desktop connection.", "warn");
          }
        }, { once: true }));
      }

      if (!allow && preparedStream) {
        await stopSession(true);
        preparedStream.getTracks().forEach(track => track.stop());
        preparedStream = null;
      }

      config = await persist({ endpoint: base, deviceName, displaySourceId: displaySelect.value, allowUnattended: allow });
      status(allow
        ? "UNATTENDED ACCESS ON · screen stream prepared · the agent stays visible in the system tray."
        : "Unattended desktop access is OFF. Settings saved in the OS secure credential store.",
        allow ? "good" : "info");
      if (config.enrolled) startLoops();
    } catch (error) {
      status(error.message || "Could not save settings.", "danger");
    }
  }

  async function refreshCapturePreparation() {
    if (preparedStream && preparedStream.getVideoTracks().some(track => track.readyState === "live")) return true;
    preparedStream = null;
    return false;
  }
  async function sendSignal(targetDeviceId, sessionId, type, extra = {}) {
    await apiJson("/api/network/commands", { method: "POST", body: JSON.stringify({ networkId: credentials.networkId, deviceId: credentials.deviceId, targetDeviceId, kind: "RTC_SIGNAL", payload: { sessionId, type, ...extra } }) });
  }
  async function acknowledge(commandId, state, result) {
    await apiJson("/api/network/commands/" + encodeURIComponent(commandId) + "/ack", { method: "POST", body: JSON.stringify({ networkId: credentials.networkId, deviceId: credentials.deviceId, status: state, result: result || "" }) });
  }
  async function waitForIce(peer) {
    if (peer.iceGatheringState === "complete") return;
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 10000);
      const onChange = () => { if (peer.iceGatheringState === "complete") { clearTimeout(timeout); peer.removeEventListener("icegatheringstatechange", onChange); resolve(); } };
      peer.addEventListener("icegatheringstatechange", onChange);
    });
  }
  async function stopSession(notify = true) {
    const peer = activePeer, sessionId = activeSessionId, peerDeviceId = activePeerDeviceId;
    activePeer = null; activeSessionId = ""; activePeerDeviceId = "";
    if (peer) { try { peer.close(); } catch (_) {} }
    activeStream = null;
    try { await api.stopSession(); } catch (_) {}
    if (notify && sessionId && peerDeviceId) {
      await sendSignal(peerDeviceId, sessionId, "END", { reason: "The target device stopped the desktop session." }).catch(() => {});
    }
    stopButton.disabled = true;
    if (notify && sessionId) status("Desktop session stopped. The prepared stream remains local; the agent stays enrolled.", "good");
  }
  async function acceptRemoteDesktopOffer(command) {
    const signal = command.payload || {}, sessionId = String(signal.sessionId || "");
    if (!config.allowUnattended) { await sendSignal(command.fromDeviceId, sessionId, "END", { reason: "Unattended access is disabled." }); await acknowledge(command.id, "REJECTED", "Unattended access is disabled."); return; }
    if (activeSessionId) { await sendSignal(command.fromDeviceId, sessionId, "END", { reason: "Another session is active." }); await acknowledge(command.id, "REJECTED", "Another desktop session is active."); return; }
    if (!await refreshCapturePreparation()) {
      await sendSignal(command.fromDeviceId, sessionId, "END", { reason: "The target desktop stream is not prepared in this agent session." });
      await acknowledge(command.id, "REJECTED", "Open the agent and prepare screen capture before connecting.");
      status("DESKTOP NOT PREPARED · Open the agent and click Save device settings with unattended access enabled.", "warn");
      return;
    }
    try {
      if (!sessionId || !signal.sdp) throw new Error("The remote desktop offer is incomplete.");
      await api.startSession();
      const iceConfig = await apiJson("/api/network/ice-config");
      const peer = new RTCPeerConnection({ iceServers: iceConfig.iceServers || [{ urls: "stun:stun.l.google.com:19302" }] });
      activePeer = peer; activeSessionId = sessionId; activePeerDeviceId = command.fromDeviceId;
      peer.ondatachannel = event => {
        event.channel.onmessage = async messageEvent => {
          try { await api.input(JSON.parse(String(messageEvent.data || "{}"))); }
          catch (error) { status("Input blocked: " + (error.message || "Unsupported input event."), "warn"); }
        };
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") void stopSession(false);
        else if (peer.connectionState === "connected") status("LIVE DESKTOP SESSION · " + command.fromDeviceName, "good");
      };
      const stream = preparedStream;
      activeStream = stream;
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      await peer.setRemoteDescription({ type: "offer", sdp: String(signal.sdp) });
      const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); await waitForIce(peer);
      await sendSignal(command.fromDeviceId, sessionId, "ANSWER", { sdp: (peer.localDescription && peer.localDescription.sdp) || "" });
      await acknowledge(command.id, "COMPLETED", "Desktop session accepted by the local unattended-access setting.");
      stopButton.disabled = false; status("Connecting to " + command.fromDeviceName + "…", "good");
    } catch (error) {
      await stopSession(false);
      await sendSignal(command.fromDeviceId, sessionId, "END", { reason: String(error.message || "Session setup failed.") }).catch(() => {});
      await acknowledge(command.id, "FAILED", String(error.message || "Session setup failed.")).catch(() => {});
      status("Could not start desktop sharing: " + (error.message || "Unknown error."), "danger");
    }
  }
  async function handleCommand(command) {
    if (handledCommands.has(command.id)) return;
    handledCommands.add(command.id); if (handledCommands.size > 500) handledCommands.clear();
    if (command.kind !== "RTC_SIGNAL") { await acknowledge(command.id, "REJECTED", "Desktop agent accepts only remote-session signaling."); return; }
    const signal = command.payload || {};
    if (signal.type === "OFFER") return acceptRemoteDesktopOffer(command);
    if (signal.type === "END" && String(signal.sessionId || "") === activeSessionId) { await stopSession(false); await acknowledge(command.id, "COMPLETED", "Desktop session ended."); status("The remote session ended. Device remains enrolled.", "good"); return; }
    await acknowledge(command.id, "COMPLETED", "Signal checked.");
  }
  async function heartbeat() {
    if (!credentials || !credentials.networkId || !credentials.deviceToken) return;
    const actions = Array.isArray(config.input?.actions) ? config.input.actions : [];
    const capabilities = ["FULL_DESKTOP_CAPTURE"];
    if (actions.includes("pointer")) capabilities.push("POINTER");
    if (actions.includes("click")) capabilities.push("CLICK");
    if (actions.includes("key")) capabilities.push("KEYBOARD");
    if (actions.includes("scroll")) capabilities.push("SCROLL");
    if (config.allowUnattended) capabilities.push("UNATTENDED_DESKTOP");
    await apiJson("/api/network/heartbeat", { method: "POST", body: JSON.stringify({
      networkId: credentials.networkId, deviceId: credentials.deviceId,
      name: config.deviceName, platform: "ADVIS Desktop Agent · " + config.platform + " " + config.architecture,
      agentVersion: config.agentVersion || "unknown", capabilities,
      unattendedReady: config.allowUnattended === true && Boolean(
        preparedStream && preparedStream.getVideoTracks().some(track => track.readyState === "live")
      ),
      foreground: document.visibilityState === "visible"
    }) });
  }
  async function pollCommands() {
    if (!credentials || !credentials.networkId || !credentials.deviceToken) return;
    const commands = await apiJson("/api/network/commands?networkId=" + encodeURIComponent(credentials.networkId) + "&deviceId=" + encodeURIComponent(credentials.deviceId));
    for (const command of commands) await handleCommand(command);
  }
  function startLoops() {
    if (!config || !config.enrolled || pollTimer || heartbeatTimer) return;
    let stopped = false;
    let pollDelay = 1800;
    let heartbeatDelay = 5000;
    const stopLoops = () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
    };
    const handleFailure = async (error, lane) => {
      const statusCode = Number(error.status);
      if (statusCode === 401 || statusCode === 410 || statusCode === 403) {
        stopLoops();
        await stopSession(false);
        status("This device's network access was revoked or is no longer valid. The desktop session has been stopped. Re-enrol with a fresh owner invitation.", "danger");
        return;
      }
      if (lane === "poll") pollDelay = Math.min(30000, Math.max(1800, pollDelay * 2));
      else heartbeatDelay = Math.min(60000, Math.max(5000, heartbeatDelay * 2));
      status("Cloud sync issue: " + (error.message || "Network unavailable.") + " · retrying automatically.", "warn");
    };
    const runPoll = async () => {
      if (stopped) return;
      try { await pollCommands(); pollDelay = 1800; }
      catch (error) { await handleFailure(error, "poll"); }
      if (!stopped) pollTimer = setTimeout(runPoll, pollDelay);
    };
    const runHeartbeat = async () => {
      if (stopped) return;
      try { await heartbeat(); heartbeatDelay = 5000; }
      catch (error) { await handleFailure(error, "heartbeat"); }
      if (!stopped) heartbeatTimer = setTimeout(runHeartbeat, heartbeatDelay);
    };
    void runPoll();
    void runHeartbeat();
  }
  async function init() {
    try {
      config = await api.getConfig(); credentials = await api.getCredentials();
      endpoint.value = config.endpoint; name.value = config.deviceName; unattended.checked = config.allowUnattended;
      if (config.enrolled) startLoops(); await refreshDisplays();
      const inputMethod = config.input && config.input.supported ? config.input.method : "unsupported";
      status((config.enrolled ? "ENROLLED · " : "NOT ENROLLED · ") + config.platform + " " + config.architecture + "\n" + "Secure storage: " + (config.secureStorageAvailable ? "ready" : "unavailable") + "\n" + "Screen permission: " + config.screenPermission + "\n" + "Native input: " + inputMethod + "\n" + "Unattended access: " + (config.allowUnattended ? "ON · screen preparation required after this app launches" : "OFF"));
    } catch (error) { status(error.message || "Agent initialisation failed.", "danger"); }
  }
  $("enroll").addEventListener("click", enroll);
  $("save").addEventListener("click", saveSettings);
  $("refreshScreens").addEventListener("click", () => refreshDisplays().catch(error => status(error.message, "warn")));
  $("stop").addEventListener("click", () => stopSession(true));
  $("permissions").addEventListener("click", async () => { if (config && config.platform === "darwin") { await api.openPermissions("screen"); await api.openPermissions("accessibility"); } });
  $("autostart").addEventListener("click", async () => { try { config = await api.setAutostart(true); status("ADVIS Desktop Agent will launch when you sign in.", "good"); } catch (error) { status(error.message || "Could not enable launch at login.", "warn"); } });
  api.onSessionStopped(() => { void stopSession(false); status("Session stopped locally. ADVIS Desktop Agent remains available in the tray.", "good"); });
  api.onStatus(value => { config = { ...config, ...value }; });
  init();
})();