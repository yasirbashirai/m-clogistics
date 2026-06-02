/* ==========================================================================
   M&C Logistics — Checkout backend (Express)
   Endpoints:
     POST /create-checkout-session  → recompute price, create Stripe Checkout
     POST /webhook                  → Stripe events: on paid, email + Shipday
     POST /quote-request            → custom-quote requests (email only)
   Deploy to Render / Railway / Fly / a VPS / any Node host, or adapt each
   handler to a Vercel/Netlify serverless function.
   Run: cp .env.example .env && npm install && npm start
   ========================================================================== */
"use strict";

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const { priceOrder } = require("./pricing");
const store = require("./store");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");
const app = express();
app.use(cors({ origin: process.env.SITE_ORIGIN || "*" }));

/* admin auth: send header `x-admin-token: <ADMIN_TOKEN>` */
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}

const ADMIN_EMAILS = ["dispatch@mclogistics.delivery", "mcdeliverypersonnel24.7@gmail.com"];

/* ---- email transport (configure SMTP in .env) ---- */
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
async function sendMail(to, subject, html) {
  if (!process.env.SMTP_HOST) { console.log("[email skipped]", subject); return; }
  await mailer.sendMail({ from: process.env.MAIL_FROM || "orders@mclogistics.delivery", to, subject, html });
}

/* ---- (optional) Google Distance Matrix for authoritative mileage ----
   If GOOGLE_MAPS_API_KEY is set and addresses are present, recompute miles
   server-side so pricing can't be gamed via the client miles field. */
async function resolveMiles(order) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return Number(order.miles) || 0;
  try {
    const origin = encodeURIComponent(order.pickupAddress || "");
    const dests = order.serviceType === "Route Delivery"
      ? (order.stops || []).filter(Boolean) : [order.deliveryAddress || ""];
    if (!origin || !dests.length || !dests[0]) return Number(order.miles) || 0;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial` +
      `&origins=${origin}&destinations=${dests.map(encodeURIComponent).join("|")}&key=${key}`;
    const data = await (await fetch(url)).json();
    const meters = (data.rows?.[0]?.elements || []).map((e) => e.distance?.value || 0);
    const farthestMeters = Math.max(0, ...meters);
    return Math.round((farthestMeters / 1609.34) * 10) / 10;
  } catch (e) { console.error("distance matrix error", e); return Number(order.miles) || 0; }
}

/* ============== 1) CREATE CHECKOUT SESSION ============== */
app.post("/create-checkout-session", express.json(), async (req, res) => {
  try {
    const order = req.body || {};
    order.miles = await resolveMiles(order);                 // authoritative miles
    const priced = priceOrder(order);
    if (priced.custom) return res.status(400).json({ error: "custom_quote", reason: priced.reason });

    // persist the order (status: pending_payment) and use its tracking code everywhere
    const rec = store.create({ ...order, breakdown: priced.lines, total: priced.total });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: order.customer?.email,
      client_reference_id: rec.id,
      line_items: priced.lines.map((l) => ({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: Math.round(l.amount * 100), product_data: { name: `M&C — ${l.label}` } }
      })),
      success_url: (process.env.SITE_ORIGIN || "") + "/booking.html?paid=1&track=" + rec.id,
      cancel_url: (process.env.SITE_ORIGIN || "") + "/booking.html?canceled=1",
      metadata: { orderId: rec.id, total: String(priced.total) }
    });
    res.json({ id: session.id, url: session.url, trackingCode: rec.id });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

/* ============== 2) STRIPE WEBHOOK (raw body!) ============== */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event = req.body;
  const sig = req.headers["stripe-signature"];
  if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
    try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const paid = (s.amount_total || 0) / 100;
    const id = s.metadata?.orderId || s.client_reference_id;
    const order = (id && store.get(id)) || {};
    if (id) store.update(id, { status: "paid", paid: true, amountPaid: paid, stripePaymentId: s.payment_intent || s.id });
    await onPaid(order, paid, s.payment_intent || s.id);
  }
  res.json({ received: true });
});

async function onPaid(order, paid, paymentId) {
  const c = order.customer || {};
  const dest = order.serviceType === "Route Delivery"
    ? (order.stops || []).map((s, i) => `Stop ${i + 1}: ${s}`).join("<br>")
    : order.deliveryAddress;
  const html = `
    <h2>New paid order — M&C Logistics</h2>
    <p><b>Service:</b> ${order.serviceType}<br>
       <b>Customer:</b> ${c.name} · ${c.phone} · ${c.email}<br>
       <b>Pickup:</b> ${order.pickupAddress}<br>
       <b>Delivery:</b> ${dest}<br>
       <b>Date/Time:</b> ${order.date || "ASAP"} ${order.time || ""}<br>
       <b>Weight:</b> ${order.weight} lb<br>
       <b>Add-ons:</b> ${Object.keys(order.addons || {}).filter(k => order.addons[k]).join(", ") || "none"}<br>
       <b>Mileage:</b> ${order.miles} mi<br>
       <b>Total paid:</b> $${paid.toFixed(2)}<br>
       <b>Stripe payment:</b> ${paymentId}<br>
       <b>Instructions:</b> ${order.instructions || "—"}</p>`;
  await sendMail(ADMIN_EMAILS.join(","), `New paid order — $${paid.toFixed(2)} (${order.serviceType})`, html);
  await sendMail(c.email, "Your M&C Logistics delivery is confirmed", html);
  await createShipdayOrder(order, paid, paymentId).catch((e) => console.error("Shipday error", e));
}

/* ============== 3) SHIPDAY ORDER CREATION ============== */
async function createShipdayOrder(order, paid, paymentId) {
  const key = process.env.SHIPDAY_API_KEY;
  if (!key) { console.log("[shipday skipped] no SHIPDAY_API_KEY"); return; }
  const c = order.customer || {};
  const deliveryAddress = order.serviceType === "Route Delivery"
    ? (order.stops || []).filter(Boolean).join(" | ") : order.deliveryAddress;
  const payload = {
    orderNumber: "MC-" + paymentId.slice(-8).toUpperCase(),
    customerName: c.name, customerAddress: deliveryAddress, customerEmail: c.email, customerPhoneNumber: c.phone,
    restaurantName: "M&C Logistics", restaurantAddress: order.pickupAddress,
    expectedDeliveryDate: order.date || undefined, expectedDeliveryTime: order.time || undefined,
    deliveryInstruction: order.instructions || "",
    totalOrderCost: paid, paymentMethod: "credit_card",
    deliveryFee: paid
  };
  const resp = await fetch("https://api.shipday.com/orders", {
    method: "POST",
    headers: { "Authorization": `Basic ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  console.log("Shipday status", resp.status);
}

/* ============== 4) CUSTOM QUOTE REQUEST ============== */
app.post("/quote-request", express.json(), async (req, res) => {
  const o = req.body || {};
  await sendMail(ADMIN_EMAILS.join(","), "New custom quote request",
    `<pre>${JSON.stringify(o, null, 2)}</pre>`).catch(() => {});
  res.json({ received: true });
});

/* ============== 5) ADMIN DASHBOARD API ============== */
// List all orders (newest first)
app.get("/admin/orders", requireAdmin, (req, res) => res.json({ orders: store.all(), statuses: store.STATUSES }));
// Update an order's delivery status (drives public tracking)
app.patch("/admin/orders/:id", requireAdmin, express.json(), (req, res) => {
  const rec = store.update(req.params.id, { status: req.body.status });
  if (!rec) return res.status(404).json({ error: "not_found" });
  res.json({ order: rec });
});

/* ============== 6) PUBLIC TRACKING ============== */
// Customer-facing: GET /track/MC-XXXXXX  → safe subset of the order for the tracking widget
app.get("/track/:code", (req, res) => {
  const o = store.get(req.params.code);
  if (!o) return res.status(404).json({ error: "not_found" });
  res.json({
    code: o.id, status: o.status, serviceType: o.serviceType,
    from: o.pickupAddress, to: o.deliveryAddress || (o.stops || []).join(" | "),
    date: o.date, time: o.time, eta: o.eta || null, driver: o.driver || null
  });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`M&C checkout server on :${PORT}`));
