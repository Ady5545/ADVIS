// Explicit Vercel function entry for the protected Android assistant endpoint.
// Delegate to the existing Express app; do not duplicate auth or Butler logic here.
const { createApp } = require("../../server");

let appPromise;

module.exports = async function mobileAdvis(req, res) {
  try {
    if (!appPromise) appPromise = createApp();
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("[ADVIS mobile API] Initialization failed:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ status: "error", reply: "ADVIS Core could not initialize." }));
    }
  }
};
