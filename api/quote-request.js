"use strict";
const store = require("./_lib/store");
const { cors, readJson } = require("./_lib/util");

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const order = await readJson(req);
    const rec = await store.create({ ...order, status: "quote_requested", requestType: "Custom Quote" });
    // (optional) email dispatch here if SMTP configured — see webhook.js notify()
    res.json({ received: true, reference: rec.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
