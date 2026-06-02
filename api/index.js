// Vercel serverless entry — all /api/* requests route here (see vercel.json) and
// are handled by the shared Express app. Deps are installed from the root package.json.
module.exports = require("../server/app");
