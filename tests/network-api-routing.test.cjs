const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNetworkApiUrl } = require("../api/network-handler");

test("nested ADVIS network paths are reconstructed and query parameters survive", () => {
  const result = buildNetworkApiUrl(
    "/api/network-handler?__advis_path=devices%2Fdevice_123%2Frevoke&networkId=net_123&deviceId=device_123",
    "advis.example"
  );
  assert.equal(
    result,
    "/api/network/devices/device_123/revoke?networkId=net_123&deviceId=device_123"
  );
});

test("network API handler rejects malformed reconstructed paths", () => {
  assert.throws(
    () => buildNetworkApiUrl("/api/network-handler?__advis_path=..%2Fprivate"),
    /Invalid ADVIS network route/
  );
  assert.throws(
    () => buildNetworkApiUrl("/api/network-handler?__advis_path=devices%2F%2Frevoke"),
    /Invalid ADVIS network route/
  );
  assert.throws(
    () => buildNetworkApiUrl("/api/network-handler?__advis_path=devices%3Fadmin%3Dtrue"),
    /Invalid ADVIS network route/
  );
});
