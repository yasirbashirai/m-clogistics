"use strict";
const store = require("../../_lib/store");
const { cors, requireAdmin } = require("../../_lib/util");

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAdmin(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  res.json({ orders: await store.all(), statuses: store.STATUSES });
};
