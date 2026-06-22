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
const notify = require("./notify");
const shipday = require("./shipday");
const square = require("./square");

const app = express();
app.use(cors({ origin: process.env.SITE_ORIGIN || "*" }));
// Capture the raw body so the Square webhook can verify its HMAC signature.
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Every dispatch/submission email must reach these two no matter how the admin
// edits the recipient list — the gmail inbox and the dispatch alias are always included.
const CANONICAL_DISPATCH = ["dispatch@mclogistics.delivery", "mcdeliverypersonnel24.7@gmail.com"];
function dispatchRecipients(settings) {
  const extra = (settings && Array.isArray(settings.dispatchEmails)) ? settings.dispatchEmails : [];
  const seen = new Set();
  return [...CANONICAL_DISPATCH, ...extra]
    .map((e) => String(e || "").trim())
    .filter((e) => e && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()));
}

/* ---- distance (auto-mileage): Google Distance Matrix if a key is set,
        else a keyless geocode + haversine estimate (×1.3 road factor) ---- */
async function computeMiles(from, to) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) {
    try {
      const url = "https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial" +
        "&origins=" + encodeURIComponent(from) + "&destinations=" + encodeURIComponent(to) + "&key=" + key;
      const j = await (await fetch(url)).json();
      const el = j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
      if (el && el.status === "OK" && el.distance) return { miles: el.distance.value / 1609.344, source: "google" };
    } catch (_) { /* fall through to estimate */ }
  }
  const geo = async (q) => {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q),
      { headers: { "User-Agent": "mclogistics-quote/1.0", Accept: "application/json" } });
    const j = await r.json();
    return (j && j[0]) ? { lat: +j[0].lat, lon: +j[0].lon } : null;
  };
  try {
    const [a, b] = await Promise.all([geo(from), geo(to)]);
    if (a && b) {
      const R = 3958.8, rad = (x) => x * Math.PI / 180;
      const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
      return { miles: 2 * R * Math.asin(Math.sqrt(h)) * 1.3, source: "estimate" };
    }
  } catch (_) { /* unresolved */ }
  return null;
}

/* ---- per-vehicle daily booking caps + roll-to-next-available-day ---- */
function capFor(P, vehicle) { const v = ((P && P.vehicles) || []).find((x) => x.id === vehicle); return v ? v.dailyCap : null; }
function addDays(iso, n) {
  const p = String(iso).split("-");
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function countForDay(vehicle, date) {
  const orders = await store.listColl("orders");
  return orders.filter((o) => o.vehicle === vehicle && (o.requestedDate || o.date) === date && o.status !== "canceled").length;
}
// First day on/after `date` that still has capacity for `vehicle`.
async function resolveDay(P, vehicle, date) {
  const cap = capFor(P, vehicle);
  if (cap == null || !date) return { date, rolled: false, cap };
  let d = date;
  for (let i = 0; i < 60; i++) {
    if ((await countForDay(vehicle, d)) < cap) return { date: d, rolled: i > 0, cap };
    d = addDays(d, 1);
  }
  return { date, rolled: false, cap };
}

// Fulfill a paid order: email dispatch + customer, then create the Shipday delivery.
// HARD RULE: never dispatch an unpaid order — this only runs once Stripe confirms payment.
async function fulfillPaidOrder(order) {
  if (!order || !order.paid) return; // safety net — unpaid orders are never dispatched
  const settings = await store.getConfig("settings");
  const dispatchEmails = dispatchRecipients(settings);
  try { await notify.notifyPaidOrder(order, dispatchEmails, settings && settings.smtp); } catch (_) { /* email best-effort */ }
  try {
    const sd = await shipday.createShipdayOrder(order, settings);
    if (sd && sd.created) await store.updateColl("orders", order.id, { shipdayId: (sd.data && (sd.data.orderId || sd.data.id)) || true });
  } catch (_) { /* shipday best-effort */ }
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}
async function stripeKey() {
  if (process.env.STRIPE_SECRET_KEY) return process.env.STRIPE_SECRET_KEY;
  const s = await store.getConfig("settings");
  return (s && s.payments && s.payments.stripeSecretKey) || "";
}
// Which gateway to charge with. Honors the admin "provider" choice, but auto-uses
// whichever is actually configured so a half-set provider never blocks checkout.
function resolveProvider(settings) {
  const chosen = (settings && settings.payments && settings.payments.provider) || "";
  const squareReady = square.isConfigured(settings);
  const stripeReady = !!(process.env.STRIPE_SECRET_KEY || (settings && settings.payments && settings.payments.stripeSecretKey));
  if (chosen === "square" && squareReady) return "square";
  if (chosen === "stripe" && stripeReady) return "stripe";
  if (squareReady) return "square";
  if (stripeReady) return "stripe";
  return chosen || "square";
}

/* ===================== PUBLIC ===================== */

// Frontend config (publishable key + live pricing) so the site reflects admin edits
app.get("/api/config", async (req, res) => {
  const s = await store.getConfig("settings");
  const pricing = await store.getConfig("pricing");
  const provider = resolveProvider(s);
  const sq = square.squareConfig(s);
  res.json({
    paymentProvider: provider,
    // True once the active gateway can actually take a live card payment.
    paymentsReady: provider === "square" ? square.isConfigured(s) : !!(process.env.STRIPE_SECRET_KEY || (s && s.payments && s.payments.stripeSecretKey)),
    // Square public identifiers (safe to expose; the access token never leaves the server).
    square: { applicationId: sq.applicationId || "", locationId: sq.locationId || "", environment: sq.production ? "production" : "sandbox" },
    // Stripe publishable key kept for back-compat with the old flow.
    stripePublishableKey: (s && s.payments && s.payments.stripePublishableKey) || "",
    paymentsMode: (s && s.payments && s.payments.mode) || "test",
    pricing
  });
});

// Auto-mileage: returns miles for two addresses (Google DM if keyed, else estimate)
app.post("/api/distance", async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: "from_and_to_required" });
    const r = await computeMiles(from, to);
    if (!r) return res.status(200).json({ error: "unresolved" });
    res.json({ miles: Math.round(r.miles), source: r.source });
  } catch (e) { res.status(200).json({ error: e.message }); }
});

// Per-vehicle daily availability — is `date` full for `vehicle`? what's the next open day?
app.get("/api/availability", async (req, res) => {
  try {
    const P = await store.getConfig("pricing");
    const vehicle = String(req.query.vehicle || ""), date = String(req.query.date || "");
    const cap = capFor(P, vehicle);
    if (cap == null || !date) return res.json({ full: false });
    const count = await countForDay(vehicle, date);
    if (count < cap) return res.json({ full: false, count, cap });
    const next = await resolveDay(P, vehicle, addDays(date, 1));
    res.json({ full: true, cap, count, nextDate: next.date });
  } catch (e) { res.json({ full: false, error: e.message }); }
});

// Create Stripe Checkout session (price recomputed server-side from admin pricing)
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const order = req.body || {};
    const P = await store.getConfig("pricing");
    const priced = priceOrder(order, P);
    if (priced.custom) return res.status(400).json({ error: "custom_quote", reason: priced.reason });

    // Enforce the per-vehicle daily cap — roll a full day to the next available one.
    let rolled = null;
    if (order.vehicle && order.requestedDate) {
      const slot = await resolveDay(P, order.vehicle, order.requestedDate);
      if (slot.rolled) {
        rolled = { from: order.requestedDate, to: slot.date };
        order.requestedDate = slot.date;
        order.date = slot.date;
        order.rolledOver = true;
        order.rollNote = `Bookings were full on ${rolled.from}; scheduled for ${slot.date}.`;
      }
    }

    const rec = await store.addColl("orders", { ...order, breakdown: priced.lines, total: priced.total, status: "pending_payment", paid: false });

    const settings = await store.getConfig("settings");
    const origin = process.env.SITE_ORIGIN || (req.headers.origin || ("https://" + req.headers.host));
    const provider = resolveProvider(settings);

    // ---- Square (current gateway): hosted Payment Link, confirmed by webhook + re-fetch ----
    if (provider === "square") {
      const link = await square.createPaymentLink({ ...order, id: rec.id }, priced, {
        settings, redirectUrl: origin + "/service-area.html?paid=1&code=" + rec.id
      });
      if (link.error) {
        if (link.error === "square_not_configured")
          return res.status(200).json({ error: "payments_not_configured", trackingCode: rec.id, total: priced.total, rolled });
        return res.status(500).json({ error: link.error, trackingCode: rec.id });
      }
      await store.updateColl("orders", rec.id, { squareOrderId: link.orderId, squarePaymentLinkId: link.paymentLinkId, paymentProvider: "square" });
      return res.json({ url: link.url, trackingCode: rec.id, rolled });
    }

    // ---- Stripe (legacy fallback) ----
    const key = await stripeKey();
    if (!key) return res.status(200).json({ error: "payments_not_configured", trackingCode: rec.id, total: priced.total, rolled });

    const stripe = Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card"],
      customer_email: order.customer && order.customer.email,
      client_reference_id: rec.id,
      line_items: priced.lines.map((l) => ({ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(l.amount * 100), product_data: { name: "M&C — " + l.label } } })),
      success_url: origin + "/service-area.html?paid=1&code=" + rec.id,
      cancel_url: origin + "/booking.html?canceled=1",
      metadata: { orderId: rec.id }
    });
    res.json({ id: session.id, url: session.url, trackingCode: rec.id, rolled });
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
    if (id) {
      const updated = await store.updateColl("orders", id, { status: "paid", paid: true, amountPaid: (s.amount_total || 0) / 100, stripePaymentId: s.payment_intent || s.id });
      if (updated) await fulfillPaidOrder(updated);   // email dispatch + customer, create Shipday delivery
    }
    res.json({ received: true });
  } catch (e) { res.status(200).json({ received: true, error: e.message }); }
});

// Square webhook — fired on payment.created / payment.updated. We confirm the
// payment authoritatively by re-fetching it from Square (a forged webhook can't
// fake a COMPLETED payment on our account), then mark paid + dispatch.
// Signature check is best-effort defense-in-depth on top of the re-fetch.
app.post("/api/square-webhook", async (req, res) => {
  try {
    const settings = await store.getConfig("settings");
    const cfg = square.squareConfig(settings);
    const event = req.body || {};

    // Optional signature verification (logged only; the re-fetch below is authoritative).
    if (cfg.signatureKey) {
      const notifyUrl = "https://" + (req.headers["x-forwarded-host"] || req.headers.host) + req.originalUrl;
      const sigOk = square.verifySignature(cfg.signatureKey, notifyUrl, req.rawBody, req.headers["x-square-hmacsha256-signature"]);
      if (!sigOk) console.warn("Square webhook signature mismatch (continuing with authoritative re-fetch)");
    }

    const obj = event.data && event.data.object;
    const payment = obj && (obj.payment || obj);
    const paymentId = payment && payment.id;
    if (!paymentId) return res.json({ received: true });

    // Authoritative: ask Square directly whether this payment is complete.
    const confirmed = await square.getPayment(paymentId, settings);
    if (!confirmed || confirmed.status !== "COMPLETED") return res.json({ received: true });

    const squareOrderId = confirmed.order_id;
    const orders = await store.listColl("orders");
    const match = orders.find((o) => o.squareOrderId && o.squareOrderId === squareOrderId);
    if (match && !match.paid) {
      const amount = (confirmed.amount_money && confirmed.amount_money.amount != null) ? confirmed.amount_money.amount / 100 : (match.total || 0);
      const updated = await store.updateColl("orders", match.id, { status: "paid", paid: true, amountPaid: amount, squarePaymentId: paymentId });
      if (updated) await fulfillPaidOrder(updated);   // email dispatch + customer, create Shipday delivery
    }
    res.json({ received: true });
  } catch (e) { res.status(200).json({ received: true, error: e.message }); }
});

// Public quote request
app.post("/api/quote-request", async (req, res) => {
  const b = req.body || {};
  const rec = await store.addColl("quotes", { ...b, status: "new" }, "Q");
  // Email dispatch so custom-quote requests never sit unseen (best-effort).
  try {
    const settings = await store.getConfig("settings");
    await notify.notifyQuoteRequest({ ...b, id: rec.id }, dispatchRecipients(settings), settings && settings.smtp);
  } catch (_) { /* email best-effort */ }
  res.json({ received: true, reference: rec.id });
});

// Public contact form (also used by the careers application form)
app.post("/api/contact", async (req, res) => {
  const b = req.body || {};
  const rec = await store.addColl("submissions", { name: b.name, email: b.email, phone: b.phone, message: b.message, position: b.position || null, kind: b.kind || "contact", status: "new" }, "S");
  // Email dispatch (best-effort — no-ops cleanly until SMTP is configured via env or dashboard).
  try {
    const settings = await store.getConfig("settings");
    await notify.notifyContact({ ...rec, ...b }, dispatchRecipients(settings), settings && settings.smtp);
  } catch (_) { /* email best-effort */ }
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

// Strip every secret from a settings object, leaving "<field>Set" booleans so the
// admin UI can show "stored ✓" without ever shipping the secret back to the browser.
function redactSettings(s) {
  const out = JSON.parse(JSON.stringify(s || {}));
  if (out.payments) {
    out.payments.stripeSecretKeySet = !!out.payments.stripeSecretKey || !!process.env.STRIPE_SECRET_KEY;
    out.payments.envSecret = !!process.env.STRIPE_SECRET_KEY;
    delete out.payments.stripeSecretKey;
    if (out.payments.square) {
      const sq = out.payments.square;
      sq.accessTokenSet = !!sq.accessToken || !!process.env.SQUARE_ACCESS_TOKEN;
      sq.webhookSignatureKeySet = !!sq.webhookSignatureKey || !!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
      delete sq.accessToken; delete sq.webhookSignatureKey;
    }
  }
  if (out.integrations) {
    out.integrations.shipdaySet = !!out.integrations.shipdayKey || !!process.env.SHIPDAY_API_KEY;
    out.integrations.gmapsSet = !!out.integrations.gmapsKey || !!process.env.GOOGLE_MAPS_API_KEY;
    delete out.integrations.shipdayKey; delete out.integrations.gmapsKey;
  }
  if (out.smtp) { out.smtp.passSet = !!out.smtp.pass || !!process.env.SMTP_PASS; delete out.smtp.pass; }
  return out;
}

// Settings (payment gateways / integrations / business) — all secrets redacted on read
app.get("/api/admin/settings", async (req, res) => {
  res.json({ settings: redactSettings(await store.getConfig("settings")) });
});
app.put("/api/admin/settings", async (req, res) => {
  const body = req.body || {};
  // Don't wipe a stored secret when the field is submitted blank (means "keep existing").
  const blank = (v) => v === "" || v == null;
  if (body.payments) {
    if (blank(body.payments.stripeSecretKey)) delete body.payments.stripeSecretKey;
    if (body.payments.square) {
      if (blank(body.payments.square.accessToken)) delete body.payments.square.accessToken;
      if (blank(body.payments.square.webhookSignatureKey)) delete body.payments.square.webhookSignatureKey;
    }
  }
  if (body.integrations) {
    if (blank(body.integrations.shipdayKey)) delete body.integrations.shipdayKey;
    if (blank(body.integrations.gmapsKey)) delete body.integrations.gmapsKey;
  }
  if (body.smtp && blank(body.smtp.pass)) delete body.smtp.pass;
  const merged = await store.setConfig("settings", deepMerge(await store.getConfig("settings"), body));
  res.json({ settings: redactSettings(merged) });
});

function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) {
    out[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? deepMerge(a && a[k], b[k]) : b[k];
  }
  return out;
}

module.exports = app;
