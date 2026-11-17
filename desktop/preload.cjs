const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("advisAgent", Object.freeze({
  getConfig: () => ipcRenderer.invoke("agent:config:get"),
  saveConfig: value => ipcRenderer.invoke("agent:config:save", value),
  listDisplays: () => ipcRenderer.invoke("agent:displays:list"),
  startSession: () => ipcRenderer.invoke("agent:session:start"),
  stopSession: () => ipcRenderer.invoke("agent:session:stop"),
  input: value => ipcRenderer.invoke("agent:input", value),
  setAutostart: value => ipcRenderer.invoke("agent:autostart:set", value),
  openPermissions: kind => ipcRenderer.invoke("agent:permissions:open", kind),
  quit: () => ipcRenderer.invoke("agent:quit"),
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on("agent:status", listener); return () => ipcRenderer.removeListener("agent:status", listener); },
  onSessionStopped: callback => { const listener = () => callback(); ipcRenderer.on("agent:session-stopped", listener); return () => ipcRenderer.removeListener("agent:session-stopped", listener); }
}));