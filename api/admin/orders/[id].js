"use strict";
const store = require("../../_lib/store");
const { cors, requireAdmin, readJson } = require("../../_lib/util");

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAdmin(req, res)) return;
  if (req.method !== "PATCH" && req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const body = await readJson(req);
  const rec = await store.update(String(req.query.id), { status: body.status, driver: body.driver, eta: body.eta });
  if (!rec) return res.status(404).json({ error: "not_found" });
  res.json({ order: rec });
};
