const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { validateInput, getNativeInputCapabilities } = require("../desktop/native-input.cjs");

test("desktop input adapter accepts bounded pointer and click coordinates", () => {
  assert.deepEqual(validateInput({ kind: "pointer", x: 120, y: 80 }), { kind: "pointer", x: 120, y: 80, button: "left" });
  assert.equal(validateInput({ kind: "click", x: 10, y: 20, button: "right" }).button, "right");
  assert.throws(() => validateInput({ kind: "click", x: NaN, y: 20 }), /invalid/i);
  assert.throws(() => validateInput({ kind: "pointer", x: 0, y: Infinity }), /invalid/i);
});

test("desktop input adapter constrains keys and scroll magnitudes", () => {
  assert.deepEqual(validateInput({ kind: "key", key: "Enter" }), { kind: "key", key: "Enter" });
  assert.deepEqual(validateInput({ kind: "key", key: "A" }), { kind: "key", key: "A" });
  assert.throws(() => validateInput({ kind: "key", key: "CommandOrArbitraryShell" }), /not supported/i);
  assert.equal(validateInput({ kind: "scroll", y: 5000 }).y, 1500);
});

test("desktop agent JavaScript files pass the Node parser", () => {
  const files = ["server.js", "src/DeviceNetworkSecurity.cjs", "desktop/main.cjs", "desktop/preload.cjs", "desktop/native-input.cjs", "desktop/agent.js"];
  for (const file of files) execFileSync(process.execPath, ["--check", path.join(__dirname, "..", file)]);
});

test("native input capability matrix does not overstate Wayland support", () => {
  assert.equal(getNativeInputCapabilities("darwin").supported, true);
  assert.match(getNativeInputCapabilities("darwin").note, /Pointer hover and global scrolling are not implemented/);
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  try {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    delete process.env.XDG_SESSION_TYPE;
    assert.match(getNativeInputCapabilities("linux").note, /Wayland global input is not supported/);
  } finally {
    if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
  assert.equal(getNativeInputCapabilities("freebsd").supported, false);
});