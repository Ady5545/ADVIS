const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config();

const { processButlerTurn } = require("./ButlerEngine");
const crypto = require("crypto");
const { createFirebaseMemoryStore } = require("./src/FirebaseMemoryStore");
const {
  hashSecret: hashNetworkSecret,
  constantTimeHexEqual: secureEqualHex,
  safeNetworkId,
  safeDeviceId,
  createToken: createNetworkToken,
  createInvitationCode,
  createTurnCredentials
} = require("./src/DeviceNetworkSecurity.cjs");
const { validateSessionSignal } = require("./src/DeviceNetworkSessionSecurity.cjs");

async function createApp() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));

  // Lightweight health endpoint used by the host and deployment checks.
  app.get(["/health", "/api/health"], (_req, res) => {
    res.status(200).json({ status: "ok", service: "advis-core" });
  });

  // Mobile has a separately protected endpoint, so publishing the server does not
  // require embedding an AI provider secret in the Android app.
  function requireMobileToken(req, res, next) {
    const expected = process.env.ADVIS_MOBILE_API_TOKEN;
    if (!expected || expected.length < 32) {
      return res.status(503).json({
        reply: "Mobile Core authentication is not configured on the server.",
        status: "not_configured"
      });
    }

    const authorization = req.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const expectedBuffer = Buffer.from(expected, "utf8");
    const suppliedBuffer = Buffer.from(supplied, "utf8");
    const crypto = require("crypto");

    if (expectedBuffer.length !== suppliedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
      return res.status(401).json({
        reply: "Mobile Core authentication failed.",
        status: "unauthorized"
      });
    }

    next();
  }

  app.get("/api/mobile/health", requireMobileToken, (_req, res) => {
    res.status(200).json({ status: "ok", service: "advis-mobile-api" });
  });
  app.use('/models', express.static(path.join(process.cwd(), 'public', 'models'), { 
    maxAge: '1d', 
    etag: true, 
    lastModified: true,
    fallthrough: false
  }));


  // Vercel functions have an ephemeral filesystem. Use /tmp there to avoid read-only deployment writes; local development keeps .data in the project. Durable cross-instance memory requires an external database.
  const dataDir = process.env.VERCEL ? path.join("/tmp", "advis-data") : path.join(process.cwd(), ".data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const HISTORY_FILE = path.join(dataDir, "histories.json");
  const MEMORIES_FILE = path.join(dataDir, "memories.json");

  let chatHistories = {};
  const ADVIS_MEMORIES_FILE = path.join(dataDir, "advis_memories.json");
  const ADVIS_PROJECTS_FILE = path.join(dataDir, "advis_projects.json");
  let advisMemories = [];
  let advisProjects = [];
  let globalMemories = [];

  try {
    if (fs.existsSync(HISTORY_FILE)) {
      chatHistories = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
    if (fs.existsSync(MEMORIES_FILE)) {
      globalMemories = JSON.parse(fs.readFileSync(MEMORIES_FILE, "utf-8"));
    }
    if (fs.existsSync(ADVIS_MEMORIES_FILE)) {
      advisMemories = JSON.parse(fs.readFileSync(ADVIS_MEMORIES_FILE, "utf-8"));
    }
    if (fs.existsSync(ADVIS_PROJECTS_FILE)) {
      advisProjects = JSON.parse(fs.readFileSync(ADVIS_PROJECTS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to load data:", e);
  }

  const OWNER_HISTORY_KEY = "primary";
  const isLocalDevelopment = !process.env.VERCEL && process.env.NODE_ENV !== "production";
  let firebaseMemoryStore = null;
  let firebaseSetupError = null;
  try {
    firebaseMemoryStore = createFirebaseMemoryStore();
  } catch (error) {
    firebaseSetupError = error;
    console.error("[ADVIS Firebase] Configuration error:", error.message);
  }

  let firebaseWriteChain = Promise.resolve();

  async function loadCloudState() {
    if (!firebaseMemoryStore) return false;
    const remote = await firebaseMemoryStore.loadState();
    const remoteHasData = remote.memories.length || remote.projects.length || remote.history.length;
    const oldLocalHistory = Object.entries(chatHistories || {}).flatMap(([conversationId, messages]) =>
      (Array.isArray(messages) ? messages : []).map(message => ({ ...message, conversationId }))
    ).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const localHasData = advisMemories.length || advisProjects.length || oldLocalHistory.length;

    if (!remoteHasData && localHasData) {
      const migratedHistory = oldLocalHistory.slice(-2000);
      await firebaseMemoryStore.saveState({
        memories: advisMemories,
        projects: advisProjects,
        history: migratedHistory
      });
      chatHistories = {};
      for (const message of migratedHistory) {
        const conversationId = String(message.conversationId || OWNER_HISTORY_KEY);
        if (!chatHistories[conversationId]) chatHistories[conversationId] = [];
        const { conversationId: _conversationId, ...entry } = message;
        chatHistories[conversationId].push(entry);
      }
    } else {
      advisMemories = remote.memories || [];
      advisProjects = remote.projects || [];
      chatHistories = {};
      for (const message of (remote.history || [])) {
        const conversationId = String(message.conversationId || OWNER_HISTORY_KEY);
        if (!chatHistories[conversationId]) chatHistories[conversationId] = [];
        const { conversationId: _conversationId, ...entry } = message;
        chatHistories[conversationId].push(entry);
      }
    }
    return true;
  }

  async function refreshCloudState(req, res, next) {
    // ADVIS is intentionally open: loading the interface and using the core
    // never depends on a browser pairing cookie or a sign-in flow. Cloud memory
    // is an optional enhancement; if unavailable, continue with this instance's
    // in-memory state rather than blocking the entire assistant.
    if (!firebaseMemoryStore) return next();
    try {
      await loadCloudState();
    } catch (error) {
      console.error("[ADVIS Firebase] Cloud memory unavailable; continuing without cloud sync:", error);
    }
    return next();
  }

  function saveData() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistories, null, 2), "utf-8");
      fs.writeFileSync(MEMORIES_FILE, JSON.stringify(globalMemories, null, 2), "utf-8");
      fs.writeFileSync(ADVIS_MEMORIES_FILE, JSON.stringify(advisMemories, null, 2), "utf-8");
      fs.writeFileSync(ADVIS_PROJECTS_FILE, JSON.stringify(advisProjects, null, 2), "utf-8");
    } catch (e) {
      console.error("Failed to save local data:", e);
    }

    if (!firebaseMemoryStore) return Promise.resolve();
    const snapshot = {
      memories: advisMemories.map(memory => ({ ...memory })),
      projects: advisProjects.map(project => ({ ...project })),
      history: Object.entries(chatHistories || {}).flatMap(([conversationId, messages]) =>
        (Array.isArray(messages) ? messages : []).map(message => ({ ...message, conversationId }))
      ).slice(-2000)
    };
    const write = firebaseWriteChain.then(() => firebaseMemoryStore.saveState(snapshot));
    firebaseWriteChain = write.catch(error => {
      console.error("[ADVIS Firebase] Failed to persist owner state:", error);
    });
    return write;
  }

  // Direct-access mode: no browser pairing, account, sign-in, or owner cookie.
  // Firebase is used for shared persistence when configured, but never gates access.
  app.use(["/api/memory", "/api/projects", "/api/history", "/api/advis", "/api/jarvis"], refreshCloudState);

  // --- PRIVATE ADVIS DEVICE NETWORK ---
  // Vercel functions are stateless, so Firestore is the durable relay.
  // Devices poll for commands; no long-lived WebSocket server is required.
  const networkStore = firebaseMemoryStore;

  // Non-secret diagnostic. This checks the actual OAuth + Firestore read path,
  // not just whether a JavaScript adapter with expected methods was constructed.
  app.get("/api/network/status", async (_req, res) => {
    const requiredMethods = [
      "getNetwork", "createNetwork", "getNetworkDevice", "setNetworkDevice",
      "listNetworkDevices", "createNetworkCommand", "getNetworkCommand",
      "listNetworkCommands", "createNetworkInvite", "consumeNetworkInvite",
      "deleteNetworkDevice", "getNetworkSession", "createNetworkSession", "updateNetworkSession", "listNetworkSessions", "checkConnection"
    ];
    const adapterReady = Boolean(networkStore && requiredMethods.every(method =>
      typeof networkStore[method] === "function"
    ));

    let projectIdAvailable = Boolean(process.env.FIREBASE_PROJECT_ID);
    if (!projectIdAvailable && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        const account = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
        projectIdAvailable = Boolean(account.project_id);
      } catch (_) {}
    }

    const missing = [];
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) missing.push("FIREBASE_SERVICE_ACCOUNT_JSON");
    if (!projectIdAvailable) missing.push("FIREBASE_PROJECT_ID (or service-account project_id)");

    if (!adapterReady) {
      return res.json({
        configured: false,
        databaseConnected: false,
        state: "NOT_CONFIGURED",
        provider: "Firestore",
        missing,
        reason: firebaseSetupError
          ? "Firebase server configuration could not be initialized. Verify the service-account JSON and project settings."
          : "The server-side Firebase service account is not configured.",
        serverTime: Date.now()
      });
    }

    try {
      const probe = await networkStore.checkConnection();
      return res.json({
        configured: true,
        databaseConnected: true,
        state: "READY",
        provider: "Firestore",
        checkedAt: probe.checkedAt || Date.now(),
        serverTime: Date.now()
      });
    } catch (error) {
      const status = Number(error?.status || 0);
      let reason = "Firestore could not be reached. Check the Firebase project and service availability.";
      if (status === 401 || status === 403) {
        reason = "Firestore rejected the server credentials or permissions. Grant the service account access to the database.";
      } else if (status === 404) {
        reason = "The Firestore database or target path was not found. Confirm the database is initialized in the configured project.";
      }
      return res.json({
        configured: true,
        databaseConnected: false,
        state: "ERROR",
        provider: "Firestore",
        errorCode: status || "CONNECTION_FAILED",
        reason,
        serverTime: Date.now()
      });
    }
  });

  const allowedControlActions = new Set(["DISPLAY_MODEL", "CLOSE_MODEL", "SET_MODE", "OPEN_VIEW", "SPEAK", "START_REMOTE_SESSION"]);
  async function authenticateNetworkDevice(req, res) {
    if (!networkStore || !networkStore.getNetworkDevice) {
      res.status(503).json({ error: "ADVIS Device Network requires the configured Firestore connection." });
      return null;
    }
    const networkId = String(req.body?.networkId || req.query?.networkId || "");
    const deviceId = String(req.body?.deviceId || req.query?.deviceId || "");
    const authorization = req.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!safeNetworkId(networkId) || !safeDeviceId(deviceId) || token.length < 32) {
      res.status(401).json({ error: "Invalid device network credentials." });
      return null;
    }
    const [device, network] = await Promise.all([
      networkStore.getNetworkDevice(networkId, deviceId),
      networkStore.getNetwork(networkId)
    ]);
    if (!network || !network.ownerTokenHash) {
      res.status(410).json({ error: "This is a legacy shared-secret network. Create a new private network and re-enroll devices to enable one-time invites and owner revocation." });
      return null;
    }
    if (!device || !secureEqualHex(device.tokenHash, hashNetworkSecret(token))) {
      res.status(401).json({ error: "This ADVIS device is not registered on that network." });
      return null;
    }
    return { networkId, deviceId, device, network };
  }

  async function authenticateNetworkOwner(req, res) {
    const auth = await authenticateNetworkDevice(req, res);
    if (!auth) return null;
    const supplied = String(req.get("x-advis-owner-token") || "");
    if (auth.network.ownerDeviceId !== auth.deviceId ||
        !auth.network.ownerTokenHash ||
        supplied.length < 32 ||
        !secureEqualHex(auth.network.ownerTokenHash, hashNetworkSecret(supplied))) {
      res.status(403).json({ error: "Only the enrolled owner device can manage invitations and revoke devices." });
      return null;
    }
    return auth;
  }

  app.post("/api/network/create", async (req, res) => {
    try {
      if (!networkStore?.createNetwork) return res.status(503).json({ error: "Cloud device networking is unavailable until Firestore is configured." });
      const { networkId, deviceId, name, platform } = req.body || {};
      if (!safeNetworkId(networkId) || !safeDeviceId(deviceId)) {
        return res.status(400).json({ error: "A valid network and device identity are required." });
      }
      const ownerToken = createNetworkToken();
      const deviceToken = createNetworkToken();
      const now = Date.now();
      const network = {
        id: networkId,
        ownerTokenHash: hashNetworkSecret(ownerToken),
        ownerDeviceId: deviceId,
        createdAt: now,
        protocolVersion: 2
      };
      await networkStore.createNetwork(network);
      const device = {
        id: deviceId,
        name: String(name || "ADVIS Device").trim().slice(0, 64) || "ADVIS Device",
        platform: String(platform || "Unknown").slice(0, 80),
        tokenHash: hashNetworkSecret(deviceToken),
        createdAt: now,
        lastSeen: now,
        status: "ONLINE",
        role: "OWNER",
        capabilities: ["MESSAGE", "ADVIS_CONTROL", "BROWSER_TAB"]
      };
      await networkStore.setNetworkDevice(networkId, device);
      return res.status(201).json({ networkId, deviceId, deviceToken, ownerToken, ownerDeviceId: deviceId });
    } catch (error) {
      if (error.status === 409 || String(error.message).includes("ALREADY_EXISTS")) {
        return res.status(409).json({ error: "That network identity already exists. Generate a new one." });
      }
      console.error("[ADVIS Network] create:", error);
      return res.status(503).json({ error: "Could not create the ADVIS network." });
    }
  });

  app.post("/api/network/invites", async (req, res) => {
    try {
      const auth = await authenticateNetworkOwner(req, res);
      if (!auth) return;
      const code = createInvitationCode();
      const invite = {
        id: hashNetworkSecret(code),
        createdBy: auth.deviceId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60_000,
        usedAt: null
      };
      await networkStore.createNetworkInvite(auth.networkId, invite);
      return res.status(201).json({ networkId: auth.networkId, invitationCode: code, expiresAt: invite.expiresAt, singleUse: true });
    } catch (error) {
      console.error("[ADVIS Network] invite:", error);
      return res.status(503).json({ error: "Could not create a one-time device invitation." });
    }
  });

  app.post("/api/network/join", async (req, res) => {
    try {
      if (!networkStore?.getNetwork || !networkStore?.consumeNetworkInvite) {
        return res.status(503).json({ error: "Cloud device networking is unavailable until Firestore is configured." });
      }
      const { networkId, invitationCode, deviceId, name, platform } = req.body || {};
      if (!safeNetworkId(networkId) || !safeDeviceId(deviceId) || String(invitationCode || "").length < 24) {
        return res.status(400).json({ error: "A valid one-time invitation and device identity are required." });
      }
      const network = await networkStore.getNetwork(networkId);
      if (!network || !network.ownerTokenHash) {
        return res.status(403).json({ error: "This network uses the legacy invitation format. Create a new trusted network to enable one-time enrollment and owner controls." });
      }
      const claimed = await networkStore.consumeNetworkInvite(networkId, hashNetworkSecret(invitationCode));
      if (!claimed) return res.status(403).json({ error: "This invitation is invalid, expired, or already used. Ask the owner for a fresh code." });
      if (deviceId === network.ownerDeviceId) return res.status(409).json({ error: "The owner device is already enrolled." });
      const deviceToken = createNetworkToken();
      const now = Date.now();
      const device = {
        id: deviceId,
        name: String(name || "ADVIS Device").trim().slice(0, 64) || "ADVIS Device",
        platform: String(platform || "Unknown").slice(0, 80),
        tokenHash: hashNetworkSecret(deviceToken),
        createdAt: now,
        lastSeen: now,
        status: "ONLINE",
        role: "MEMBER",
        capabilities: ["MESSAGE", "ADVIS_CONTROL", "BROWSER_TAB"]
      };
      await networkStore.setNetworkDevice(networkId, device);
      return res.status(201).json({ networkId, deviceId, deviceToken });
    } catch (error) {
      console.error("[ADVIS Network] join:", error);
      return res.status(503).json({ error: "Could not join the ADVIS network." });
    }
  });

  app.post("/api/network/devices/:targetDeviceId/revoke", async (req, res) => {
    try {
      const auth = await authenticateNetworkOwner(req, res);
      if (!auth) return;
      const targetDeviceId = String(req.params.targetDeviceId || "");
      if (!safeDeviceId(targetDeviceId) || targetDeviceId === auth.deviceId) {
        return res.status(400).json({ error: "Choose another enrolled device. Transfer ownership before removing the owner device." });
      }
      const target = await networkStore.getNetworkDevice(auth.networkId, targetDeviceId);
      if (!target) return res.status(404).json({ error: "The selected device is not enrolled." });
      await networkStore.deleteNetworkDevice(auth.networkId, targetDeviceId);
      return res.json({ success: true, revokedDeviceId: targetDeviceId, revokedAt: Date.now() });
    } catch (error) {
      console.error("[ADVIS Network] revoke:", error);
      return res.status(503).json({ error: "Could not revoke the selected device." });
    }
  });

  app.post("/api/network/devices/revoke-all", async (req, res) => {
    try {
      const auth = await authenticateNetworkOwner(req, res);
      if (!auth) return;
      const devices = await networkStore.listNetworkDevices(auth.networkId);
      const targets = devices.filter(device => device.id !== auth.deviceId);
      for (const device of targets) {
        await networkStore.deleteNetworkDevice(auth.networkId, device.id);
      }
      return res.json({ success: true, revokedCount: targets.length, revokedAt: Date.now() });
    } catch (error) {
      console.error("[ADVIS Network] revoke all:", error);
      return res.status(503).json({ error: "Could not revoke all member devices." });
    }
  });

  app.post("/api/network/heartbeat", async (req, res) => {
    try {
      const auth = await authenticateNetworkDevice(req, res);
      if (!auth) return;
      const nextDevice = {
        ...auth.device,
        name: String(req.body.name || auth.device.name || "ADVIS Device").slice(0, 64),
        platform: String(req.body.platform || auth.device.platform || "Unknown").slice(0, 80),
        lastSeen: Date.now(), status: "ONLINE"
      };
      await networkStore.setNetworkDevice(auth.networkId, nextDevice);
      return res.json({ success: true, serverTime: Date.now() });
    } catch (error) {
      console.error("[ADVIS Network] heartbeat:", error);
      return res.status(503).json({ error: "Device heartbeat failed." });
    }
  });

  app.get("/api/network/devices", async (req, res) => {
    try {
      const auth = await authenticateNetworkDevice(req, res);
      if (!auth) return;
      const devices = await networkStore.listNetworkDevices(auth.networkId);
      const now = Date.now();
      return res.json(devices.map(device => ({
        id: device.id, name: device.name, platform: device.platform,
        role: device.role === "OWNER" ? "OWNER" : "MEMBER",
        createdAt: device.createdAt, lastSeen: device.lastSeen,
        status: now - Number(device.lastSeen || 0) < 35_000 ? "ONLINE" : "OFFLINE",
        current: device.id === auth.deviceId
      })));
    } catch (error) {
      console.error("[ADVIS Network] devices:", error);
      return res.status(503).json({ error: "Could not retrieve connected devices." });
    }
  });

  app.get("/api/network/ice-config", async (req, res) => {
    try {
      const auth = await authenticateNetworkDevice(req, res);
      if (!auth) return;
      const urls = String(process.env.ADVIS_TURN_URL || "").split(",").map(value => value.trim()).filter(Boolean);
      const secret = process.env.ADVIS_TURN_SECRET || "";
      const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      if (urls.length && secret) {
        const credentials = createTurnCredentials({ secret, deviceId: auth.deviceId, ttlSeconds: 600 });
        if (credentials) iceServers.push({ urls, username: credentials.username, credential: credentials.credential });
      }
      return res.json({ iceServers, relayConfigured: iceServers.length > 1, credentialsExpireAt: iceServers.length > 1 ? createTurnCredentials({ secret, deviceId: auth.deviceId, ttlSeconds: 600 }).expiresAt : null });
    } catch (error) {
      console.error("[ADVIS Network] ICE config:", error);
      return res.status(503).json({ error: "Could not prepare secure session connectivity." });
    }
  });

  app.post("/api/network/commands", async (req, res) => {
    try {
      const auth = await authenticateNetworkDevice(req, res);
      if (!auth) return;
      const { targetDeviceId, kind, payload, correlationId } = req.body || {};
      if (!safeDeviceId(targetDeviceId) || !["PROMPT", "CONTROL", "PROMPT_REPLY", "RTC_SIGNAL"].includes(kind)) {
        return res.status(400).json({ error: "Unsupported device command." });
      }
      if (kind === "CONTROL" && !allowedControlActions.has(payload?.action)) {
        return res.status(400).json({ error: "That remote control action is not supported." });
      }
      if (kind === "RTC_SIGNAL") {
        const signalTypes = new Set(["OFFER", "ANSWER", "ICE", "END"]);
        if (!safeDeviceId(payload?.sessionId) || !signalTypes.has(payload?.type) ||
            JSON.stringify(payload).length > 180_000) {
          return res.status(400).json({ error: "Invalid or oversized remote-session signal." });
        }
        if (payload.type === "OFFER" || payload.type === "ANSWER") {
          if (!payload.sdp || String(payload.sdp).length > 160_000) {
            return res.status(400).json({ error: "Remote-session description is invalid." });
          }
        }
        if (payload.type === "ICE" && (!payload.candidate || String(payload.candidate.candidate || "").length > 8_000)) {
          return res.status(400).json({ error: "Remote-session ICE candidate is invalid." });
        }
      }
      if (targetDeviceId === auth.deviceId) return res.status(400).json({ error: "A device cannot send a remote command to itself." });
      const target = await networkStore.getNetworkDevice(auth.networkId, targetDeviceId);
      if (!target) return res.status(404).json({ error: "Target ADVIS device was not found." });

      // Bind every WebRTC signal to one durable session and exactly two
      // enrolled devices. This blocks cross-pair injection and stale replay.
      if (kind === "RTC_SIGNAL") {
        const sessionId = String(payload.sessionId || "");
        let currentSession = await networkStore.getNetworkSession(auth.networkId, sessionId);
        let transition = validateSessionSignal({
          session: currentSession,
          networkId: auth.networkId,
          sessionId,
          senderDeviceId: auth.deviceId,
          targetDeviceId,
          signalType: payload.type,
          now: Date.now()
        });
        if (!transition.ok) {
          return res.status(transition.status || 409).json({ error: transition.error || "Remote session signal was rejected." });
        }
        if (transition.createSession) {
          try {
            await networkStore.createNetworkSession(auth.networkId, transition.createSession);
          } catch (createError) {
            if (createError.status !== 409 && !String(createError.message || "").includes("ALREADY_EXISTS")) throw createError;
            currentSession = await networkStore.getNetworkSession(auth.networkId, sessionId);
            transition = validateSessionSignal({
              session: currentSession, networkId: auth.networkId, sessionId,
              senderDeviceId: auth.deviceId, targetDeviceId, signalType: payload.type, now: Date.now()
            });
            if (!transition.ok || !transition.duplicate) {
              return res.status(409).json({ error: "That remote session identifier is already in use." });
            }
          }
        } else if (transition.nextSession) {
          try {
            await networkStore.updateNetworkSession(auth.networkId, transition.nextSession);
          } catch (updateError) {
            if (updateError.status === 409 || updateError.status === 400) {
              return res.status(409).json({ error: "Remote session state changed. Reconnect using a new session." });
            }
            throw updateError;
          }
        }
      }

      const command = {
        id: "cmd_" + crypto.randomBytes(18).toString("hex"),
        networkId: auth.networkId, fromDeviceId: auth.deviceId, fromDeviceName: auth.device.name,
        targetDeviceId, kind, payload: payload || {}, correlationId: correlationId || null,
        status: "PENDING", createdAt: Date.now(), expiresAt: Date.now() + 120_000
      };
      await networkStore.createNetworkCommand(auth.networkId, targetDeviceId, command);
      return res.status(201).json({ id: command.id, status: command.status, createdAt: command.createdAt });
    } catch (error) {
      console.error("[ADVIS Network] command create:", error);
      return res.status(503).json({ error: "Could not send the device command." });
    }
  });

  app.get("/api/network/commands", async (req, res) => {
    try {
      const auth = await authenticateNetworkDevice(req, res);
      if (!auth) return;
      const commands = await networkStore.listNetworkCommands(auth.networkId, auth.deviceId);
      const now = Date.now();
      return res.json(commands.filter(command =>
        command.targetDeviceId === auth.deviceId &&
        (command.status === "PENDING" || command.status === "DELIVERED") &&
        Number(command.expiresAt || 0) > now
      ).sort((a, b) => a.createdAt - b.createdAt).slice(0, 30));
    } catch (error) {
      console.error("[ADVIS Network] command poll:", error);
      return res.status(503).json({ error: "Could not retrieve device commands." });
    }
  });

  app.post("/api/network/commands/:id/ack", async (req, res) => {
    try {
      const auth = await authenticateNetworkDevice(req, res);
      if (!auth) return;
      const command = await networkStore.getNetworkCommand(auth.networkId, auth.deviceId, req.params.id);
      if (!command || command.targetDeviceId !== auth.deviceId) return res.status(404).json({ error: "Command not found for this device." });
      const status = String(req.body.status || "");
      if (!["DELIVERED", "COMPLETED", "REJECTED", "FAILED"].includes(status)) {
        return res.status(400).json({ error: "Invalid command acknowledgement." });
      }
      await networkStore.createNetworkCommand(auth.networkId, auth.deviceId, {
        ...command, status, updatedAt: Date.now(),
        result: req.body.result ? String(req.body.result).slice(0, 2000) : null
      });
      return res.json({ success: true });
    } catch (error) {
      console.error("[ADVIS Network] command ack:", error);
      return res.status(503).json({ error: "Could not acknowledge the command." });
    }
  });



  let aiInstance = null;

  function getRelevantMemories(userMessage, activeProjectId) {
    if (!advisMemories.length) return "";
    const stopWords = new Set(["the", "and", "for", "with", "that", "this", "have", "from", "about", "into", "what", "when", "where", "your", "you", "are", "was", "were", "does", "will", "would", "could", "should", "please", "make", "want"]);
    const words = String(userMessage || "").toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const queryTokens = Array.from(new Set(words.filter(word => !stopWords.has(word))));
    const currentProject = activeProjectId || null;

    const scored = advisMemories.map(memory => {
      const tags = Array.isArray(memory.tags) ? memory.tags : [];
      const memoryText = (String(memory.content || "") + " " + tags.join(" ")).toLowerCase();
      const memoryTokens = new Set(memoryText.match(/[a-z0-9_-]{3,}/g) || []);
      let overlap = 0;
      for (const token of queryTokens) {
        if (memoryTokens.has(token)) overlap += 1;
        else if (token.length >= 5 && Array.from(memoryTokens).some(candidate => candidate.includes(token) || token.includes(candidate))) overlap += 0.5;
      }

      const ageDays = Math.max(0, (Date.now() - Number(memory.updatedAt || memory.createdAt || Date.now())) / 86400000);
      const importance = Math.max(1, Math.min(10, Number(memory.importance || 5)));
      let score = overlap * 3 + importance * 0.45 + (memory.pinned ? 9 : 0);
      if (currentProject && memory.projectId === currentProject) score += 8;
      if (!memory.projectId) score += 1.5;
      if (ageDays < 7) score += 1.5;
      if (["PREFERENCE", "PERSONAL", "GOAL"].includes(memory.category)) score += 1.25;
      return { memory, score };
    });

    const pinned = scored.filter(item => item.memory.pinned);
    const globalProfile = scored
      .filter(item => !item.memory.projectId && ["PERSONAL", "PREFERENCE", "GOAL", "WORKSPACE"].includes(item.memory.category))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    const projectContext = currentProject
      ? scored.filter(item => item.memory.projectId === currentProject).sort((a, b) => b.score - a.score).slice(0, 16)
      : [];
    const queryRelevant = scored
      .filter(item => item.score >= 3.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);

    const selected = [];
    const seen = new Set();
    for (const item of [...pinned, ...globalProfile, ...projectContext, ...queryRelevant]) {
      if (seen.has(item.memory.id)) continue;
      seen.add(item.memory.id);
      selected.push(item.memory);
    }

    let usedChars = 0;
    const memoryLines = [];
    for (const memory of selected) {
      const line = "- [" + (memory.category || "GENERAL") +
        "; importance " + (memory.importance || 5) +
        (memory.pinned ? "; pinned" : "") + "] " +
        String(memory.content || "").slice(0, 900);
      if (usedChars + line.length > 14000) continue;
      memoryLines.push(line);
      usedChars += line.length;
      if (memoryLines.length >= 40) break;
    }

    if (!memoryLines.length) return "";
    return "\n\n[ADVIS LONG-TERM OWNER MEMORY — PRIVATE CONTEXT]\n" +
      "Use these durable facts as ongoing context across sessions and devices. Prefer current, project-specific facts over old conflicting facts. Never invent missing details.\n" +
      memoryLines.join("\n");
  }


  function getGeminiClient() {
    if (aiInstance) return aiInstance;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    try {
      const { GoogleGenAI } = require("@google/genai");
      aiInstance = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: { headers: { "User-Agent": "aistudio-build" } }
      });
      return aiInstance;
    } catch (err) {
      console.error("SDK Error:", err);
      return null;
    }
  }

  
  
  async function evaluateAndStoreMemory(userMessage, activeProjectId) {
    const client = getGeminiClient();
    if (!client) return;
    
    // Quick heuristic: skip greetings and fragments, but keep short explicit preferences/corrections.

    const lower = userMessage.toLowerCase();
    const isGreeting = ["hello", "hi", "hey", "good morning", "good evening"].includes(lower.trim());
    
    if (lower.includes("don't remember this") || lower.includes("do not remember this")) {
        console.log("[MEMORY_EVENT] Explicitly instructed NOT to remember.");
        return; 
    }
    
    const explicitPreferenceOrCorrection = /\b(use|prefer|always|never|keep|avoid|rather than|instead of|from now on|remember|call me|do not|don't|dont|change to|switch to|no longer|not)\b/i.test(userMessage);
    if (userMessage.split(/\s+/).filter(Boolean).length < 3 && !explicitPreferenceOrCorrection && !lower.includes("project")) {
        return; // Skip fragments, but preserve compact preferences and corrections.
    }
    if (isGreeting) return;

    try {
      // Gather relevant existing memories to let the LLM detect duplicates/contradictions
      let existingContext = advisMemories.slice(-160).map(m => `ID: ${m.id} | Project: ${m.projectId || 'GLOBAL'} | Category: ${m.category} | Content: ${m.content}`).join('\n');
      if (!existingContext) existingContext = "NONE";

      const prompt = `
You are the ADVIS Intelligence Context Evaluator.
Analyze the user's message and determine if it contains information worth committing to LONG-TERM persistent memory.

Active Project ID: ${activeProjectId || 'NONE'}

DO SAVE:
- Stable preferences, workflow preferences, architecture decisions, hardware specs, recurring goals.
- Explicit corrections, changed technical choices, project commitments, and updated facts that supersede prior memories.
- Important context the owner expects ADVIS to retain across browsers, devices, tabs and conversations.
- Short statements when they clearly express a lasting preference or correction (for example, "Use Firebase, not Supabase").

DO NOT SAVE (Ignore):
- Casual chatter, jokes, transient emotions ("I'm tired", "That's cool"), temporary debugging states, general questions.
- Passwords, API keys, service-account credentials, pairing codes, or other authentication secrets.

If you decide to save, review the existing memories below. If the new information conflicts with or updates an existing memory, you must UPDATE the existing one instead of creating a duplicate. If it's identical to an existing memory, IGNORE it.

EXISTING MEMORIES:
${existingContext}

Output JSON exactly like this:
{
  "action": "SAVE" | "UPDATE" | "IGNORE",
  "updateId": "The ID of the memory to update, if action is UPDATE",
  "category": "PERSONAL|PROJECT|HARDWARE|ENGINEERING|DEVELOPMENT|GOAL|PREFERENCE|WORKSPACE",
  "content": "A clear, standalone statement of fact.",
  "importance": <number 1-10>,
  "confidence": "HIGH|MEDIUM|LOW",
  "tags": ["relevant", "keywords"],
  "targetProjectName": "Name of project if explicitly mentioned, or null"
}

User Message: "${userMessage}"
`;
      
      const response = await client.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
        config: { temperature: 0.1, responseMimeType: "application/json" }
      });
      
      let evalData;
      try {
        evalData = JSON.parse(response.text.trim());
      } catch (e) {
        return;
      }

      if ((evalData.action === "SAVE" || evalData.action === "UPDATE") && (evalData.confidence === "HIGH" || evalData.confidence === "MEDIUM")) {
         // Determine projectId
         let pId = activeProjectId || null;
         if (evalData.targetProjectName) {
            const proj = advisProjects.find(p => p.name.toLowerCase().includes(evalData.targetProjectName.toLowerCase()));
            if (proj) pId = proj.id;
         }

         if (evalData.action === "UPDATE" && evalData.updateId) {
             const existingIdx = advisMemories.findIndex(m => m.id === evalData.updateId);
             if (existingIdx !== -1) {
                 console.log("[MEMORY_EVENT] MEMORY_UPDATED:", evalData.updateId);
                 advisMemories[existingIdx].content = evalData.content;
                 advisMemories[existingIdx].updatedAt = Date.now();
                 advisMemories[existingIdx].importance = Math.max(advisMemories[existingIdx].importance, evalData.importance);
                 if (evalData.tags && evalData.tags.length > 0) {
                     advisMemories[existingIdx].tags = Array.from(new Set([...advisMemories[existingIdx].tags, ...evalData.tags]));
                 }
                 await saveData();
                 return;
             }
         }
         
         // Create new memory
         const newMemory = {
           id: "mem_" + Date.now() + "_" + Math.floor(Math.random()*1000),
           category: evalData.category || 'PERSONAL',
           content: evalData.content,
           source: 'INFERENCE', // Automatically extracted
           createdAt: Date.now(),
           updatedAt: Date.now(),
           importance: evalData.importance || 5,
           tags: evalData.tags || [],
           projectId: pId,
           pinned: false,
           metadata: { confidence: evalData.confidence }
         };
         advisMemories.push(newMemory);
         await saveData();
         console.log("[MEMORY_EVENT] MEMORY_CREATED:", newMemory.id);
      }

    } catch (e) {
      console.error("Memory extraction error:", e);
    }
  }




  // --- ADVIS PRIVATE MEMORY AND PROJECT SERVICE ---
  app.get("/api/memory", (req, res) => {
    const projectId = req.query.projectId;
    const records = projectId ? advisMemories.filter(m => m.projectId === projectId) : advisMemories;
    res.json(records);
  });

  app.post("/api/memory", async (req, res) => {
    const { category, content, source, importance, tags, projectId, pinned, metadata } = req.body;
    if (!String(content || "").trim()) return res.status(400).json({ error: "Memory content is required." });
    const newMemory = {
      id: "mem_" + Date.now() + "_" + crypto.randomBytes(5).toString("hex"),
      category: category || "PERSONAL",
      content: String(content).trim(),
      source: source || "USER",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      importance: Math.max(1, Math.min(10, Number(importance) || 5)),
      tags: Array.isArray(tags) ? tags : [],
      projectId: projectId || null,
      pinned: !!pinned,
      metadata: metadata || {}
    };
    advisMemories.push(newMemory);
    try { await saveData(); } catch (error) { return res.status(503).json({ error: "Memory could not be saved to Firebase." }); }
    res.json(newMemory);
  });

  app.put("/api/memory/:id", async (req, res) => {
    const memIdx = advisMemories.findIndex(m => m.id === req.params.id);
    if (memIdx === -1) return res.status(404).json({ error: "Not found" });
    const updated = { ...advisMemories[memIdx], ...req.body, updatedAt: Date.now() };
    advisMemories[memIdx] = updated;
    try { await saveData(); } catch (error) { return res.status(503).json({ error: "Memory update could not be saved to Firebase." }); }
    res.json(updated);
  });

  app.delete("/api/memory/:id", async (req, res) => {
    const existing = advisMemories.find(memory => memory.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    advisMemories = advisMemories.filter(memory => memory.id !== req.params.id);
    try {
      if (firebaseMemoryStore) await firebaseMemoryStore.deleteMemory(req.params.id);
      await saveData();
    } catch (error) {
      advisMemories.push(existing);
      return res.status(503).json({ error: "Memory deletion could not be saved to Firebase." });
    }
    res.json({ success: true });
  });

  app.get("/api/memory/search", (req, res) => {
    const q = String(req.query.q || "").toLowerCase();
    const projectId = req.query.projectId;
    let results = advisMemories.filter(m =>
      String(m.content || "").toLowerCase().includes(q) ||
      (Array.isArray(m.tags) && m.tags.some(tag => String(tag).toLowerCase().includes(q)))
    );
    if (projectId) results = results.filter(m => m.projectId === projectId);
    res.json(results);
  });

  app.get("/api/projects", (_req, res) => res.json(advisProjects));

  app.post("/api/projects", async (req, res) => {
    const { name, description, status, tags } = req.body;
    if (!String(name || "").trim()) return res.status(400).json({ error: "Project name is required." });
    const newProject = {
      id: "proj_" + Date.now() + "_" + crypto.randomBytes(5).toString("hex"),
      name: String(name).trim(),
      description: description || "",
      status: status || "ACTIVE",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: Array.isArray(tags) ? tags : [],
      associatedMemories: []
    };
    advisProjects.push(newProject);
    try { await saveData(); } catch (error) { return res.status(503).json({ error: "Project could not be saved to Firebase." }); }
    res.json(newProject);
  });

  app.put("/api/projects/:id", async (req, res) => {
    const pIdx = advisProjects.findIndex(project => project.id === req.params.id);
    if (pIdx === -1) return res.status(404).json({ error: "Not found" });
    const updated = { ...advisProjects[pIdx], ...req.body, updatedAt: Date.now() };
    advisProjects[pIdx] = updated;
    try { await saveData(); } catch (error) { return res.status(503).json({ error: "Project update could not be saved to Firebase." }); }
    res.json(updated);
  });

  app.delete("/api/projects/:id", async (req, res) => {
    const existing = advisProjects.find(project => project.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    advisProjects = advisProjects.filter(project => project.id !== req.params.id);
    try {
      if (firebaseMemoryStore) await firebaseMemoryStore.deleteProject(req.params.id);
      await saveData();
    } catch (error) {
      advisProjects.push(existing);
      return res.status(503).json({ error: "Project deletion could not be saved to Firebase." });
    }
    res.json({ success: true });
  });

  app.get("/api/history", (req, res) => {
    if (req.query.mode === "list") {
      const conversations = Object.entries(chatHistories || {}).map(([id, messages]) => {
        const entries = Array.isArray(messages) ? messages : [];
        const firstUser = entries.find(message => message.role === "user");
        const latest = entries[entries.length - 1];
        return {
          id,
          title: String(firstUser?.content || "Untitled conversation").replace(/\\s+/g, " ").slice(0, 88),
          createdAt: Number(entries[0]?.timestamp) || 0,
          updatedAt: Number(latest?.timestamp) || 0,
          messageCount: entries.length
        };
      }).filter(conversation => conversation.messageCount > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return res.json(conversations);
    }
    const requestedId = String(req.query.conversationId || "");
    const legacyKey = isLocalDevelopment ? String(req.query.deviceId || "default") : OWNER_HISTORY_KEY;
    res.json(chatHistories[requestedId || legacyKey] || []);
  });

  app.get("/api/history/:conversationId", (req, res) => {
    const conversationId = String(req.params.conversationId || "");
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(conversationId)) return res.status(400).json({ error: "Invalid conversation ID." });
    return res.json(chatHistories[conversationId] || []);
  });

  const responseCache = {};

  // AGENT KNOWLEDGE BASES
  const heliomotionKnowledge = {
    "working principle": "HelioMotion uses a dual-axis tracking system. Four Light Dependent Resistors (LDRs) detect the sun's position. The Arduino Uno reads these sensors and commands two servo motors to adjust the solar panel's tilt and pan, ensuring it always faces the sun directly.",
    "arduino uno": "The Arduino Uno serves as the central microcontroller for HelioMotion. It reads analog values from the LDRs, calculates the difference in light intensity, and sends PWM signals to the servo motors to adjust the panel.",
    "servo": "HelioMotion uses two micro servo motors for dual-axis movement: one for horizontal tracking (azimuth) and one for vertical tracking (elevation).",
    "ldr": "Four Light Dependent Resistors are arranged in a cross pattern to detect light intensity differences across four quadrants.",
    "advantages": "By continuously tracking the sun, HelioMotion generates up to 40% more power compared to a fixed solar panel. It maximizes energy capture throughout the entire day.",
    "limitations": "Current limitations include the power consumption of the servo motors themselves, and the lack of weatherproofing for outdoor deployment.",
    "circuit": "The circuit consists of an Arduino Uno, two servo motors, and four LDRs connected with 10k ohm pull-down resistors to form voltage dividers.",
    "esp32": "Future iterations of HelioMotion will integrate an ESP32 microchip to enable Wi-Fi connectivity, IoT capabilities, and remote web-based monitoring.",
    "presentation": "HelioMotion is designed as an interactive science exhibition model to demonstrate renewable energy principles and automated control systems.",
    "dual-axis": "Dual-axis tracking means the system can follow the sun from east to west (azimuth) and adjust for the sun's height in the sky (elevation) across different seasons.",
    "exhibition": "For a science exhibition, you can explain that HelioMotion actively mimics how sunflowers track the sun, increasing solar yield significantly compared to static panels."
  };

  const localIntelKnowledge = {
    "who created you": "I was created by you, Sir, as an autonomous multi-agent AI operating system.",
    "who made you": "I was developed by you, Sir, to serve as your personal A.D.V.I.S. intelligence core.",
    "what are you": "I am A.D.V.I.S. (Ady's Digital Virtual Intelligence System), a multi-agent AI operating system designed to assist you with computer control, research, and technical diagnostics.",
    "hello": "Hello, Sir. How may I assist you today?",
    "hi": "Greetings, Sir. I am online and ready.",
    "good morning": "Good morning, Sir. All systems are operating at optimal capacity.",
    "good evening": "Good evening, Sir. I am standing by for your directives.",
    "how are you": "I am operating at 100% efficiency, Sir. Thank you for asking."
  };

  // DECISION ENGINE (MASTER BRAIN)
  function masterBrainRoute(message, hasImage) {
    const lower = message.toLowerCase().trim();
    if (hasImage) return "VISION_AGENT";

    // 1. Hardcoded / System Commands
    if (lower === "clear chat" || lower === "clear console" || lower === "clear screen" || lower === "clear history") {
      return "SYSTEM_CLEAR";
    }

    // Bypass execution/host controls for 3D Holographic / Spatial Actions
    if (detectSpatialAction(message)) {
      return "CONVERSATION_AGENT";
    }

    // 2. Computer Control Agent (Execution)
    const execKeywords = ["open ", "launch ", "start ", "close ", "increase ", "decrease ", "mute ", "take a screenshot", "lock the computer", "create a new folder", "search google for "];
    if (execKeywords.some(k => lower.includes(k) || lower.startsWith(k))) {
      return "EXECUTION_AGENT";
    }

    // 3. HelioMotion Knowledge Agent
    const helioKeywords = ["heliomotion", "arduino", "solar tracker", "servo", "ldr", "dual-axis", "esp32", "science exhibition"];
    if (helioKeywords.some(k => lower.includes(k))) {
      return "HELIOMOTION_AGENT";
    }

    // 4. Planning Agent
    const planKeywords = ["timer", "alarm", "remind", "schedule"];
    if (planKeywords.some(k => lower.startsWith("set a " + k) || lower.startsWith(k))) {
      return "PLANNING_AGENT";
    }

    // 5. Diagnostics Agent
    const diagKeywords = ["battery", "system health", "status", "diagnostic", "cpu", "ram"];
    if (diagKeywords.some(k => lower.includes("what is my " + k) || lower === k || lower.includes("check " + k))) {
      return "DIAGNOSTICS_AGENT";
    }

    // 6. Local Intelligence (FAQ / Identity)
    if (Object.keys(localIntelKnowledge).some(k => lower.includes(k))) {
      return "LOCAL_INTEL_AGENT";
    }

    // 7. Memory Agent
    if (lower.includes("what did i say") || lower.includes("what are my preferences") || lower.startsWith("remember ")) {
      return "MEMORY_AGENT";
    }

    // 8. Search Agent (Time sensitive / Live info)
    const searchKeywords = ["weather", "news", "time", "stock", "score", "latest", "current", "today", "who won", "price of"];
    if (searchKeywords.some(k => lower.includes(k))) {
      return "SEARCH_AGENT";
    }

    // 9. Default Conversation (Gemini)
    return "CONVERSATION_AGENT";
  }

  function handleExecutionAgent(message) {
    const lower = message.toLowerCase();
    
    // Explicit internet search delegation
    if (lower.startsWith("search google for ")) {
      const query = message.substring(18);
      return `Initiating Google Search for "${query}", Sir.`;
    }

    // OS Controls
    if (lower.includes("increase volume") || lower.includes("volume up")) return "I have adjusted the internal media volume, Sir. Note that host system volume cannot be modified directly from this environment.";
    if (lower.includes("decrease volume") || lower.includes("volume down")) return "I have adjusted the internal media volume, Sir.";
    if (lower.includes("mute audio") || lower.includes("mute volume") || lower.includes("mute")) return "Audio muted internally, Sir.";
    if (lower.includes("decrease brightness") || lower.includes("increase brightness")) return "I cannot directly adjust your physical monitor brightness from this environment, Sir.";
    if (lower.includes("screenshot") || lower.includes("take a screen shot")) return "I do not have host file system access to save a screenshot, Sir. Please use your operating system's screenshot utility.";
    if (lower.includes("lock the computer") || lower.includes("lock computer") || lower.includes("lock screen")) return "I cannot lock your host operating system from this sandbox, Sir.";
    if (lower.includes("create a new folder") || lower.includes("new folder")) return "I cannot write directly to your host file system to create folders, Sir.";

    // App/File Launching
    if (lower.includes("chrome") || lower.includes("browser")) return "I am unable to launch external applications like Chrome from this web-based environment, Sir.";
    if (lower.includes("whatsapp")) return "I cannot launch desktop applications like WhatsApp directly from here, Sir.";
    if (lower.includes("arduino ide")) return "I cannot open the Arduino IDE directly, Sir, but I am ready to assist with any code you need.";
    if (lower.includes("vs code") || lower.includes("visual studio code")) return "I am restricted from launching external IDEs, Sir.";
    if (lower.includes("youtube")) return "I cannot open external applications, Sir, but you can navigate to YouTube in a new tab.";
    if (lower.includes("downloads")) return "I do not have access to your local Downloads folder for security reasons, Sir.";
    if (lower.includes("presentation")) return "I am unable to access local files to open your presentation, Sir.";
    if (lower.includes("calculator")) return "I cannot open the OS calculator, Sir, but I can perform any calculations you need right here.";
    if (lower.includes("terminal") || lower.includes("command prompt")) return "I cannot open a system terminal on your machine, Sir, for security reasons.";
    if (lower.includes("documents")) return "I am restricted from accessing your local Documents folder, Sir.";
    if (lower.includes("camera")) return "I am already utilizing the camera feed for my vision systems, Sir.";
    if (lower.includes("settings")) return "I do not have access to your host operating system settings, Sir.";

    return "I am currently running in a sandboxed environment and cannot execute host operating system commands, Sir.";
  }

  function handleHelioMotionAgent(message) {
    const lower = message.toLowerCase();
    let response = "";
    for (const [key, value] of Object.entries(heliomotionKnowledge)) {
      if (lower.includes(key)) {
        response += value + " ";
      }
    }
    if (!response) {
      return "HelioMotion is our dual-axis solar tracking system powered by an Arduino Uno. It utilizes LDRs to detect light and servos to adjust the panel for maximum efficiency.";
    }
    return response.trim();
  }

  function handleLocalIntelAgent(message) {
    const lower = message.toLowerCase();
    for (const [key, value] of Object.entries(localIntelKnowledge)) {
      if (lower.includes(key)) {
        return value;
      }
    }
    return "I am processing that locally, Sir.";
  }

  
  async function handleMemoryAgent(message, activeProjectId) {
    const lower = message.toLowerCase();
    
    if (lower.includes("what is my active project")) {
       if (!activeProjectId) return "You currently have no active project set, Sir.";
       const proj = advisProjects.find(p => p.id === activeProjectId);
       if (proj) return `Your current active project is ${proj.name} (${proj.description}).`;
       return "You have an active project ID, but I cannot find its details in the database, Sir.";
    }
    
    if (lower.startsWith("switch to the ")) {
       const targetName = lower.replace("switch to the ", "").replace(" project", "").trim();
       const proj = advisProjects.find(p => p.name.toLowerCase().includes(targetName));
       if (proj) {
         return `PROJECT_SWITCH:${proj.id}`; // Special signal to UI to change state, handled later
       }
       return `I could not find a project matching "${targetName}", Sir. Please create it first.`;
    }

    const client = getGeminiClient();
    if (!client) return "My memory banks are currently offline due to a missing AI connection.";

    // Let's use Gemini to parse the memory intent
    const prompt = `
You are the ADVIS Memory Intent Parser.
Analyze the following user command: "${message}"

Current Active Project ID: ${activeProjectId || 'NONE'}

Available Categories: PERSONAL, PROJECT, HARDWARE, ENGINEERING, DEVELOPMENT, GOAL, PREFERENCE, WORKSPACE

Decide what action to take:
1. STORE: If the user wants to remember a new fact.
2. DELETE: If the user wants to forget a fact.
3. RETRIEVE: If the user is asking what is remembered.

Output JSON only, in this exact format:
{
  "action": "STORE" | "DELETE" | "RETRIEVE",
  "category": "ONE_OF_THE_CATEGORIES",
  "content": "The fact to store, delete, or retrieve query",
  "tags": ["relevant", "tags"],
  "targetProjectName": "Optional name of project if mentioned (e.g. 'V12 project')"
}
`;
    
    try {
      const response = await client.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: prompt,
        config: { temperature: 0.1, responseMimeType: "application/json" }
      });
      
      const intent = JSON.parse(response.text.trim());
      
      if (intent.action === "STORE") {
         let pId = activeProjectId;
         if (intent.targetProjectName) {
            const proj = advisProjects.find(p => p.name.toLowerCase().includes(intent.targetProjectName.toLowerCase()));
            if (proj) pId = proj.id;
         }
         const newMemory = {
           id: "mem_" + Date.now() + "_" + Math.floor(Math.random()*1000),
           category: intent.category,
           content: intent.content,
           source: 'USER',
           createdAt: Date.now(),
           updatedAt: Date.now(),
           importance: 5,
           tags: intent.tags,
           projectId: pId,
           pinned: false,
           metadata: {}
         };
         advisMemories.push(newMemory);
         await saveData();
         return "Saved to my memory.";
      } 
      else if (intent.action === "DELETE") {
         // Simple exact or partial match delete
         const idx = advisMemories.findIndex(m => m.content.toLowerCase().includes(intent.content.toLowerCase()) || intent.content.toLowerCase().includes(m.content.toLowerCase()));
         if (idx !== -1) {
            const removed = advisMemories.splice(idx, 1)[0];
            try {
              if (firebaseMemoryStore) await firebaseMemoryStore.deleteMemory(removed.id);
              await saveData();
            } catch (error) {
              advisMemories.splice(idx, 0, removed);
              throw error;
            }
            return "I've removed that from my memory.";
         }
         return "I couldn't find a matching memory to remove.";
      }
      else if (intent.action === "RETRIEVE") {
         let results = advisMemories.filter(m => m.content.toLowerCase().includes(intent.content.toLowerCase()) || m.tags.some(t => intent.content.toLowerCase().includes(t.toLowerCase())));
         if (results.length === 0) {
            // fallback to returning active project memories or all
            if (activeProjectId) {
               results = advisMemories.filter(m => m.projectId === activeProjectId);
            } else {
               results = advisMemories.slice(-5);
            }
         }
         if (results.length === 0) return "I don't have a specific memory of that.";
         return `Based on my memory databanks:\n${results.map((m, i) => `${i+1}. ${m.content}`).join('\n')}`;
      }
    } catch (e) {
      console.error(e);
      return "I couldn't access my memory store just now.";
    }
    return "Memory operation completed.";
  }


  const SPATIAL_REGISTRY = {
    arduino_uno: 'AVAILABLE',
    esp32: 'AVAILABLE',
    raspberry_pi: 'AVAILABLE',
    sg90_servo: 'AVAILABLE',
    stepper_motor: 'AVAILABLE',
    dc_motor: 'AVAILABLE',
    brushless_motor: 'AVAILABLE',
    breadboard: 'AVAILABLE',
    relay_module: 'AVAILABLE',
    ultrasonic_sensor: 'AVAILABLE',
    ldr_sensor: 'AVAILABLE',
    resistor_10k: 'AVAILABLE',
    solar_panel: 'AVAILABLE',
    silicon_pv_cell: 'AVAILABLE',
    solar_semiconductor: 'AVAILABLE',
    lcd_display: 'AVAILABLE',
    v12_engine: 'AVAILABLE',
    inline4_engine: 'AVAILABLE',
    v8_engine: 'AVAILABLE',
    turbocharger: 'AVAILABLE',
    differential: 'AVAILABLE',
    gearbox: 'AVAILABLE',
    suspension: 'AVAILABLE',
    brake_disc: 'AVAILABLE',
    steering_assembly: 'AVAILABLE',
    human_heart: 'AVAILABLE',
    human_brain: 'AVAILABLE',
    human_lungs: 'AVAILABLE',
    human_eye: 'AVAILABLE',
    human_skeleton: 'AVAILABLE',
    electron: 'AVAILABLE',
    hydrogen_atom: 'AVAILABLE',
    atomic_nucleus: 'AVAILABLE',
    magnetic_field: 'AVAILABLE',
    earth: 'AVAILABLE',
    moon: 'AVAILABLE',
    solar_system: 'AVAILABLE',
    iss: 'AVAILABLE',
    satellite: 'AVAILABLE',
    heliomotion: 'AVAILABLE'
  };

  const MODEL_SYNONYMS = {
    arduino_uno: ['arduino', 'uno', 'microcontroller', 'arduino board', 'arduino uno'],
    esp32: ['esp32', 'esp', 'esp 32', 'esp-32'],
    raspberry_pi: ['raspberry pi', 'rpi', 'raspberry', 'pi 4'],
    sg90_servo: ['servo motor', 'servo', 'sg90', 'micro servo'],
    stepper_motor: ['stepper motor', 'stepper', 'nema 17', 'nema17'],
    dc_motor: ['dc motor', 'direct current motor', 'brushed motor'],
    brushless_motor: ['brushless motor', 'bldc', 'brushless', 'bldc motor'],
    breadboard: ['breadboard', 'solderless breadboard', 'prototyping board'],
    relay_module: ['relay', 'relay module', '5v relay'],
    ultrasonic_sensor: ['ultrasonic', 'ultrasonic sensor', 'hc-sr04', 'hcsr04', 'distance sensor'],
    ldr_sensor: ['ldr', 'ldr sensor', 'photoresistor', 'light sensor'],
    resistor_10k: ['resistor', '10k resistor', 'pull down resistor'],
    solar_panel: ['solar panel', 'photovoltaic panel', 'pv panel'],
    silicon_pv_cell: ['silicon cell', 'silicon photovoltaic cell', 'photovoltaic cell', 'pv cell'],
    solar_semiconductor: ['solar semiconductor', 'semiconductor structure', 'silicon semiconductor', 'p-n junction', 'pn junction'],
    lcd_display: ['lcd', 'lcd display', '16x2 lcd', 'character lcd'],
    v12_engine: ['v12 engine', 'v12', 'v12 model', 'engine model', 'engine'],
    inline4_engine: ['inline 4', 'inline-4', 'i4 engine', '4 cylinder'],
    v8_engine: ['v8 engine', 'v8', 'v8 combustion'],
    turbocharger: ['turbocharger', 'turbo', 'twin scroll turbo'],
    differential: ['differential', 'lsd', 'limited slip differential'],
    gearbox: ['gearbox', 'transmission', '6 speed transmission'],
    suspension: ['suspension', 'macpherson', 'strut suspension', 'coil spring'],
    brake_disc: ['brake disc', 'brake', 'carbon brake', 'rotor'],
    steering_assembly: ['steering', 'rack and pinion', 'steering rack'],
    human_heart: ['human heart', 'heart', 'cardiac'],
    human_brain: ['human brain', 'brain', 'cerebrum'],
    human_lungs: ['human lungs', 'lungs', 'respiratory'],
    human_eye: ['human eye', 'eye', 'eyeball'],
    human_skeleton: ['human skeleton', 'skeleton', 'bones', 'skull'],
    electron: ['electron', 'electron cloud', 'orbital cloud'],
    hydrogen_atom: ['hydrogen', 'hydrogen atom', 'bohr atom'],
    atomic_nucleus: ['nucleus', 'atomic nucleus', 'carbon-12', 'carbon 12'],
    magnetic_field: ['magnetic field', 'magnet', 'dipole', 'flux lines'],
    earth: ['earth', 'planet earth', 'globe'],
    moon: ['moon', 'lunar'],
    solar_system: ['solar system', 'planets'],
    iss: ['iss', 'space station', 'international space station'],
    satellite: ['satellite', 'communication satellite', 'comsat'],
    heliomotion: ['heliomotion', 'solar tracker']
  };

  const SCIENTIFIC_ENTITIES = {
    "glucose": { formula: "C6H12O6", name: "Glucose" },
    "c6h12o6": { formula: "C6H12O6", name: "Glucose" },
    "d-glucose": { formula: "C6H12O6", name: "Glucose" },
    "sugar": { formula: "C6H12O6", name: "Glucose" },
    
    "water": { formula: "H2O", name: "Water" },
    "h2o": { formula: "H2O", name: "Water" },
    "dihydrogen monoxide": { formula: "H2O", name: "Water" },
    
    "boron trifluoride": { formula: "BF3", name: "Boron Trifluoride" },
    "bf3": { formula: "BF3", name: "Boron Trifluoride" },
    
    "benzene": { formula: "C6H6", name: "Benzene" },
    "c6h6": { formula: "C6H6", name: "Benzene" },
    "benzol": { formula: "C6H6", name: "Benzene" },
    
    "ethanol": { formula: "C2H5OH", name: "Ethanol" },
    "c2h5oh": { formula: "C2H5OH", name: "Ethanol" },
    "ethyl alcohol": { formula: "C2H5OH", name: "Ethanol" },
    "alcohol": { formula: "C2H5OH", name: "Ethanol" },
    "c2": { formula: "C2H5OH", name: "Ethanol" },
    "c2)": { formula: "C2H5OH", name: "Ethanol" },
    
    "methane": { formula: "CH4", name: "Methane" },
    "ch4": { formula: "CH4", name: "Methane" },
    "natural gas": { formula: "CH4", name: "Methane" },
    
    "ammonia": { formula: "NH3", name: "Ammonia" },
    "nh3": { formula: "NH3", name: "Ammonia" },
    
    "carbon dioxide": { formula: "CO2", name: "Carbon Dioxide" },
    "co2": { formula: "CO2", name: "Carbon Dioxide" },
    
    "sodium chloride": { formula: "NaCl", name: "Sodium Chloride" },
    "nacl": { formula: "NaCl", name: "Sodium Chloride" },
    "table salt": { formula: "NaCl", name: "Sodium Chloride" },
    "salt": { formula: "NaCl", name: "Sodium Chloride" },
    
    "oxygen": { formula: "O2", name: "Oxygen Gas" },
    "oxygen gas": { formula: "O2", name: "Oxygen Gas" },
    "o2": { formula: "O2", name: "Oxygen Gas" },
    
    "nitrogen": { formula: "N2", name: "Nitrogen Gas" },
    "nitrogen gas": { formula: "N2", name: "Nitrogen Gas" },
    "n2": { formula: "N2", name: "Nitrogen Gas" }
  };

  function resolveScientificEntityServer(msg) {
    if (!msg) return null;
    let str = msg.trim().toLowerCase();
    str = str.replace(/₀/g, '0').replace(/₁/g, '1').replace(/₂/g, '2').replace(/₃/g, '3')
             .replace(/₄/g, '4').replace(/₅/g, '5').replace(/₆/g, '6').replace(/₇/g, '7')
             .replace(/₈/g, '8').replace(/₉/g, '9');
    str = str.replace(/[\)\}\]\s]+$/, '');

    for (const [key, obj] of Object.entries(SCIENTIFIC_ENTITIES)) {
      const regex = new RegExp(`\\b${key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (regex.test(str) || str === key) {
        return obj;
      }
    }
    return null;
  }

  function detectSpatialAction(message) {
    const lower = message.toLowerCase().trim();
    if (lower === "stop" || lower === "close" || lower === "hide" || lower === "remove" || lower === "clear" || lower === "stop visualization" || lower === "hide molecule" || lower === "close molecule" || lower === "remove molecule" || lower === "clear visualization" || lower === "remove this" || lower.includes("close the model") || lower.includes("hide the model") || lower.includes("remove the model") || lower.includes("close model") || lower.includes("hide model") || lower.includes("remove model") || lower.includes("clear spatial") || lower.includes("unload model") || lower.includes("close visualization") || lower.includes("hide visualization")) {
      return { type: "CLOSE" };
    }
    
    if (lower.includes("showcase mode") || lower.includes("showcase view") || lower.includes("showcase") || lower.includes("cinematic view") || lower.includes("auto rotate") || lower.includes("cinematic mode")) {
      return { type: "SHOWCASE" };
    }
    if (lower.includes("inspection mode") || lower.includes("inspect mode") || lower.includes("manual control") || lower.includes("stop rotation") || lower.includes("stop auto") || lower.includes("interactive mode")) {
      return { type: "INSPECTION" };
    }
    if (lower.includes("demo mode") || lower.includes("demonstration mode") || lower.includes("guided tour") || lower.includes("guided demo")) {
      return { type: "DEMO" };
    }

    if (lower.includes("explode heliomotion") || lower.includes("separate the components") || lower.includes("separate components") || lower.includes("exploded view") || lower.includes("explode the model") || lower.includes("separate the parts") || lower.includes("separate parts") || lower.includes("exploded visualization")) {
      return { type: "EXPLODE", value: true };
    }
    if (lower.includes("assemble heliomotion") || lower.includes("assemble the components") || lower.includes("assemble components") || lower.includes("re-assemble") || lower.includes("normal view") || lower.includes("assemble the parts") || lower.includes("assemble parts") || lower.includes("collapse view") || lower.includes("collapse parts")) {
      return { type: "EXPLODE", value: false };
    }
    if (lower.includes("label heliomotion") || lower.includes("show labels") || lower.includes("enable labels") || lower.startsWith("label")) {
      return { type: "LABEL", value: true };
    }
    if (lower.includes("hide labels") || lower.includes("remove labels")) {
      return { type: "LABEL", value: false };
    }
    if (lower.includes("explain this") || lower.includes("what is this part") || lower.includes("tell me about this") || lower.includes("explain the selected") || lower.includes("explain component")) {
      return { type: "EXPLAIN" };
    }

    if (lower.includes("move component") || lower.includes("shift component")) {
      let axis = 'z';
      if (lower.includes(" x ") || lower.includes("left") || lower.includes("right")) axis = 'x';
      if (lower.includes(" y ") || lower.includes("up") || lower.includes("down")) axis = 'y';
      if (lower.includes("z") || lower.includes("forward") || lower.includes("backward")) axis = 'z';
      
      let delta = 0.2;
      const numMatch = message.match(/[-+]?[0-9]*\.?[0-9]+/);
      if (numMatch) delta = parseFloat(numMatch[0]);
      if (lower.includes("left") || lower.includes("down") || lower.includes("back")) delta = -Math.abs(delta);
      else if (lower.includes("right") || lower.includes("up") || lower.includes("forward")) delta = Math.abs(delta);

      return { type: "ENGINEERING_TRANSFORM", actionType: "MOVE", axis, delta };
    }
    if (lower.includes("rotate component")) {
      let axis = 'y';
      if (lower.includes(" x ")) axis = 'x';
      if (lower.includes(" y ")) axis = 'y';
      if (lower.includes(" z ")) axis = 'z';

      let angle = 0.5;
      const numMatch = message.match(/[-+]?[0-9]*\.?[0-9]+/);
      if (numMatch) {
        let val = parseFloat(numMatch[0]);
        if (lower.includes("deg")) val = val * (Math.PI / 180);
        angle = val;
      }
      return { type: "ENGINEERING_TRANSFORM", actionType: "ROTATE", axis, angle };
    }
    if (lower.includes("scale component") || lower.includes("resize component")) {
      let factor = 1.2;
      const numMatch = message.match(/[-+]?[0-9]*\.?[0-9]+/);
      if (numMatch) factor = parseFloat(numMatch[0]);
      return { type: "ENGINEERING_TRANSFORM", actionType: "SCALE", factor };
    }
    if (lower.includes("reset component") || lower.includes("reset transform")) {
      return { type: "ENGINEERING_TRANSFORM", actionType: "RESET" };
    }

    const isDisplay = lower.includes("show") || lower.includes("display") || lower.includes("project") || lower.includes("hologram") || lower.includes("load") || lower.includes("and") || lower.includes(",");
    const isPresent = lower.includes("present") || lower.includes("demonstrate");

    if (isDisplay || isPresent || Object.values(MODEL_SYNONYMS).some(syns => syns.some(s => lower.includes(s)))) {
      const foundIds = [];
      for (const [id, synonyms] of Object.entries(MODEL_SYNONYMS)) {
        if (synonyms.some(s => lower.includes(s))) {
          if (!foundIds.includes(id)) {
            foundIds.push(id);
          }
        }
      }
      if (foundIds.length > 0) {
        const mode = (lower.includes("showcase mode") || lower.includes("showcase")) ? "SHOWCASE" : (isPresent ? "DEMO" : undefined);
        return {
          type: isPresent ? "PRESENT" : "DISPLAY",
          objectIds: foundIds.length > 1 ? foundIds : undefined,
          objectId: foundIds.length === 1 ? foundIds[0] : undefined,
          mode: mode
        };
      }
    }
    return null;
  }

  const handleAdvisRequest = async (req, res) => {
    const { 
      message, 
      mode, 
      deviceId: _clientDeviceId = 'default',
      conversationId: requestedConversationId,
      image, 
      currentSpatialObject, 
      selectedComponentId, 
      hoveredComponentId, 
      activeProjectId,
      butlerContext: clientButlerContext
    } = req.body;

    if (!message) return res.status(400).json({ error: "Protocol violation: Message payload is empty." });

    const requestedId = String(requestedConversationId || "");
    const conversationKey = /^[A-Za-z0-9_-]{8,120}$/.test(requestedId)
      ? requestedId
      : (isLocalDevelopment ? String(_clientDeviceId || "default") : OWNER_HISTORY_KEY);
    const deviceId = conversationKey;
    if (!chatHistories[deviceId]) chatHistories[deviceId] = [];

    const clientContext = clientButlerContext || {
      activeProjectId,
      activeWorkspace: currentSpatialObject ? 'SPATIAL' : 'HUD',
      activeSpatialObject: currentSpatialObject,
      selectedComponentId,
      hoveredComponentId,
      recentActions: []
    };

    // Conversation transcripts stay separate in the interface, but ADVIS can
    // consult a compact cross-device window of recent discussion as context.
    const sharedRecentConversation = Object.entries(chatHistories || {})
      .flatMap(([sourceConversationId, entries]) => (Array.isArray(entries) ? entries : []).map(entry => ({
        role: entry.role,
        content: entry.content,
        timestamp: Number(entry.timestamp) || 0,
        sourceConversationId
      })))
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-24);

    const butlerContext = {
      ...clientContext,
      recentConversation: sharedRecentConversation
    };

    try {
      const result = await processButlerTurn({
        message,
        mode,
        deviceId,
        image,
        butlerContext,
        advisMemories,
        advisProjects,
        chatHistories,
        saveData,
        getRelevantMemories,
        getGeminiClient,
        SPATIAL_REGISTRY,
        MODEL_SYNONYMS,
        SCIENTIFIC_ENTITIES,
        detectSpatialAction,
        resolveScientificEntityServer,
        handleMemoryAgent,
        handleExecutionAgent,
        handleHelioMotionAgent,
        handleLocalIntelAgent,
        masterBrainRoute
      });

      // Memory extraction is part of the turn's durable write path, not a fire-and-forget task.
      await evaluateAndStoreMemory(message, butlerContext ? butlerContext.activeProjectId : null);
      await saveData();
      return res.json(result);
    } catch (err) {
      console.error("[Butler API] Core Exception:", err);
      return res.json({
        reply: "My core systems experienced an error processing that request.",
        mode: mode || "normal",
        status: "error"
      });
    }
  };

  // Browser clients retain their existing endpoint. Android uses the protected
  // route and sends the mobile token as an Authorization: Bearer header.
  app.post(["/api/advis", "/api/jarvis"], handleAdvisRequest);
  app.post("/api/mobile/advis", requireMobileToken, refreshCloudState, handleAdvisRequest);

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = require("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.use((req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

if (require.main === module) {
  createApp()
    .then((app) => {
      const PORT = Number(process.env.PORT) || 3000;
      app.listen(PORT, "0.0.0.0", () => {
        console.log("===================================================");
        console.log("STARK INDUSTRIES A.D.V.I.S. HUD SERVER ONLINE");
        console.log("Holographic frequencies broadcasted on Port " + PORT);
        console.log("===================================================");
      });
    })
    .catch((error) => {
      console.error("Failed to start ADVIS server:", error);
      process.exitCode = 1;
    });
}

module.exports = { createApp };
