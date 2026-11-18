const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateInput,
  getNativeInputCapabilities
} = require("../desktop/native-input.cjs");

test("remote pointer and click coordinates are bounded to the host display", () => {
  assert.deepEqual(validateInput({ kind: "pointer", x: 1200, y: -10 }), {
    kind: "pointer", x: 1200, y: -10, button: "left"
  });
  assert.deepEqual(validateInput({ kind: "click", x: 0.5, y: 0.25, button: "right" }), {
    kind: "click", x: 0.5, y: 0.25, button: "right"
  });
});

test("negative virtual-screen coordinates are preserved for secondary monitors", () => {
  assert.deepEqual(validateInput({ kind: "pointer", x: -1920, y: -120 }), {
    kind: "pointer", x: -1920, y: -120, button: "left"
  });
  assert.deepEqual(validateInput({ kind: "click", x: -1200, y: 200, button: "right" }), {
    kind: "click", x: -1200, y: 200, button: "right"
  });
});

test("remote scroll deltas are bounded and normalized", () => {
  assert.deepEqual(validateInput({ kind: "scroll", x: 5000, y: -2000 }), {
    kind: "scroll", x: 1500, y: -1500
  });
  assert.deepEqual(validateInput({ kind: "scroll" }), {
    kind: "scroll", x: 0, y: 0
  });
});

test("remote keyboard input accepts supported keys and rejects unknown key names", () => {
  assert.deepEqual(validateInput({ kind: "key", key: "a" }), { kind: "key", key: "a" });
  assert.deepEqual(validateInput({ kind: "key", key: "ArrowLeft" }), { kind: "key", key: "ArrowLeft" });
  assert.throws(() => validateInput({ kind: "key", key: "SuperSecretShortcut" }), /not supported/);
  assert.throws(() => validateInput({ kind: "shell", command: "whoami" }), /Unsupported desktop input/);
});

test("Windows advertises full pointer, click, scroll and keyboard input", () => {
  const capabilities = getNativeInputCapabilities("win32");
  assert.equal(capabilities.supported, true);
  assert.deepEqual(capabilities.actions, ["pointer", "click", "scroll", "key"]);
  assert.equal(capabilities.method, "Windows User32 input adapter");
});

test("macOS capabilities do not claim unsupported hover or scroll injection", () => {
  const capabilities = getNativeInputCapabilities("darwin");
  assert.equal(capabilities.supported, true);
  assert.deepEqual(capabilities.actions, ["click", "key"]);
  assert.match(capabilities.note, /not implemented/);
});

test("Wayland is not advertised as supported by the current Linux input adapter", () => {
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousSession = process.env.XDG_SESSION_TYPE;
  try {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    process.env.XDG_SESSION_TYPE = "wayland";
    const capabilities = getNativeInputCapabilities("linux");
    assert.equal(capabilities.supported, false);
    assert.deepEqual(capabilities.actions, []);
  } finally {
    if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousSession === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSession;
  }
});
