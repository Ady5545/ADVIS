import React, { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Radio, RefreshCw, Send, ShieldCheck, Smartphone, Monitor, X, Check, AlertTriangle, MonitorPlay, Square } from "lucide-react";

type Device = {
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
  status: "ONLINE" | "OFFLINE";
  current?: boolean;
  role?: "OWNER" | "MEMBER";
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

type RemoteSessionRequest = {
  sessionId: string;
  fromDeviceId: string;
  fromDeviceName: string;
  sdp: string;
};

const NETWORK_KEY = "advis_network_id";
const OWNER_TOKEN_KEY = "advis_network_owner_token";
const TOKEN_KEY = "advis_device_token";
const DEVICE_KEY = "advis_device_id";
const NAME_KEY = "advis_device_name";

function randomId() {
  return crypto.randomUUID().replace(/-/g, "");
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
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!response.ok) {
    const error = new Error(data.error || `ADVIS API returned HTTP ${response.status}. Check the deployed API route.`);
    (error as any).status = response.status;
    throw error;
  }
  if (!raw || !Object.keys(data).length) {
    throw new Error("ADVIS API returned an empty or non-JSON response. The server route may not be deployed.");
  }
  return data;
}

function waitForIceGatheringComplete(pc: RTCPeerConnection) {
  return new Promise<void>((resolve, reject) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 9000);
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", check);
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function attachRemoteInputChannel(channel: RTCDataChannel) {
  channel.onmessage = event => {
    try {
      const input = JSON.parse(String(event.data || "{}"));
      if (input.kind === "pointer") {
        const x = Math.max(0, Math.min(window.innerWidth - 1, Number(input.x) * window.innerWidth));
        const y = Math.max(0, Math.min(window.innerHeight - 1, Number(input.y) * window.innerHeight));
        const target = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!target) return;
        target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y, pointerType: "mouse" }));
        target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
      } else if (input.kind === "click") {
        const x = Math.max(0, Math.min(window.innerWidth - 1, Number(input.x) * window.innerWidth));
        const y = Math.max(0, Math.min(window.innerHeight - 1, Number(input.y) * window.innerHeight));
        const target = document.elementFromPoint(x, y) as HTMLElement | null;
        target?.click();
      } else if (input.kind === "scroll") {
        window.scrollBy(Number(input.x) || 0, Number(input.y) || 0);
      } else if (input.kind === "key") {
        const target = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          const key = String(input.key || "");
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          let nextValue = target.value;
          let nextCursor = start;
          if (key === "Backspace") {
            if (start === end && start > 0) nextValue = target.value.slice(0, start - 1) + target.value.slice(end);
            else nextValue = target.value.slice(0, start) + target.value.slice(end);
            nextCursor = Math.max(0, start - 1);
          } else if (key === "Enter" && target instanceof HTMLTextAreaElement) {
            nextValue = target.value.slice(0, start) + "\n" + target.value.slice(end);
            nextCursor = start + 1;
          } else if (key.length === 1 && !input.ctrlKey && !input.metaKey && !input.altKey) {
            nextValue = target.value.slice(0, start) + key + target.value.slice(end);
            nextCursor = start + key.length;
          }
          if (nextValue !== target.value) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
            setter?.call(target, nextValue);
            target.setSelectionRange(nextCursor, nextCursor);
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
    } catch (error) {
      console.warn("[ADVIS remote input] Ignored invalid input event.", error);
    }
  };
}

export function DeviceNetwork({ visible = false }: { visible?: boolean }) {
  const [networkId, setNetworkId] = useState(() => localStorage.getItem(NETWORK_KEY) || "");
  const [deviceToken, setDeviceToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [ownerToken, setOwnerToken] = useState(() => localStorage.getItem(OWNER_TOKEN_KEY) || "");
  const [inviteLink, setInviteLink] = useState("");
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
  const [remoteSessionRequest, setRemoteSessionRequest] = useState<RemoteSessionRequest | null>(null);
  const [remoteSessionStatus, setRemoteSessionStatus] = useState("");
  const [remoteSessionId, setRemoteSessionId] = useState("");
  const [remoteSessionMode, setRemoteSessionMode] = useState<"controller" | "sharing" | "">("");
  const [remoteSessionPeerId, setRemoteSessionPeerId] = useState("");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>());
  const controlChannelsRef = useRef(new Map<string, RTCDataChannel>());
  const activeShareRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState(0);
  const [cloudNetworkStatus, setCloudNetworkStatus] = useState<{ configured: boolean; databaseConnected?: boolean; state?: string; missing?: string[]; reason?: string | null } | null>(null);
  const handled = useRef(new Set<string>());
  const autoNetworkStarted = useRef(false);



  useEffect(() => {
    localStorage.setItem(DEVICE_KEY, deviceId);
    localStorage.setItem(NAME_KEY, deviceName);
  }, [deviceId, deviceName]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/network/status").then(readJson).then(status => {
      if (!stopped) setCloudNetworkStatus(status);
    }).catch(error => {
      if (!stopped) setCloudNetworkStatus({ configured: false, reason: error.message || "The ADVIS cloud directory could not be reached." });
    });
    return () => { stopped = true; };
  }, []);

  const authHeaders = useCallback(() => ({
    "Content-Type": "application/json",
    Authorization: "Bearer " + deviceToken
  }), [deviceToken]);

  const ownerHeaders = useCallback(() => ({
    ...authHeaders(),
    "x-advis-owner-token": ownerToken
  }), [authHeaders, ownerToken]);

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

  const saveCredentials = useCallback((id: string, token: string, ownerCapability = "") => {
    localStorage.setItem(NETWORK_KEY, id);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem("advis_network_secret");
    if (ownerCapability) localStorage.setItem(OWNER_TOKEN_KEY, ownerCapability);
    else localStorage.removeItem(OWNER_TOKEN_KEY);
    setNetworkId(id);
    setDeviceToken(token);
    setOwnerToken(ownerCapability);
  }, []);

  const loadIceServers = async (): Promise<RTCIceServer[]> => {
    const config = await readJson(await fetch("/api/network/ice-config", {
      headers: authHeaders()
    }));
    return Array.isArray(config.iceServers) && config.iceServers.length
      ? config.iceServers
      : [{ urls: "stun:stun.l.google.com:19302" }];
  };

  const createNetwork = async () => {
    setBusy(true);
    setError("");
    try {
      const id = randomId();
      const result = await readJson(await fetch("/api/network/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkId: id, deviceId, name: deviceName.trim() || deviceLabel(), platform: navigator.userAgent })
      }));
      saveCredentials(id, result.deviceToken, result.ownerToken);
      addActivity("PRIVATE NETWORK CREATED", "This device is the owner. Generate a one-time invite for each additional device.");
    } catch (e: any) {
      setError("Network setup failed: " + (e.message || "Could not create the device network."));
    } finally {
      setBusy(false);
    }
  };
  
  // New enrollments use a single-use code generated by the enrolled owner device.
  useEffect(() => {
    if (networkId || deviceToken) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("advisNetwork") && url.searchParams.get("advisInvite")) {
      setInviteInput(window.location.href);
    }
  }, [networkId, deviceToken]);

  const joinNetwork = async (rawInvite: string) => {
    setBusy(true);
    setError("");
    try {
      let id = "";
      let code = "";
      const raw = rawInvite.trim();
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        const url = new URL(raw);
        id = url.searchParams.get("advisNetwork") || "";
        code = url.searchParams.get("advisInvite") || "";
      } else {
        const parts = raw.split(".");
        id = parts[0] || "";
        code = parts[1] || "";
      }
      if (!id || !code) throw new Error("Paste the complete single-use ADVIS invitation link or networkId.code.");
      const result = await readJson(await fetch("/api/network/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkId: id, invitationCode: code, deviceId, name: deviceName.trim() || deviceLabel(), platform: navigator.userAgent })
      }));
      saveCredentials(id, result.deviceToken);
      setInviteInput("");
      setInviteLink("");
      addActivity("DEVICE ENROLLED", "This device joined the owner's private network using a one-time invitation.");
      const url = new URL(window.location.href);
      url.searchParams.delete("advisNetwork");
      url.searchParams.delete("advisInvite");
      url.searchParams.delete("advisSecret");
      window.history.replaceState({}, "", url.toString());
    } catch (e: any) {
      setError("Device enrollment failed: " + (e.message || "Could not join the ADVIS network."));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("advisNetwork") && url.searchParams.get("advisInvite") && !deviceToken) {
      setInviteInput(window.location.href);
    }
  }, [deviceToken]);

  const createInvite = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await readJson(await fetch("/api/network/invites", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ networkId, deviceId })
      }));
      const url = new URL(window.location.href);
      url.searchParams.set("advisNetwork", result.networkId);
      url.searchParams.set("advisInvite", result.invitationCode);
      setInviteLink(url.toString());
      addActivity("ONE-TIME INVITE CREATED", "This invitation expires in 10 minutes and can enroll one device.");
    } catch (e: any) {
      setError(e.message || "Could not create an invitation. Confirm this is the owner device.");
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (targetDeviceId: string) => {
    if (!ownerToken || !targetDeviceId || targetDeviceId === deviceId) return;
    try {
      await readJson(await fetch("/api/network/devices/" + encodeURIComponent(targetDeviceId) + "/revoke", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ networkId, deviceId })
      }));
      setDevices(previous => previous.filter(item => item.id !== targetDeviceId));
      if (selectedDevice === targetDeviceId) setSelectedDevice("");
      addActivity("DEVICE REVOKED", "The selected device's token was removed from the private network.");
    } catch (e: any) {
      setError(e.message || "Could not revoke that device.");
    }
  };

  const revokeAllMembers = async () => {
    if (!ownerToken) return;
    try {
      const result = await readJson(await fetch("/api/network/devices/revoke-all", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ networkId, deviceId })
      }));
      setDevices(previous => previous.filter(item => item.id === deviceId));
      setSelectedDevice("");
      addActivity("MEMBER DEVICES REVOKED", String(result.revokedCount) + " device(s) removed from this network.");
    } catch (e: any) {
      setError(e.message || "Could not revoke member devices.");
    }
  };

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

  const sendRtcSignal = useCallback((targetDeviceId: string, sessionId: string, type: string, extra: Record<string, any> = {}) =>
    sendCommand(targetDeviceId, "RTC_SIGNAL", { sessionId, type, ...extra }), [sendCommand]);

  const closeRemotePeer = useCallback((sessionId: string) => {
    const peer = peerConnectionsRef.current.get(sessionId);
    if (peer) {
      peer.ontrack = null;
      peer.ondatachannel = null;
      peer.onconnectionstatechange = null;
      peer.close();
      peerConnectionsRef.current.delete(sessionId);
    }
    const channel = controlChannelsRef.current.get(sessionId);
    if (channel) {
      try { channel.close(); } catch (_) {}
      controlChannelsRef.current.delete(sessionId);
    }
    if (activeShareRef.current) {
      activeShareRef.current.getTracks().forEach(track => track.stop());
      activeShareRef.current = null;
    }
    setRemoteStream(null);
    setRemoteSessionRequest(null);
    setRemoteSessionId(current => current === sessionId ? "" : current);
    setRemoteSessionPeerId("");
    setRemoteSessionMode("");
    setRemoteSessionStatus("");
  }, []);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;
    video.srcObject = remoteStream;
    if (remoteStream) void video.play().catch(() => {});
  }, [remoteStream, remoteSessionStatus, visible]);

  useEffect(() => {
    if (!networkId || !deviceToken) return;
    let stopped = false;
    const sync = async () => {
      try {
        await fetch("/api/network/heartbeat", {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ networkId, deviceId, name: deviceName.trim() || deviceLabel(), platform: navigator.userAgent })
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
          } else if (command.kind === "RTC_SIGNAL") {
            const signal = command.payload || {};
            const sessionId = String(signal.sessionId || "");
            if (signal.type === "OFFER" && sessionId && signal.sdp) {
              setRemoteSessionRequest({
                sessionId,
                fromDeviceId: command.fromDeviceId,
                fromDeviceName: command.fromDeviceName,
                sdp: String(signal.sdp)
              });
              addActivity("REMOTE SESSION REQUEST", command.fromDeviceName + " wants to view and control this ADVIS tab.");
            } else if (signal.type === "ANSWER" && sessionId && signal.sdp) {
              const peer = peerConnectionsRef.current.get(sessionId);
              if (peer && !peer.remoteDescription) {
                await peer.setRemoteDescription({ type: "answer", sdp: String(signal.sdp) });
                setRemoteSessionStatus("Connected · live ADVIS tab");
                addActivity("REMOTE SESSION CONNECTED", "Secure peer connection established.");
              }
            } else if (signal.type === "END" && sessionId) {
              closeRemotePeer(sessionId);
              addActivity("REMOTE SESSION ENDED", "The other device ended the session.");
            }
            await acknowledge(command.id, "COMPLETED", "Remote signal processed.");
          }
        }
      } catch (e: any) {
        if (!stopped && Number(e?.status) === 410) {
          setError((e.message || "This network uses the legacy invitation format.") + " Use DISCONNECT THIS DEVICE, then create a new private network and re-enroll the other devices with one-time invites.");
          setDevices([]);
          window.clearInterval(timer);
          addActivity("SECURITY UPGRADE REQUIRED", "Legacy shared-secret network stopped; re-enrol on the owner-managed protocol.");
        } else if (!stopped) {
          setError(e.message || "Device network temporarily unavailable.");
        }
      }
    };
    sync();
    const timer = window.setInterval(sync, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [networkId, deviceToken, deviceId, deviceName, selectedDevice, authHeaders, sendCommand, acknowledge, addActivity, closeRemotePeer]);

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

  const startRemoteSession = async () => {
    if (!selectedDevice || selectedDevice.startsWith("tab:")) {
      setError("Select an online device in your trusted ADVIS network.");
      return;
    }
    const sessionId = "sess_" + randomId();
    const selectedTarget = devices.find(item => item.id === selectedDevice);
    const isDesktopAgent = Boolean(selectedTarget?.platform.includes("ADVIS Desktop Agent"));
    setBusy(true);
    setError("");
    try {
      const iceServers = await loadIceServers();
      const peer = new RTCPeerConnection({ iceServers });
      peerConnectionsRef.current.set(sessionId, peer);
      setRemoteSessionId(sessionId);
      setRemoteSessionPeerId(selectedDevice);
      setRemoteSessionMode("controller");
      setRemoteSessionStatus(isDesktopAgent ? "Connecting to enrolled desktop agent…" : "Calling device · waiting for approval");
      peer.ontrack = event => {
        const stream = event.streams?.[0];
        if (stream) {
          setRemoteStream(stream);
          setRemoteSessionStatus(isDesktopAgent ? "LIVE · FULL DESKTOP CONNECTED" : "LIVE · ADVIS TAB CONNECTED");
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          setRemoteSessionStatus("Connection failed · network relay may be required");
          addActivity("REMOTE SESSION FAILED", "A direct browser connection could not be established.");
        } else if (peer.connectionState === "disconnected") {
          setRemoteSessionStatus("Connection interrupted");
        }
      };
      const channel = peer.createDataChannel("advis-remote-input");
      controlChannelsRef.current.set(sessionId, channel);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);
      await sendRtcSignal(selectedDevice, sessionId, "OFFER", { sdp: peer.localDescription?.sdp || "" });
      addActivity("REMOTE SESSION REQUESTED", isDesktopAgent ? "Connecting to " + (selectedTarget?.name || "the enrolled desktop agent") + " using its local unattended-access setting." : "Waiting for " + (selectedTarget?.name || "the selected device") + " to approve screen sharing.");
    } catch (e: any) {
      closeRemotePeer(sessionId);
      setError(e.message || "Could not start the remote session.");
    } finally {
      setBusy(false);
    }
  };

  const approveRemoteSession = async () => {
    if (!remoteSessionRequest) return;
    const request = remoteSessionRequest;
    setBusy(true);
    setError("");
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("This browser cannot share a screen. Open ADVIS in a current browser over HTTPS.");
      }
      // The user must choose the ADVIS tab in the browser's native screen-share prompt.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      activeShareRef.current = stream;
      const iceServers = await loadIceServers();
      const peer = new RTCPeerConnection({ iceServers });
      peerConnectionsRef.current.set(request.sessionId, peer);
      stream.getTracks().forEach(track => {
        peer.addTrack(track, stream);
        track.addEventListener("ended", () => {
          void sendRtcSignal(request.fromDeviceId, request.sessionId, "END");
          closeRemotePeer(request.sessionId);
        }, { once: true });
      });
      peer.ondatachannel = event => {
        controlChannelsRef.current.set(request.sessionId, event.channel);
        attachRemoteInputChannel(event.channel);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          closeRemotePeer(request.sessionId);
        }
      };
      await peer.setRemoteDescription({ type: "offer", sdp: request.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGatheringComplete(peer);
      await sendRtcSignal(request.fromDeviceId, request.sessionId, "ANSWER", { sdp: peer.localDescription?.sdp || "" });
      setRemoteSessionRequest(null);
      setRemoteSessionId(request.sessionId);
      setRemoteSessionPeerId(request.fromDeviceId);
      setRemoteSessionMode("sharing");
      setRemoteSessionStatus("Sharing ADVIS tab · connected when controller joins");
      addActivity("SCREEN SHARE APPROVED", "You approved a live session. Stop sharing from this panel at any time.");
    } catch (e: any) {
      if (activeShareRef.current) {
        activeShareRef.current.getTracks().forEach(track => track.stop());
        activeShareRef.current = null;
      }
      await sendRtcSignal(request.fromDeviceId, request.sessionId, "END").catch(() => {});
      setError(e.message || "Screen sharing was not started.");
      setRemoteSessionRequest(null);
    } finally {
      setBusy(false);
    }
  };

  const rejectRemoteSession = async () => {
    if (!remoteSessionRequest) return;
    const request = remoteSessionRequest;
    await sendRtcSignal(request.fromDeviceId, request.sessionId, "END", { reason: "Rejected on target device." }).catch(() => {});
    setRemoteSessionRequest(null);
    addActivity("REMOTE SESSION REJECTED", request.fromDeviceName);
  };

  const stopRemoteSession = async () => {
    const sessionId = remoteSessionId;
    if (!sessionId) return;
    const targetId = remoteSessionPeerId;
    if (targetId && !targetId.startsWith("tab:")) {
      await sendRtcSignal(targetId, sessionId, "END").catch(() => {});
    }
    closeRemotePeer(sessionId);
    addActivity("REMOTE SESSION STOPPED", "This ADVIS tab ended the remote session.");
  };

  const sendRemotePointer = (event: React.PointerEvent<HTMLDivElement>, kind: "pointer" | "click") => {
    const channel = controlChannelsRef.current.get(remoteSessionId);
    if (!channel || channel.readyState !== "open") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
    channel.send(JSON.stringify({ kind, x, y }));
  };

  const sendRemoteKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const channel = controlChannelsRef.current.get(remoteSessionId);
    if (!channel || channel.readyState !== "open") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1 || ["Backspace", "Enter"].includes(event.key)) {
      event.preventDefault();
      channel.send(JSON.stringify({ kind: "key", key: event.key }));
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
    localStorage.removeItem("advis_network_secret");
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(OWNER_TOKEN_KEY);
    setNetworkId(""); setDeviceToken(""); setOwnerToken(""); setDevices([]);
    setInviteLink("");
    addActivity("DEVICE DISCONNECTED", "This browser has removed its local network credentials. The owner should revoke it to invalidate the server token.");
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

      <div className="bg-black/40 border border-cyan-500/20 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <label className="text-[10px] tracking-widest text-cyan-400 shrink-0">THIS DEVICE NAME</label>
        <input value={deviceName} onChange={event => setDeviceName(event.target.value.slice(0, 48))} onBlur={() => setDeviceName(value => value.trim() || deviceLabel())} maxLength={48} placeholder="Give this device a name" className="flex-1 min-w-0 bg-slate-950 border border-cyan-500/30 rounded-lg px-3 py-2 text-xs text-cyan-100 outline-none focus:border-cyan-300"/>
        <span className="text-[10px] text-cyan-500/60">Auto-saved · synced to your trusted devices</span>
      </div>

      {cloudNetworkStatus && (!cloudNetworkStatus.configured || cloudNetworkStatus.databaseConnected === false) && (
        <div className="p-3 rounded border border-amber-400/30 bg-amber-950/30 text-amber-100 text-xs">
          <div className="font-semibold tracking-wider mb-1">CLOUD DEVICE DIRECTORY NOT CONFIGURED</div>
          <p>{cloudNetworkStatus.reason || "The cloud device service is unavailable."}</p>
          {cloudNetworkStatus.missing?.length ? <p className="mt-2 text-[10px] text-amber-200/70">Missing server settings: {cloudNetworkStatus.missing.join(", ")}</p> : null}
          <p className="mt-2 text-[10px] text-amber-200/70">Configure these in the ADVIS Vercel project's Production Environment Variables, then redeploy. Do not paste service-account credentials into this chat.</p>
        </div>
      )}
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
              <div className="flex items-center gap-2 text-cyan-300"><Radio size={18}/> CONNECT THIS ADVIS DEVICE</div>
              <p className="text-xs text-cyan-100/70 leading-relaxed">On your first device, create your private network. On each additional device, join it once with the owner's invitation. After that, every enrolled device appears automatically whenever it is online—wherever it is in the world.</p>
              <input value={inviteInput} onChange={event => setInviteInput(event.target.value)} placeholder="Paste your trusted ADVIS invitation link here" className="bg-slate-950 border border-cyan-500/30 rounded-lg p-3 text-xs outline-none focus:border-cyan-300"/>
              <div className="grid sm:grid-cols-2 gap-2">
                <button disabled={busy || !inviteInput.trim()} onClick={() => joinNetwork(inviteInput)} className="bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/40 rounded p-3 text-xs tracking-widest disabled:opacity-40">{busy ? "CONNECTING..." : "JOIN MY TRUSTED NETWORK"}</button>
                <button disabled={busy} onClick={createNetwork} className="bg-slate-900 border border-cyan-500/25 rounded p-3 text-xs tracking-widest disabled:opacity-40">{busy ? "INITIALISING..." : "CREATE FIRST NETWORK"}</button>
              </div>
            </>
          )}
          {error && <p className="text-[10px] text-red-300">{error}</p>}
        </div>
      ) : (
        <>

          <div className="bg-black/50 border border-cyan-500/20 rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-cyan-300"><ShieldCheck size={18}/> PRIVATE DEVICE ENROLLMENT</div>
              {ownerToken ? (
                <button disabled={busy} onClick={createInvite} className="text-[10px] border border-cyan-400/30 rounded px-3 py-1.5 hover:bg-cyan-500/10 disabled:opacity-40">CREATE ONE-TIME INVITE</button>
              ) : <span className="text-[10px] text-amber-300">MEMBER DEVICE</span>}
            </div>
            {inviteLink ? (
              <>
                <p className="text-[11px] text-cyan-100/60 break-all">{inviteLink}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={() => navigator.clipboard.writeText(inviteLink)} className="flex gap-2 items-center text-[10px] border border-cyan-400/30 rounded px-3 py-1.5 hover:bg-cyan-500/10"><Copy size={13}/> COPY LINK</button>
                  <span className="text-[10px] text-amber-300/80">Single-use · expires in 10 minutes</span>
                </div>
              </>
            ) : <p className="text-[10px] text-cyan-500/60">{ownerToken ? "Generate a fresh single-use invite when you are ready to enroll another device." : "Only the owner device can create enrollment invitations."}</p>}
            <p className="text-[10px] text-amber-300/80">Each link enrolls one device once. It cannot be reused after enrollment or expiry.</p>
            <div className="border-t border-cyan-500/15 pt-3 flex flex-col sm:flex-row gap-2">
              <input value={inviteInput} onChange={event => setInviteInput(event.target.value)} placeholder="Move this device to another trusted network" className="flex-1 min-w-0 bg-slate-950 border border-cyan-500/25 rounded p-2 text-[10px] outline-none focus:border-cyan-300"/>
              <button disabled={busy || !inviteInput.trim()} onClick={() => joinNetwork(inviteInput)} className="border border-cyan-400/30 rounded px-3 py-2 text-[10px] disabled:opacity-40">JOIN OTHER NETWORK</button>
            </div>
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
                <div key={device.id} className={"w-full flex items-center justify-between gap-3 p-3 rounded border " + (selectedDevice === device.id ? "border-cyan-300/60 bg-cyan-500/10" : "border-cyan-500/15 bg-slate-950/60")}>
                  <button onClick={() => setSelectedDevice(device.id)} className="flex flex-1 items-center justify-between gap-3 text-left min-w-0">
                    <span className="flex items-center gap-3 min-w-0">
                      {device.platform.match(/Android|iPhone|iPad/i) ? <Smartphone size={18} className="text-cyan-300"/> : <Monitor size={18} className="text-cyan-300"/>}
                      <span className="min-w-0">
                        <span className="block text-xs text-cyan-100 truncate">{device.name} {device.current ? "(THIS DEVICE)" : ""} {device.role === "OWNER" ? "· OWNER" : ""}</span>
                        <span className="block text-[10px] text-cyan-500/60 truncate">{device.platform}</span>
                      </span>
                    </span>
                    <span className={"text-[9px] shrink-0 " + (device.status === "ONLINE" ? "text-green-300" : "text-slate-500")}>{device.status}</span>
                  </button>
                  {ownerToken && !device.current && <button onClick={() => revokeDevice(device.id)} className="text-[9px] text-red-300 border border-red-400/25 rounded px-2 py-1">REVOKE</button>}
                </div>
              ))}
              {!devices.length && <p className="text-xs text-cyan-500/50">Waiting for enrolled devices...</p>}
              {ownerToken && devices.some(device => !device.current) && <button onClick={revokeAllMembers} className="mt-3 text-[10px] text-red-300 border border-red-400/30 rounded px-3 py-2">REVOKE ALL MEMBER DEVICES</button>}
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
              <p className="text-[10px] text-cyan-500/60">The receiving device must approve each ADVIS action before it executes.</p>
              <button onClick={startRemoteSession} disabled={!selectedDevice || selectedDevice.startsWith("tab:") || devices.find(item => item.id === selectedDevice)?.status !== "ONLINE" || busy} className="flex items-center justify-center gap-2 bg-cyan-500/20 border border-cyan-300/50 rounded p-3 text-xs tracking-widest disabled:opacity-40"><MonitorPlay size={15}/>{busy ? "CONNECTING..." : devices.find(item => item.id === selectedDevice)?.platform.includes("ADVIS Desktop Agent") ? "CONNECT TO DESKTOP" : "START LIVE ADVIS TAB SESSION"}</button>
              {remoteSessionStatus && (
                <div className="flex items-center justify-between gap-2 text-[10px] text-cyan-200 border border-cyan-500/20 rounded-lg p-2">
                  <span>{remoteSessionStatus}</span>
                  {remoteSessionMode && <button onClick={stopRemoteSession} className="text-red-300 border border-red-400/30 rounded px-2 py-1 shrink-0">STOP {remoteSessionMode === "sharing" ? "SHARING" : "SESSION"}</button>}
                </div>
              )}
              {remoteStream && remoteSessionMode === "controller" && (
                <div className="fixed inset-0 z-[9999] bg-[#020810] text-cyan-50 p-3 md:p-5 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3 border-b border-cyan-400/20 pb-3">
                    <div className="min-w-0">
                      <div className="text-[10px] tracking-[0.22em] text-cyan-300">ADVIS · REMOTE WORKSTATION</div>
                      <div className="text-sm md:text-base font-semibold truncate">
                        {remoteSessionStatus.includes("FULL DESKTOP") ? "FULL DESKTOP SESSION" : "REMOTE ADVIS TAB SESSION"}
                      </div>
                      <div className="text-[10px] text-cyan-400/60 truncate">
                        {devices.find(item => item.id === remoteSessionPeerId)?.name || "Trusted device"} · {remoteSessionStatus}
                      </div>
                    </div>
                    <button onClick={stopRemoteSession} className="shrink-0 flex items-center gap-2 bg-red-500/10 border border-red-400/50 text-red-200 rounded-lg px-4 py-2 text-xs tracking-widest">
                      <X size={15}/> DISCONNECT
                    </button>
                  </div>
                  <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden border border-cyan-400/30 bg-black">
                    <video ref={remoteVideoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-contain bg-black"/>
                    <div
                      tabIndex={0}
                      onPointerMove={event => sendRemotePointer(event, "pointer")}
                      onPointerUp={event => sendRemotePointer(event, "click")}
                      onKeyDown={sendRemoteKey}
                      onWheel={event => {
                        event.preventDefault();
                        const channel = controlChannelsRef.current.get(remoteSessionId);
                        if (channel?.readyState === "open") channel.send(JSON.stringify({ kind: "scroll", x: event.deltaX, y: event.deltaY }));
                      }}
                      className="absolute inset-0 z-10 cursor-crosshair outline-none"
                      style={{ touchAction: "none" }}
                      aria-label="Remote screen control surface"
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-cyan-500/70">
                    <span>INPUT: POINTER · KEYBOARD · SCROLL WHERE SUPPORTED</span>
                    <span>SESSION ACTIVE · TARGET STOP CONTROL AVAILABLE</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {remoteSessionRequest && (
        <div className="bg-amber-950/30 border border-amber-400/40 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-amber-200"><MonitorPlay size={17}/> LIVE REMOTE SESSION REQUEST</div>
          <p className="text-xs text-amber-100/80">{remoteSessionRequest.fromDeviceName} wants to view and interact with this ADVIS tab. You choose whether to share it.</p>
          <p className="text-[10px] text-amber-200/60">The browser will show its own screen-sharing chooser. Select this ADVIS tab. You can stop sharing at any time.</p>
          <div className="flex gap-2">
            <button disabled={busy} onClick={approveRemoteSession} className="flex-1 bg-green-500/15 border border-green-400/40 rounded p-2 text-xs disabled:opacity-40"><Check size={14} className="inline mr-1"/> SHARE ADVIS TAB</button>
            <button disabled={busy} onClick={rejectRemoteSession} className="flex-1 bg-red-500/10 border border-red-400/30 rounded p-2 text-xs disabled:opacity-40"><X size={14} className="inline mr-1"/> REJECT</button>
          </div>
        </div>
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
