"use strict";
// Small shared helpers for the Vercel functions.

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
}

// Vercel parses JSON bodies into req.body; this is a safe fallback.
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function requireAdmin(req, res) {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

module.exports = { cors, readJson, requireAdmin };
