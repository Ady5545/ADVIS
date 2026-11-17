const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateInput,
  getNativeInputCapabilities
} = require("../desktop/native-input.cjs");

test("native input adapter clamps pointer and click coordinates", () => {
  assert.deepEqual(validateInput({ kind: "pointer", x: -5, y: 100001 }), {
    kind: "pointer", x: 0, y: 100000, button: "left"
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
  assert.equal(getNativeInputCapabilities("darwin").supported, true);
  assert.equal(getNativeInputCapabilities("win32").supported, true);
  assert.equal(getNativeInputCapabilities("linux").supported, true);
  assert.equal(getNativeInputCapabilities("freebsd").supported, false);
});
