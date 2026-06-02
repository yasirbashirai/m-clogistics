"use strict";
const store = require("../_lib/store");
const { cors } = require("../_lib/util");

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const o = await store.get(String(req.query.code || "").toUpperCase());
  if (!o) return res.status(404).json({ error: "not_found" });
  res.json({
    code: o.id, status: o.status, serviceType: o.serviceType,
    from: o.pickupAddress, to: o.deliveryAddress || (o.stops || []).join(" | "),
    date: o.date, time: o.time, eta: o.eta || null, driver: o.driver || null
  });
};
