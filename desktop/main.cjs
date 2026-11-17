const { app, BrowserWindow, ipcMain, desktopCapturer, session, safeStorage, systemPreferences, shell, Tray, Menu, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { dispatchNativeInput, getNativeInputCapabilities } = require("./native-input.cjs");

let mainWindow = null;
let tray = null;
let sessionActive = false;
let isQuitting = false;
let config = { endpoint: "https://advis-ebon.vercel.app", deviceId: "", deviceName: os.hostname() || "ADVIS Desktop", networkId: "", deviceToken: "", allowUnattended: false, startAtLogin: false, displaySourceId: "" };

function configPath() { return path.join(app.getPath("userData"), "trusted-device.json"); }
function nativeResourcePath() { return app.isPackaged ? path.join(process.resourcesPath, "native") : path.join(__dirname, "native"); }
function loadConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (stored && stored.encrypted && safeStorage.isEncryptionAvailable()) config = { ...config, ...JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, "base64"))) };
    config.allowUnattended = config.allowUnattended === true;
  } catch (error) { if (error.code !== "ENOENT") console.error("[ADVIS Agent] Settings load failed:", error.message); }
}
function publicConfig() {
  let screenPermission = "managed-by-operating-system";
  if (process.platform === "darwin") { try { screenPermission = systemPreferences.getMediaAccessStatus("screen"); } catch (_) {} }
  return { endpoint: config.endpoint, deviceId: config.deviceId, deviceName: config.deviceName, networkId: config.networkId, enrolled: Boolean(config.networkId && config.deviceToken), allowUnattended: config.allowUnattended, startAtLogin: config.startAtLogin, secureStorageAvailable: safeStorage.isEncryptionAvailable(), screenPermission, sessionActive, platform: process.platform, architecture: process.arch, input: getNativeInputCapabilities(process.platform) };
}
function saveConfig(next) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable.");
  const allowed = { endpoint: String(next.endpoint || config.endpoint), deviceId: String(next.deviceId || config.deviceId), deviceName: String(next.deviceName || config.deviceName).slice(0,48), networkId: String(next.networkId || config.networkId), deviceToken: String(next.deviceToken || config.deviceToken), allowUnattended: next.allowUnattended === true, startAtLogin: next.startAtLogin === true, displaySourceId: String(next.displaySourceId || config.displaySourceId) };
  const encrypted = safeStorage.encryptString(JSON.stringify(allowed)).toString("base64");
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ encrypted }), { mode: 0o600 });
  config = allowed;
  if (process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: allowed.startAtLogin, args: ["--autostart"] });
  return publicConfig();
}
async function listDisplays() {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  return sources.map((source, index) => ({ id: source.id, name: source.name || ("Display " + (index + 1)) }));
}
function updateTray() {
  if (!tray) return;
  tray.setToolTip(sessionActive ? "ADVIS Desktop Agent · DESKTOP SESSION ACTIVE" : "ADVIS Desktop Agent · enrolled and idle");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open ADVIS Desktop Agent", click: () => mainWindow && mainWindow.show() }, { label: sessionActive ? "Desktop session active" : "No active session", enabled: false }, { label: "Stop active session", enabled: sessionActive, click: () => stopAgentSession() }, { type: "separator" }, { label: "Quit ADVIS Desktop Agent", click: () => app.quit() }]));
}
function createTray() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13" fill="#061522" stroke="#36c5f0" stroke-width="2"/></svg>';
  tray = new Tray(nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")));
  updateTray();
  tray.on("double-click", () => mainWindow && mainWindow.show());
}
function stopAgentSession() {
  sessionActive = false;
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  if (mainWindow) mainWindow.webContents.send("agent:session-stopped");
  updateTray();
}
function installDisplayCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    // Capture can only be requested from the local agent renderer. The renderer
    // invokes getDisplayMedia from the one-time local setup action; remote offers
    // reuse that stream and never trigger a new browser picker.
    if (!mainWindow || mainWindow.isDestroyed()) return callback(null);
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === config.displaySourceId) || sources[0];
      if (!source) return callback(null);
      callback({ video: source });
    } catch (error) { console.error("[ADVIS Agent] Capture source lookup failed:", error.message); callback(null); }
  }, { useSystemPicker: false });
}
function createWindow() {
  mainWindow = new BrowserWindow({ width: 820, height: 760, minWidth: 620, minHeight: 580, title: "ADVIS Desktop Agent", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", event => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, "agent.html"));
  mainWindow.on("close", event => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } });
}
ipcMain.handle("agent:config:get", () => publicConfig());
ipcMain.handle("agent:credentials:get", () => ({ endpoint: config.endpoint, networkId: config.networkId, deviceId: config.deviceId, deviceToken: config.deviceToken }));
ipcMain.handle("agent:config:save", (_event, next) => saveConfig(next || {}));
ipcMain.handle("agent:displays:list", () => listDisplays());
ipcMain.handle("agent:session:start", async () => {
  if (!config.allowUnattended) throw new Error("Unattended desktop sessions are OFF on this device.");
  const permission = publicConfig().screenPermission;
  if (permission === "denied" || permission === "restricted") throw new Error("The OS has not granted screen-recording permission to ADVIS Desktop Agent.");
  sessionActive = true; installDisplayCaptureHandler(); updateTray();
  if (mainWindow) mainWindow.webContents.send("agent:status", publicConfig());
  return publicConfig();
});
ipcMain.handle("agent:session:stop", () => { sessionActive = false; session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback(null)); updateTray(); return publicConfig(); });
ipcMain.handle("agent:input", async (_event, input) => {
  if (!sessionActive || !config.allowUnattended) throw new Error("No authorised desktop session is active.");
  if (!input || typeof input !== "object") throw new Error("Invalid remote input event.");
  const normalized = { ...input };
  if (["pointer", "click"].includes(normalized.kind)) {
    const x = Number(normalized.x), y = Number(normalized.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error("Remote pointer coordinates are invalid.");
    const size = screen.getPrimaryDisplay().size;
    normalized.x = Math.round(x * size.width); normalized.y = Math.round(y * size.height);
  }
  return dispatchNativeInput(normalized, process.platform, nativeResourcePath());
});
ipcMain.handle("agent:autostart:set", (_event, enabled) => {
  if (process.platform === "linux") throw new Error("Automatic launch is not configured for this Linux desktop session.");
  config.startAtLogin = enabled === true;
  return saveConfig(config);
});
ipcMain.handle("agent:permissions:open", async (_event, kind) => {
  if (process.platform !== "darwin") return false;
  const target = kind === "accessibility" ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  await shell.openExternal(target); return true;
});
ipcMain.handle("agent:quit", () => app.quit());
app.whenReady().then(() => { loadConfig(); installDisplayCaptureHandler(); createTray(); createWindow(); if (process.platform !== "linux" && config.startAtLogin) app.setLoginItemSettings({ openAtLogin: true, args: ["--autostart"] }); });
app.on("before-quit", () => { isQuitting = true; stopAgentSession(); });
app.on("window-all-closed", () => {});