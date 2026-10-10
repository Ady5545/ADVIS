// Explicit Vercel function entry for the Android Core health check.
// Delegate to the existing Express app so authentication and route behavior stay centralized.
const { createApp } = require("../../server");

let appPromise;

module.exports = async function mobileHealth(req, res) {
  try {
    if (!appPromise) appPromise = createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("[ADVIS mobile health] Initialization failed:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ status: "error", reply: "ADVIS Core could not initialize." }));
    }
  }
};
