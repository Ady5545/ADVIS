import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Link2, Radio, RefreshCw, Send, ShieldCheck, Smartphone, Monitor, X, Check, AlertTriangle } from "lucide-react";

type Device = {
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
  status: "ONLINE" | "OFFLINE";
  current?: boolean;
};

type IncomingControl = {
  id: string;
  fromDeviceId: string;
  fromDeviceName: string;
  payload: { action: string; [key: string]: any };
  source?: "cloud" | "tab";
  fromTabId?: string;
  requestId?: string;
};

type LocalTab = {
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
};

const NETWORK_KEY = "advis_network_id";
const SECRET_KEY = "advis_network_secret";
const TOKEN_KEY = "advis_device_token";
const DEVICE_KEY = "advis_device_id";
const NAME_KEY = "advis_device_name";

function randomId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  bytes.forEach(value => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return /Samsung/i.test(ua) ? "Samsung Android" : "Android device";
  if (/iPhone|iPad/i.test(ua)) return "Apple mobile device";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux device";
  return "ADVIS device";
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Network request failed.");
  return data;
}

export function DeviceNetwork({ visible = false }: { visible?: boolean }) {
  const [networkId, setNetworkId] = useState(() => localStorage.getItem(NETWORK_KEY) || "");
  const [networkSecret, setNetworkSecret] = useState(() => localStorage.getItem(SECRET_KEY) || "");
  const [deviceToken, setDeviceToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem(DEVICE_KEY) || randomId());
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem(NAME_KEY) || deviceLabel());
  const [devices, setDevices] = useState<Device[]>([]);
  // A fresh ID per open tab lets same-origin ADVIS tabs discover one another
  // without invitations, accounts, or shared localStorage credentials.
  const [tabId] = useState(() => randomId());
  const [localTabs, setLocalTabs] = useState<LocalTab[]>([]);
  const tabChannel = useRef<BroadcastChannel | null>(null);
  const [inviteInput, setInviteInput] = useState("");
  const [selectedDevice, setSelectedDevice] = useState("");
  const [message, setMessage] = useState("");
  const [controlAction, setControlAction] = useState("DISPLAY_MODEL");
  const [modelId, setModelId] = useState("v8_engine");
  const [spatialMode, setSpatialMode] = useState("INSPECTION");
  const [targetView, setTargetView] = useState("home");
  const [speakText, setSpeakText] = useState("");
  const [activity, setActivity] = useState<Array<{ id: string; title: string; detail: string; at: number }>>([]);
  const [incoming, setIncoming] = useState<IncomingControl | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState(0);
  const handled = useRef(new Set<string>());
  const autoNetworkStarted = useRef(false);



  useEffect(() => {
    localStorage.setItem(DEVICE_KEY, deviceId);
    localStorage.setItem(NAME_KEY, deviceName);
  }, [deviceId, deviceName]);

  const authHeaders = useCallback(() => ({
    "Content-Type": "application/json",
    Authorization: "Bearer " + deviceToken
  }), [deviceToken]);

  const addActivity = useCallback((title: string, detail: string) => {
    setActivity(prev => [{ id: randomId(), title, detail, at: Date.now() }, ...prev].slice(0, 12));
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      setError("This browser does not support automatic tab discovery. Try a current version of Chrome, Edge, or Firefox.");
      return;
    }
    const channel = new BroadcastChannel("advis-browser-tabs-v1");
    tabChannel.current = channel;
    const announce = () => channel.postMessage({
      type: "TAB_HEARTBEAT",
      tabId,
      name: deviceName + " · ADVIS tab",
      platform: navigator.userAgent,
      lastSeen: Date.now()
    });
    const onMessage = (event: MessageEvent) => {
      const data = event.data || {};
      if (!data || data.tabId === tabId || data.toTabId && data.toTabId !== tabId) return;
      if (data.type === "TAB_HEARTBEAT") {
        setLocalTabs(previous => {
          const next = previous.filter(tab => tab.id !== data.tabId);
          return [...next, {
            id: String(data.tabId),
            name: String(data.name || "ADVIS tab"),
            platform: String(data.platform || "Browser"),
            lastSeen: Number(data.lastSeen || Date.now())
          }];
        });
      } else if (data.type === "CONTROL_REQUEST") {
        const requestId = String(data.requestId || "");
        if (!requestId || handled.current.has(requestId)) return;
        handled.current.add(requestId);
        setIncoming({
          id: requestId,
          fromDeviceId: String(data.fromTabId || ""),
          fromDeviceName: String(data.fromTabName || "Another ADVIS tab"),
          payload: data.payload || {},
          source: "tab",
          fromTabId: String(data.fromTabId || ""),
          requestId
        });
        addActivity("TAB CONTROL REQUEST", String(data.fromTabName || "Another tab") + " requested " + String(data.payload?.action || "control"));
      } else if (data.type === "CONTROL_RESULT" && data.toTabId === tabId) {
        addActivity(
          data.status === "APPROVED" ? "TAB CONTROL APPROVED" : "TAB CONTROL REJECTED",
          data.status === "APPROVED" ? "The selected ADVIS tab accepted the control request." : "The selected ADVIS tab declined the request."
        );
      } else if (data.type === "TAB_GOODBYE") {
        setLocalTabs(previous => previous.filter(tab => tab.id !== data.tabId));
      }
    };
    channel.addEventListener("message", onMessage);
    announce();
    const heartbeat = window.setInterval(() => {
      announce();
      const cutoff = Date.now() - 7000;
      setLocalTabs(previous => previous.filter(tab => tab.lastSeen > cutoff));
    }, 2000);
    return () => {
      channel.postMessage({ type: "TAB_GOODBYE", tabId });
      window.clearInterval(heartbeat);
      channel.removeEventListener("message", onMessage);
      channel.close();
      tabChannel.current = null;
    };
  }, [tabId, deviceName, addActivity]);

  const saveCredentials = useCallback((id: string, secret: string, token: string) => {
    localStorage.setItem(NETWORK_KEY, id);
    localStorage.setItem(SECRET_KEY, secret);
    localStorage.setItem(TOKEN_KEY, token);
    setNetworkId(id);
    setNetworkSecret(secret);
    setDeviceToken(token);
  }, []);

  const createNetwork = async () => {
    setBusy(true);
    setError("");
    try {
      const id = randomId();
      const secret = randomSecret();
      const result = await readJson(await fetch("/api/network/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkId: id, networkSecret: secret, deviceId, name: deviceName, platform: navigator.userAgent })
      }));
      saveCredentials(id, secret, result.deviceToken);
      addActivity("NETWORK CREATED", "This device is the first node in your private ADVIS network.");
    } catch (e: any) {
      setError(e.message || "Could not create the device network.");
    } finally {
      setBusy(false);
    }
  };
  
  // First device quietly creates its private cloud network. Other devices join
  // through the owner's one-time invitation; subsequent discovery is automatic.
  useEffect(() => {
    if (autoNetworkStarted.current || networkId || deviceToken) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("advisNetwork") && url.searchParams.get("advisSecret")) return;
    autoNetworkStarted.current = true;
    void createNetwork();
  }, [networkId, deviceToken]);


  const joinNetwork = async (rawInvite: string) => {
    setBusy(true);
    setError("");
    try {
      let id = "";
      let secret = "";
      const raw = rawInvite.trim();
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        const url = new URL(raw);
        id = url.searchParams.get("advisNetwork") || "";
        secret = url.searchParams.get("advisSecret") || "";
      } else {
        const parts = raw.split(".");
        id = parts[0] || "";
        secret = parts[1] || "";
      }
      if (!id || !secret) throw new Error("Paste the complete ADVIS invitation link or network code.");
      const result = await readJson(await fetch("/api/network/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkId: id, networkSecret: secret, deviceId, name: deviceName, platform: navigator.userAgent })
      }));
      saveCredentials(id, secret, result.deviceToken);
      setInviteInput("");
      addActivity("DEVICE CONNECTED", "This device has joined the shared ADVIS network.");
      const url = new URL(window.location.href);
      url.searchParams.delete("advisNetwork");
      url.searchParams.delete("advisSecret");
      window.history.replaceState({}, "", url.toString());
    } catch (e: any) {
      setError(e.message || "Could not join the ADVIS network.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const invitedNetwork = url.searchParams.get("advisNetwork");
    const invitedSecret = url.searchParams.get("advisSecret");
    if (invitedNetwork && invitedSecret && !deviceToken) {
      setInviteInput(window.location.href);
    }
  }, [deviceToken]);

  const acknowledge = useCallback(async (commandId: string, status: string, result?: string) => {
    await fetch("/api/network/commands/" + encodeURIComponent(commandId) + "/ack", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ networkId, deviceId, status, result })
    }).then(readJson);
  }, [authHeaders, networkId, deviceId]);

  const sendCommand = useCallback(async (targetDeviceId: string, kind: string, payload: any, correlationId?: string) => {
    const result = await readJson(await fetch("/api/network/commands", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ networkId, deviceId, targetDeviceId, kind, payload, correlationId })
    }));
    return result;
  }, [authHeaders, networkId, deviceId]);

  useEffect(() => {
    if (!networkId || !deviceToken) return;
    let stopped = false;
    const sync = async () => {
      try {
        await fetch("/api/network/heartbeat", {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ networkId, deviceId, name: deviceName, platform: navigator.userAgent })
        }).then(readJson);
        const list = await readJson(await fetch(
          "/api/network/devices?networkId=" + encodeURIComponent(networkId) + "&deviceId=" + encodeURIComponent(deviceId),
          { headers: authHeaders() }
        ));
        if (!stopped) {
          setDevices(list);
          setLastSync(Date.now());
          if (!selectedDevice) {
            const firstOther = list.find((item: Device) => item.id !== deviceId && item.status === "ONLINE");
            if (firstOther) setSelectedDevice(firstOther.id);
          }
        }

        const commands = await readJson(await fetch(
          "/api/network/commands?networkId=" + encodeURIComponent(networkId) + "&deviceId=" + encodeURIComponent(deviceId),
          { headers: authHeaders() }
        ));
        for (const command of commands as any[]) {
          if (stopped || handled.current.has(command.id)) continue;
          handled.current.add(command.id);
          if (command.kind === "PROMPT") {
            const respond = async (reply: string) => {
              try {
                await sendCommand(command.fromDeviceId, "PROMPT_REPLY", { text: String(reply || "No response received.") }, command.correlationId);
                await acknowledge(command.id, "COMPLETED", "Prompt processed.");
              } catch (e: any) {
                await acknowledge(command.id, "FAILED", e.message || "Reply failed.");
              }
            };
            window.dispatchEvent(new CustomEvent("advis-remote-prompt", {
              detail: { text: String(command.payload?.text || ""), fromDeviceName: command.fromDeviceName, respond }
            }));
            addActivity("REMOTE MESSAGE", "Prompt received from " + command.fromDeviceName);
            await acknowledge(command.id, "DELIVERED");
          } else if (command.kind === "PROMPT_REPLY") {
            const reply = String(command.payload?.text || "");
            window.dispatchEvent(new CustomEvent("advis-remote-reply", { detail: { text: reply, fromDeviceName: command.fromDeviceName } }));
            addActivity("REMOTE REPLY", reply.slice(0, 110));
            await acknowledge(command.id, "COMPLETED");
          } else if (command.kind === "CONTROL") {
            setIncoming({
              id: command.id,
              fromDeviceId: command.fromDeviceId,
              fromDeviceName: command.fromDeviceName,
              payload: command.payload || {}
            });
            addActivity("CONTROL REQUEST", command.fromDeviceName + " requested " + String(command.payload?.action || "an action"));
            await acknowledge(command.id, "DELIVERED");
          }
        }
      } catch (e: any) {
        if (!stopped) setError(e.message || "Device network temporarily unavailable.");
      }
    };
    sync();
    const timer = window.setInterval(sync, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [networkId, deviceToken, deviceId, deviceName, selectedDevice, authHeaders, sendCommand, acknowledge, addActivity]);

  const inviteLink = useMemo(() => {
    if (!networkId || !networkSecret) return "";
    const url = new URL(window.location.href);
    url.searchParams.set("advisNetwork", networkId);
    url.searchParams.set("advisSecret", networkSecret);
    return url.toString();
  }, [networkId, networkSecret, lastSync]);

  const sendPrompt = async () => {
    if (!selectedDevice || !message.trim()) return;
    const text = message.trim();
    const correlationId = randomId();
    setMessage("");
    try {
      await sendCommand(selectedDevice, "PROMPT", { text }, correlationId);
      addActivity("MESSAGE SENT", "Sent to " + (devices.find(d => d.id === selectedDevice)?.name || "ADVIS device"));
    } catch (e: any) {
      setError(e.message || "Message could not be sent.");
    }
  };

  const sendTabControl = () => {
    const targetTabId = selectedDevice.startsWith("tab:") ? selectedDevice.slice(4) : "";
    if (!targetTabId || !tabChannel.current) return;
    const payload = controlAction === "DISPLAY_MODEL"
      ? { action: controlAction, modelId }
      : controlAction === "SET_MODE"
        ? { action: controlAction, mode: spatialMode }
        : controlAction === "OPEN_VIEW"
          ? { action: controlAction, view: targetView }
          : controlAction === "SPEAK"
            ? { action: controlAction, text: speakText.slice(0, 500) }
            : { action: controlAction };
    const requestId = randomId();
    tabChannel.current.postMessage({
      type: "CONTROL_REQUEST",
      toTabId: targetTabId,
      fromTabId: tabId,
      fromTabName: deviceName + " · ADVIS tab",
      requestId,
      payload
    });
    addActivity("CONTROL REQUEST SENT", controlAction.replace(/_/g, " ") + " → " + (localTabs.find(tab => tab.id === targetTabId)?.name || "ADVIS tab"));
  };

  const sendControl = async () => {
    if (!selectedDevice) return;
    if (selectedDevice.startsWith("tab:")) {
      sendTabControl();
      return;
    }
    const payload = controlAction === "DISPLAY_MODEL"
      ? { action: controlAction, modelId }
      : controlAction === "SET_MODE"
        ? { action: controlAction, mode: spatialMode }
        : controlAction === "OPEN_VIEW"
          ? { action: controlAction, view: targetView }
          : controlAction === "SPEAK"
            ? { action: controlAction, text: speakText.slice(0, 500) }
            : { action: controlAction };
    try {
      await sendCommand(selectedDevice, "CONTROL", payload);
      addActivity("CONTROL SENT", controlAction.replace(/_/g, " ") + " → " + (devices.find(d => d.id === selectedDevice)?.name || "device"));
    } catch (e: any) {
      setError(e.message || "Control request could not be sent.");
    }
  };

  const approveControl = async (approved: boolean) => {
    if (!incoming) return;
    try {
      if (incoming.source === "tab") {
        // The receiving tab executes the approved action locally. The requester
        // receives only the approval result, never a command to execute on itself.
        if (approved) {
          window.dispatchEvent(new CustomEvent("advis-remote-control-approved", { detail: incoming.payload }));
        }
        tabChannel.current?.postMessage({
          type: "CONTROL_RESULT",
          toTabId: incoming.fromTabId,
          requestId: incoming.requestId,
          status: approved ? "APPROVED" : "REJECTED"
        });
        addActivity(approved ? "TAB CONTROL ALLOWED" : "TAB CONTROL REJECTED", incoming.fromDeviceName);
      } else if (approved) {
        window.dispatchEvent(new CustomEvent("advis-remote-control-approved", { detail: incoming.payload }));
        await acknowledge(incoming.id, "COMPLETED", "Approved by the device owner.");
        addActivity("CONTROL APPROVED", incoming.payload.action.replace(/_/g, " "));
      } else if (incoming.source !== "tab") {
        await acknowledge(incoming.id, "REJECTED", "Rejected on the target device.");
        addActivity("CONTROL REJECTED", incoming.fromDeviceName);
      }
    } catch (e: any) {
      setError(e.message || "Could not record the control decision.");
    } finally {
      setIncoming(null);
    }
  };

  const disconnect = () => {
    localStorage.removeItem(NETWORK_KEY);
    localStorage.removeItem(SECRET_KEY);
    localStorage.removeItem(TOKEN_KEY);
    setNetworkId(""); setNetworkSecret(""); setDeviceToken(""); setDevices([]);
    addActivity("DEVICE DISCONNECTED", "This browser has left the ADVIS network.");
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 pointer-events-auto">
      <div className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl border border-cyan-400/30 bg-slate-950/95 p-5 shadow-[0_0_50px_rgba(0,180,255,0.16)] custom-scrollbar">
    <div className="flex flex-col gap-5 text-cyan-100">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-cyan-300 font-bold tracking-widest">ADVIS GLOBAL DEVICE NETWORK</h3>
          <p className="text-[11px] text-cyan-500/60 mt-1">Encrypted credentials · worldwide presence · consent-based control</p>
        </div>
        <span className={networkId && deviceToken ? "text-green-300 text-[10px] border border-green-400/30 bg-green-400/10 px-2 py-1 rounded" : "text-amber-300 text-[10px] border border-amber-400/30 bg-amber-400/10 px-2 py-1 rounded"}>
          {networkId && deviceToken ? "NETWORK LINKED" : "NOT CONNECTED"}
        </span>
      </div>

      {error && <div className="p-3 rounded border border-red-400/30 bg-red-950/40 text-red-200 text-xs flex gap-2"><AlertTriangle size={16}/>{error}<button className="ml-auto" onClick={() => setError("")}><X size={14}/></button></div>}

      <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-cyan-300 text-xs tracking-widest">OPEN ADVIS BROWSER TABS</h4>
            <p className="text-[10px] text-cyan-500/60 mt-1">Tabs on this browser and this ADVIS address appear automatically.</p>
          </div>
          <span className="text-[10px] text-green-300">{localTabs.length} ONLINE</span>
        </div>
        <div className="space-y-2">
          {localTabs.map(tab => (
            <button key={tab.id} onClick={() => setSelectedDevice("tab:" + tab.id)} className={"w-full flex items-center justify-between gap-3 p-3 rounded border text-left " + (selectedDevice === "tab:" + tab.id ? "border-cyan-300/60 bg-cyan-500/10" : "border-cyan-500/15 bg-slate-950/60")}>
              <span className="flex items-center gap-3 min-w-0">
                <Monitor size={18} className="text-cyan-300"/>
                <span className="min-w-0">
                  <span className="block text-xs text-cyan-100 truncate">{tab.name}</span>
                  <span className="block text-[10px] text-cyan-500/60">Same browser · ADVIS tab</span>
                </span>
              </span>
              <span className="text-[9px] text-green-300">ONLINE</span>
            </button>
          ))}
          {!localTabs.length && <p className="text-xs text-cyan-500/60">No other ADVIS tabs detected. Open ADVIS in another tab to see it here.</p>}
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <select value={controlAction} onChange={e => setControlAction(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs">
            <option value="DISPLAY_MODEL">Display a 3D model</option>
            <option value="CLOSE_MODEL">Close current model</option>
            <option value="SET_MODE">Set spatial mode</option>
            <option value="OPEN_VIEW">Open an ADVIS panel</option>
            <option value="SPEAK">Speak a message</option>
          </select>
          {controlAction === "DISPLAY_MODEL" && <input value={modelId} onChange={e => setModelId(e.target.value)} placeholder="Model ID (e.g. v8_engine)" className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"/>}
          {controlAction === "SET_MODE" && <select value={spatialMode} onChange={e => setSpatialMode(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"><option>INSPECTION</option><option>SHOWCASE</option><option>DEMO</option><option>EXPLODED</option></select>}
          {controlAction === "OPEN_VIEW" && <select value={targetView} onChange={e => setTargetView(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"><option value="home">Home</option><option value="memory">Memory</option><option value="history">History</option><option value="projects">Projects</option><option value="devices">Devices</option><option value="status">System Status</option><option value="settings">Settings</option></select>}
          {controlAction === "SPEAK" && <input value={speakText} onChange={e => setSpeakText(e.target.value)} maxLength={500} placeholder="Text for the other tab to speak" className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"/>}
          <button onClick={sendControl} disabled={!selectedDevice.startsWith("tab:")} className="bg-cyan-500/15 border border-cyan-400/40 rounded p-2 text-xs disabled:opacity-40">REQUEST TAB CONTROL</button>
        </div>
        <p className="text-[10px] text-cyan-500/60">The other tab must approve before its ADVIS interface responds. This first stage controls ADVIS inside the tab, not the browser chrome or the whole operating system.</p>
      </div>

      {!networkId || !deviceToken ? (
        <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-5 flex flex-col gap-3">
          {inviteInput ? (
            <>
              <div className="flex items-center gap-2 text-cyan-300"><ShieldCheck size={18}/> JOIN A TRUSTED ADVIS NETWORK</div>
              <p className="text-xs text-cyan-100/70 leading-relaxed">This invitation came from someone who already owns an ADVIS network. Joining makes this installation visible to that network. The owner still needs your approval before controlling this ADVIS tab.</p>
              <button disabled={busy} onClick={() => joinNetwork(inviteInput)} className="bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/40 rounded p-3 text-xs tracking-widest disabled:opacity-40">{busy ? "CONNECTING SECURELY..." : "JOIN TRUSTED NETWORK"}</button>
              <button onClick={() => setInviteInput("")} className="text-[10px] text-cyan-500/60 hover:text-cyan-300">CANCEL INVITATION</button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-cyan-300"><Radio size={18}/> INITIALISING GLOBAL ADVIS NETWORK</div>
              <p className="text-xs text-cyan-100/70 leading-relaxed">This ADVIS installation creates its private cloud network automatically. Once ready, share its one-time invitation link with the family members or devices you trust. They will appear here whenever they are online.</p>
              <button disabled={busy} onClick={createNetwork} className="bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/40 rounded p-2 text-xs tracking-widest disabled:opacity-40">{busy ? "INITIALISING..." : "RETRY NETWORK SETUP"}</button>
            </>
          )}
          {error && <p className="text-[10px] text-red-300">{error}</p>}
        </div>
      ) : (
        <>

          <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-4 flex flex-col gap-3">
            <div className="flex justify-between items-center gap-2">
              <div className="flex items-center gap-2 text-cyan-300"><ShieldCheck size={18}/> PRIVATE NETWORK INVITATION</div>
              <button onClick={() => navigator.clipboard.writeText(inviteLink)} className="flex gap-2 items-center text-[10px] border border-cyan-400/30 rounded px-3 py-1.5 hover:bg-cyan-500/10"><Copy size={13}/> COPY LINK</button>
            </div>
            <p className="text-[11px] text-cyan-100/60 break-all">{inviteLink}</p>
            <p className="text-[10px] text-amber-300/80">Treat this invitation like a private key. Anyone who has it can join this network. Disconnect a device you no longer trust.</p>
            <div className="flex justify-between items-center text-[10px] text-cyan-500/60">
              <span>LAST SYNC: {lastSync ? new Date(lastSync).toLocaleTimeString() : "SYNCING..."}</span>
              <button onClick={disconnect} className="text-red-300 hover:text-red-200">DISCONNECT THIS DEVICE</button>
            </div>
          </div>

          <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-cyan-300 text-xs tracking-widest">ONLINE ADVIS DEVICES</h4>
              <span className="text-[10px] text-cyan-500/60">{devices.filter(d => d.status === "ONLINE").length} ONLINE</span>
            </div>
            <div className="space-y-2">
              {devices.map(device => (
                <button key={device.id} onClick={() => setSelectedDevice(device.id)} className={"w-full flex items-center justify-between gap-3 p-3 rounded border text-left " + (selectedDevice === device.id ? "border-cyan-300/60 bg-cyan-500/10" : "border-cyan-500/15 bg-slate-950/60")}>
                  <div className="flex items-center gap-3 min-w-0">
                    {device.platform.match(/Android|iPhone|iPad/i) ? <Smartphone size={18} className="text-cyan-300"/> : <Monitor size={18} className="text-cyan-300"/>}
                    <div className="min-w-0">
                      <div className="text-xs text-cyan-100 truncate">{device.name} {device.current ? "(THIS DEVICE)" : ""}</div>
                      <div className="text-[10px] text-cyan-500/60 truncate">{device.platform}</div>
                    </div>
                  </div>
                  <span className={"text-[9px] " + (device.status === "ONLINE" ? "text-green-300" : "text-slate-500")}>{device.status}</span>
                </button>
              ))}
              {!devices.length && <p className="text-xs text-cyan-500/50">Waiting for network nodes...</p>}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-4 flex flex-col gap-3">
              <h4 className="text-cyan-300 text-xs tracking-widest">SEND A MESSAGE</h4>
              <select value={selectedDevice} onChange={e => setSelectedDevice(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs">
                <option value="">Select another device</option>
                {devices.filter(d => d.id !== deviceId && d.status === "ONLINE").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder="Ask the other ADVIS instance to do something..." className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs resize-y outline-none focus:border-cyan-300"/>
              <button onClick={sendPrompt} disabled={!selectedDevice || !message.trim()} className="flex justify-center items-center gap-2 bg-cyan-500/15 border border-cyan-400/40 rounded p-2 text-xs disabled:opacity-40"><Send size={14}/> SEND TO DEVICE</button>
            </div>
            <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-4 flex flex-col gap-3">
              <h4 className="text-cyan-300 text-xs tracking-widest">REMOTE ADVIS CONTROL</h4>
              <select value={controlAction} onChange={e => setControlAction(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs">
                <option value="DISPLAY_MODEL">Display a 3D model</option>
                <option value="CLOSE_MODEL">Close current model</option>
                <option value="SET_MODE">Set spatial mode</option>
                <option value="OPEN_VIEW">Open an ADVIS panel</option>
                <option value="SPEAK">Speak a message</option>
              </select>
              {controlAction === "DISPLAY_MODEL" && <input value={modelId} onChange={e => setModelId(e.target.value)} placeholder="Model ID (e.g. v8_engine)" className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"/>}
              {controlAction === "SET_MODE" && <select value={spatialMode} onChange={e => setSpatialMode(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"><option>INSPECTION</option><option>SHOWCASE</option><option>DEMO</option><option>EXPLODED</option></select>}
              {controlAction === "OPEN_VIEW" && <select value={targetView} onChange={e => setTargetView(e.target.value)} className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"><option value="home">Home</option><option value="memory">Memory</option><option value="history">History</option><option value="projects">Projects</option><option value="devices">Devices</option><option value="status">System Status</option><option value="settings">Settings</option></select>}
              {controlAction === "SPEAK" && <input value={speakText} onChange={e => setSpeakText(e.target.value)} maxLength={500} placeholder="Text for the other device to speak" className="bg-slate-950 border border-cyan-500/30 rounded p-2 text-xs"/>}
              <button onClick={sendControl} disabled={!selectedDevice || selectedDevice === deviceId} className="bg-cyan-500/15 border border-cyan-400/40 rounded p-2 text-xs disabled:opacity-40">REQUEST REMOTE ACTION</button>
              <p className="text-[10px] text-cyan-500/60">The receiving device must approve each control request before it executes.</p>
            </div>
          </div>
        </>
      )}

      {incoming && (
        <div className="bg-amber-950/30 border border-amber-400/40 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-amber-200"><AlertTriangle size={17}/> REMOTE CONTROL APPROVAL</div>
          <p className="text-xs text-amber-100/80">{incoming.fromDeviceName} requests: <strong>{incoming.payload.action.replace(/_/g, " ")}</strong></p>
          <div className="flex gap-2">
            <button onClick={() => approveControl(true)} className="flex-1 flex items-center justify-center gap-2 bg-green-500/15 border border-green-400/40 rounded p-2 text-xs"><Check size={14}/> ALLOW ONCE</button>
            <button onClick={() => approveControl(false)} className="flex-1 flex items-center justify-center gap-2 bg-red-500/10 border border-red-400/30 rounded p-2 text-xs"><X size={14}/> REJECT</button>
          </div>
        </div>
      )}

      <div className="bg-black/40 border border-cyan-500/15 rounded-xl p-4">
        <div className="flex items-center gap-2 text-cyan-300 text-xs tracking-widest mb-3"><RefreshCw size={14}/> NETWORK ACTIVITY</div>
        <div className="space-y-2 max-h-44 overflow-y-auto">
          {activity.map(item => <div key={item.id} className="flex justify-between gap-3 text-[10px] border-b border-cyan-500/10 pb-2"><div><span className="text-cyan-200">{item.title}</span><div className="text-cyan-500/60 mt-0.5">{item.detail}</div></div><span className="text-cyan-500/40 shrink-0">{new Date(item.at).toLocaleTimeString()}</span></div>)}
          {!activity.length && <p className="text-[10px] text-cyan-500/50">No network activity yet.</p>}
        </div>
      </div>
    </div>
      </div>
    </div>
  );
}
