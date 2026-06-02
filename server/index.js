/* Local dev entry — runs the shared Express app.
   Start: cd server && npm install && node --env-file=.env index.js   (or npm start) */
"use strict";
const app = require("./app");
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`M&C API on :${PORT}`));
