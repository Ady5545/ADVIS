// Dedicated Vercel Function for nested ADVIS network endpoints.
// vercel.json rewrites /api/network/* through this file because Vercel's
// file-based API routing is not a portable catch-all for this Vite project.
const { createApp } = require("../server");

let appPromise;

function buildNetworkApiUrl(requestUrl, host = "localhost") {
  const parsed = new URL(requestUrl || "/", `http://${host}`);
  const route = String(parsed.searchParams.get("__advis_path") || "");
  const segments = route.split("/");

  if (
    !route ||
    route.length > 512 ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(route) ||
    segments.some(segment => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid ADVIS network route.");
  }

  const query = new URLSearchParams(parsed.searchParams);
  query.delete("__advis_path");
  return `/api/network/${route}${query.toString() ? `?${query.toString()}` : ""}`;
}

async function advisNetworkApi(req, res) {
  try {
    req.url = buildNetworkApiUrl(req.url, req.headers.host);
    if (!appPromise) appPromise = createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    const invalidRoute = error?.message === "Invalid ADVIS network route.";
    console.error("[ADVIS Network Function] Failed to initialize:", error);
    if (!res.headersSent) {
      return res.status(invalidRoute ? 400 : 500).json({
        error: invalidRoute
          ? "Invalid ADVIS network route."
          : "ADVIS network service could not initialize."
      });
    }
  }
}

module.exports = advisNetworkApi;
module.exports.buildNetworkApiUrl = buildNetworkApiUrl;
