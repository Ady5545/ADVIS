// Dedicated Vercel Function for nested ADVIS network endpoints.
// Vercel's file-based API routing does not provide a portable catch-all for
// this Vite project, so vercel.json rewrites /api/network/* through this file.
const { createApp } = require("../server");

let appPromise;

module.exports = async function advisNetworkApi(req, res) {
  try {
    const host = req.headers.host || "localhost";
    const parsed = new URL(req.url || "/", `http://${host}`);
    const route = String(parsed.searchParams.get("__advis_path") || "");
    const segments = route.split("/");

    // Accept only known-safe path-segment characters; Express owns the actual
    // route/method authorization after the request is reconstructed.
    if (
      !route ||
      route.length > 512 ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(route) ||
      segments.some(segment => !segment || segment === "." || segment === "..")
    ) {
      return res.status(400).json({ error: "Invalid ADVIS network route." });
    }

    const query = new URLSearchParams(parsed.searchParams);
    query.delete("__advis_path");
    req.url = `/api/network/${route}${query.toString() ? `?${query.toString()}` : ""}`;

    if (!appPromise) appPromise = createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("[ADVIS Network Function] Failed to initialize:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: "ADVIS network service could not initialize."
      });
    }
  }
};
