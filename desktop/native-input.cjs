const { execFile } = require("node:child_process");
const path = require("node:path");
const MAC_KEY_CODES = { Enter: 36, Backspace: 51, Tab: 48, Escape: 53, ArrowUp: 126, ArrowDown: 125, ArrowLeft: 123, ArrowRight: 124, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121, " ": 49 };
function clamp(value, min, max) { const n = Number(value); if (!Number.isFinite(n)) throw new Error("Input value is invalid."); return Math.max(min, Math.min(max, n)); }
function validateInput(input) {
  const kind = String(input.kind || "");
  if (!["pointer", "click", "scroll", "key"].includes(kind)) throw new Error("Unsupported desktop input event.");
  if (kind === "pointer" || kind === "click") return { kind, x: clamp(input.x, 0, 100000), y: clamp(input.y, 0, 100000), button: input.button === "right" ? "right" : "left" };
  if (kind === "scroll") return { kind, x: clamp(input.x || 0, -1500, 1500), y: clamp(input.y || 0, -1500, 1500) };
  const key = String(input.key || "");
  if (key.length === 1) return { kind: "key", key };
  if (Object.prototype.hasOwnProperty.call(MAC_KEY_CODES, key)) return { kind: "key", key };
  throw new Error("This keyboard key is not supported by ADVIS Desktop Agent.");
}
function run(file, args, timeout = 6000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 65536 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(String(stderr || error.message || "Native desktop input failed.").trim().slice(0, 500)));
    resolve({ ok: true, output: String(stdout || "").trim() });
  }));
}
function getNativeInputCapabilities(platform = process.platform) {
  if (platform === "darwin") return { supported: true, method: "Apple System Events UI scripting", permission: "Accessibility", note: "User must grant Accessibility permission. Hover and scroll are not implemented." };
  if (platform === "win32") return { supported: true, method: "Windows User32 input adapter", permission: "Interactive user desktop", note: "Input is sent only during an authenticated active desktop session." };
  if (platform === "linux") return { supported: true, method: "xdotool", permission: "X11 session", note: "Wayland global input is not supported by this adapter." };
  return { supported: false, method: "none", note: "This operating system is not supported." };
}
async function dispatchNativeInput(raw, platform = process.platform, resources = __dirname) {
  const input = validateInput(raw);
  if (platform === "darwin") {
    if (input.kind === "pointer") return { ok: true, moved: false, note: "macOS hover movement is not implemented." };
    if (input.kind === "scroll") throw new Error("macOS scroll injection is not implemented.");
    if (input.kind === "click") {
      const script = "on run argv\nset px to (item 1 of argv) as integer\nset py to (item 2 of argv) as integer\ntell application \"System Events\" to click at {px, py}\nend run";
      return run("/usr/bin/osascript", ["-e", script, String(Math.round(input.x)), String(Math.round(input.y))]);
    }
    if (input.key.length === 1) {
      const script = "on run argv\ntell application \"System Events\" to keystroke (item 1 of argv)\nend run";
      return run("/usr/bin/osascript", ["-e", script, input.key]);
    }
    const keyCode = MAC_KEY_CODES[input.key];
    if (keyCode === undefined) throw new Error("Unsupported macOS key.");
    return run("/usr/bin/osascript", ["-e", "tell application \"System Events\" to key code " + keyCode]);
  }
  if (platform === "win32") {
    const script = path.join(resources, "windows-input.ps1");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", input.kind];
    if (input.kind === "pointer" || input.kind === "click") args.push("-X", String(Math.round(input.x)), "-Y", String(Math.round(input.y)), "-Button", input.button);
    if (input.kind === "scroll") args.push("-DeltaX", String(input.x), "-DeltaY", String(input.y));
    if (input.kind === "key") args.push("-Key", input.key);
    return run("powershell.exe", args);
  }
  if (platform === "linux") {
    if (input.kind === "pointer") return run("xdotool", ["mousemove", String(Math.round(input.x)), String(Math.round(input.y))]);
    if (input.kind === "click") return run("xdotool", ["mousemove", String(Math.round(input.x)), String(Math.round(input.y)), "click", input.button === "right" ? "3" : "1"]);
    if (input.kind === "scroll") { const button = input.y >= 0 ? "5" : "4"; const repeat = String(Math.max(1, Math.min(10, Math.ceil(Math.abs(input.y) / 100)))); return run("xdotool", ["click", "--repeat", repeat, button]); }
    return run("xdotool", ["key", "--clearmodifiers", input.key.length === 1 ? input.key : input.key.toLowerCase()]);
  }
  throw new Error("This operating system is not supported by the native input adapter.");
}
module.exports = { validateInput, getNativeInputCapabilities, dispatchNativeInput };