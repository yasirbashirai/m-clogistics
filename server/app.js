/* ==========================================================================
   M&C Logistics — unified API (runs locally via server/index.js AND on Vercel
   via api/index.js). All routes are under /api so paths match in both places.
   ========================================================================== */
"use strict";
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const store = require("./store");
const { priceOrder } = require("./pricing");

const app = express();
app.use(cors({ origin: process.env.SITE_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}
async function stripeKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  const s = await store.getConfig("settings");
  return (s && s.payments && s.payments.stripeSecretKey) || "";
}

/* ===================== PUBLIC ===================== */

// Frontend config (publishable key + live pricing) so the site reflects admin edits
app.get("/api/config", async (req, res) => {
  const s = await store.getConfig("settings");
  const pricing = await store.getConfig("pricing");
  res.json({
    stripePublishableKey: (s && s.payments && s.payments.stripePublishableKey) || "",
    paymentsMode: (s && s.payments && s.payments.mode) || "test",
    pricing
  });
});

// Create Stripe Checkout session (price recomputed server-side from admin pricing)
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const order = req.body || {};
    const P = await store.getConfig("pricing");
    const priced = priceOrder(order, P);
    if (priced.custom) return res.status(400).json({ error: "custom_quote", reason: priced.reason });

    const rec = await store.addColl("orders", { ...order, breakdown: priced.lines, total: priced.total, status: "pending_payment", paid: false });

    const key = await stripeKey();
    if (!key) return res.status(200).json({ error: "stripe_not_configured", trackingCode: rec.id, total: priced.total });

    const stripe = Stripe(key);
    const origin = process.env.SITE_ORIGIN || (req.headers.origin || ("https://" + req.headers.host));
    const session = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card"],
      customer_email: order.customer && order.customer.email,
      client_reference_id: rec.id,
      line_items: priced.lines.map((l) => ({ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(l.amount * 100), product_data: { name: "M&C — " + l.label } } })),
      success_url: origin + "/service-area.html?paid=1&code=" + rec.id,
      cancel_url: origin + "/booking.html?canceled=1",
      metadata: { orderId: rec.id }
    });
    res.json({ id: session.id, url: session.url, trackingCode: rec.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stripe webhook — verify by re-fetching the session (serverless-safe)
app.post("/api/webhook", async (req, res) => {
  try {
    const stripe = Stripe(await stripeKey());
    const event = req.body || {};
    if (event.type !== "checkout.session.completed") return res.json({ received: true });
    const s = await stripe.checkout.sessions.retrieve(event.data.object.id);
    if (s.payment_status !== "paid") return res.json({ received: true });
    const id = (s.metadata && s.metadata.orderId) || s.client_reference_id;
    if (id) await store.updateColl("orders", id, { status: "paid", paid: true, amountPaid: (s.amount_total || 0) / 100, stripePaymentId: s.payment_intent || s.id });
    res.json({ received: true });
  } catch (e) { res.status(200).json({ received: true, error: e.message }); }
});

// Public quote request
app.post("/api/quote-request", async (req, res) => {
  const rec = await store.addColl("quotes", { ...(req.body || {}), status: "new" }, "Q");
  res.json({ received: true, reference: rec.id });
});

// Public contact form
app.post("/api/contact", async (req, res) => {
  const b = req.body || {};
  const rec = await store.addColl("submissions", { name: b.name, email: b.email, phone: b.phone, message: b.message, status: "new" }, "S");
  res.json({ received: true, reference: rec.id });
});

// Public tracking
app.get("/api/track/:code", async (req, res) => {
  const o = await store.getColl("orders", String(req.params.code).toUpperCase());
  if (!o) return res.status(404).json({ error: "not_found" });
  res.json({ code: o.id, status: o.status, serviceType: o.serviceType, from: o.pickupAddress, to: o.deliveryAddress || (o.stops || []).join(" | "), date: o.date, time: o.time, eta: o.eta || null, driver: o.driver || null });
});

/* ===================== ADMIN ===================== */
app.use("/api/admin", requireAdmin);

app.get("/api/admin/overview", async (req, res) => {
  const orders = await store.listColl("orders");
  const quotes = await store.listColl("quotes");
  const subs = await store.listColl("submissions");
  const paid = orders.filter((o) => o.paid);
  res.json({
    counts: {
      orders: orders.length, paid: paid.length,
      inTransit: orders.filter((o) => ["assigned", "picked_up", "in_transit"].includes(o.status)).length,
      delivered: orders.filter((o) => o.status === "delivered").length,
      quotes: quotes.filter((q) => q.status === "new").length, submissions: subs.filter((s) => s.status === "new").length
    },
    revenue: r2(paid.reduce((s, o) => s + (o.amountPaid || o.total || 0), 0)),
    statuses: store.STATUSES
  });
});

// Orders / shipments
app.get("/api/admin/orders", async (req, res) => res.json({ orders: await store.listColl("orders"), statuses: store.STATUSES }));
app.post("/api/admin/orders", async (req, res) => {
  const b = req.body || {};
  const P = await store.getConfig("pricing");
  let total = b.total, breakdown = b.breakdown;
  if (total == null) { const pr = priceOrder(b, P); if (!pr.custom) { total = pr.total; breakdown = pr.lines; } }
  const rec = await store.addColl("orders", {
    serviceType: b.serviceType || "Single Delivery",
    customer: b.customer || { name: b.name, phone: b.phone, email: b.email },
    pickupAddress: b.pickupAddress, deliveryAddress: b.deliveryAddress || null,
    stops: b.stops || null, numberOfStops: b.numberOfStops || (b.stops ? b.stops.length : null),
    miles: Number(b.miles) || 0, weight: Number(b.weight) || 0, date: b.date, time: b.time,
    instructions: b.instructions || "", addons: b.addons || {},
    breakdown: breakdown || [], total: total || 0,
    paid: !!b.paid, status: b.status || (b.paid ? "paid" : "pending_payment"), source: "manual"
  });
  res.json({ order: rec });
});
app.patch("/api/admin/orders/:id", async (req, res) => {
  const rec = await store.updateColl("orders", req.params.id, { status: req.body.status, driver: req.body.driver, eta: req.body.eta });
  rec ? res.json({ order: rec }) : res.status(404).json({ error: "not_found" });
});
app.delete("/api/admin/orders/:id", async (req, res) => { await store.removeColl("orders", req.params.id); res.json({ ok: true }); });

// Quotes
app.get("/api/admin/quotes", async (req, res) => res.json({ quotes: await store.listColl("quotes") }));
app.patch("/api/admin/quotes/:id", async (req, res) => { const r = await store.updateColl("quotes", req.params.id, { status: req.body.status }); res.json({ quote: r }); });

// Submissions (contact forms)
app.get("/api/admin/submissions", async (req, res) => res.json({ submissions: await store.listColl("submissions") }));
app.patch("/api/admin/submissions/:id", async (req, res) => { const r = await store.updateColl("submissions", req.params.id, { status: req.body.status }); res.json({ submission: r }); });

// Pricing (services & pricing editor)
app.get("/api/admin/pricing", async (req, res) => res.json({ pricing: await store.getConfig("pricing") }));
app.put("/api/admin/pricing", async (req, res) => res.json({ pricing: await store.setConfig("pricing", req.body || {}) }));

// Settings (payment gateways / integrations / business) — secret key redacted on read
app.get("/api/admin/settings", async (req, res) => {
  const s = JSON.parse(JSON.stringify(await store.getConfig("settings")));
  if (s.payments) { s.payments.stripeSecretKeySet = !!s.payments.stripeSecretKey || !!process.env.STRIPE_SECRET_KEY; delete s.payments.stripeSecretKey; }
  s.payments && (s.payments.envSecret = !!process.env.STRIPE_SECRET_KEY);
  res.json({ settings: s });
});
app.put("/api/admin/settings", async (req, res) => {
  const body = req.body || {};
  // don't wipe a stored secret with an empty field
  if (body.payments && (body.payments.stripeSecretKey === "" || body.payments.stripeSecretKey == null)) delete body.payments.stripeSecretKey;
  const merged = await store.setConfig("settings", deepMerge(await store.getConfig("settings"), body));
  const out = JSON.parse(JSON.stringify(merged));
  if (out.payments) { out.payments.stripeSecretKeySet = !!out.payments.stripeSecretKey; delete out.payments.stripeSecretKey; }
  res.json({ settings: out });
});

function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) {
    out[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? deepMerge(a && a[k], b[k]) : b[k];
  }
  return out;
}

module.exports = app;
