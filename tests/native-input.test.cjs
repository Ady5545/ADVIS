const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateInput,
  getNativeInputCapabilities
} = require("../desktop/native-input.cjs");

test("native input adapter preserves virtual-screen coordinates within bounds", () => {
  assert.deepEqual(validateInput({ kind: "pointer", x: -5, y: 100001 }), {
    kind: "pointer", x: -5, y: 100000, button: "left"
  });
  assert.deepEqual(validateInput({ kind: "click", x: 640, y: 360, button: "right" }), {
    kind: "click", x: 640, y: 360, button: "right"
  });
});

test("native input adapter bounds scroll deltas", () => {
  assert.deepEqual(validateInput({ kind: "scroll", x: 5000, y: -5000 }), {
    kind: "scroll", x: 1500, y: -1500
  });
  assert.deepEqual(validateInput({ kind: "scroll" }), {
    kind: "scroll", x: 0, y: 0
  });
});

test("native input adapter accepts supported keys and rejects malformed input", () => {
  assert.deepEqual(validateInput({ kind: "key", key: "a" }), { kind: "key", key: "a" });
  assert.deepEqual(validateInput({ kind: "key", key: "Enter" }), { kind: "key", key: "Enter" });
  assert.throws(() => validateInput({ kind: "key", key: "Command" }), /not supported/i);
  assert.throws(() => validateInput({ kind: "launch-process" }), /unsupported/i);
});

test("native input capabilities are explicit for supported desktop platforms", () => {
  const mac = getNativeInputCapabilities("darwin");
  const windows = getNativeInputCapabilities("win32");
  const linux = getNativeInputCapabilities("linux");
  assert.equal(mac.supported, true);
  assert.deepEqual(mac.actions, ["click", "key"]);
  assert.equal(windows.supported, true);
  assert.deepEqual(windows.actions, ["pointer", "click", "scroll", "key"]);
  assert.equal(linux.supported, true);
  assert.deepEqual(linux.actions, ["pointer", "click", "scroll", "key"]);
  assert.equal(getNativeInputCapabilities("freebsd").supported, false);
});
