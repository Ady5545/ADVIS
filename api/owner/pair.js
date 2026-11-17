// Explicit Vercel function route for nested ADVIS owner endpoints.
// Vercel's root API catch-all handles the existing one-segment API routes;
// these explicit handlers ensure /api/owner/* is deployed as server functions.
const { createApp } = require("../../server");

let appPromise;

module.exports = async function advisOwnerApi(req, res) {
  try {
    if (!appPromise) appPromise = createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("[ADVIS Owner API] Failed to initialize:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        status: "error",
        reply: "ADVIS owner services could not initialize. Check deployment runtime logs."
      }));
    }
  }
};
