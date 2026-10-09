// Vercel catch-all function for ADVIS's existing Express API.
// Keep one initialized app per warm function instance; Vercel may still recycle it.
const { createApp } = require("../server");

let appPromise;

module.exports = async function advisApi(req, res) {
  try {
    if (!appPromise) {
      appPromise = createApp();
    }
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("[ADVIS Vercel API] Failed to initialize:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        status: "error",
        reply: "ADVIS Core could not initialize. Check the deployment logs and environment variables."
      }));
    }
  }
};
