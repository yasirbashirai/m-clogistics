"use strict";
/* Stripe webhook. On Vercel we verify by RE-FETCHING the session from Stripe
   (authenticated with the secret key) instead of raw-body signature checks —
   robust on serverless. On paid: mark order, email dispatch, push to Shipday. */
const Stripe = require("stripe");
const store = require("./_lib/store");
const { readJson } = require("./_lib/util");

const ADMIN_EMAILS = ["dispatch@mclogistics.delivery", "mcdeliverypersonnel24.7@gmail.com"];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");
    const event = await readJson(req);
    if (event.type !== "checkout.session.completed") return res.json({ received: true });

    // re-fetch the session to confirm it's real + paid
    const sid = event.data && event.data.object && event.data.object.id;
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.payment_status !== "paid") return res.json({ received: true, status: s.payment_status });

    const id = (s.metadata && s.metadata.orderId) || s.client_reference_id;
    const order = (id && (await store.get(id))) || {};
    const paid = (s.amount_total || 0) / 100;
    if (id) await store.update(id, { status: "paid", paid: true, amountPaid: paid, stripePaymentId: s.payment_intent || s.id });

    await notify(order, paid, s.payment_intent || s.id).catch((e) => console.error("notify", e));
    await shipday(order, paid, s.payment_intent || s.id).catch((e) => console.error("shipday", e));
    res.json({ received: true });
  } catch (e) {
    console.error(e);
    res.status(200).json({ received: true, error: e.message }); // 200 so Stripe doesn't retry-storm
  }
};

async function notify(order, paid, paymentId) {
  if (!process.env.SMTP_HOST) return;
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  const c = order.customer || {};
  const dest = order.serviceType === "Route Delivery" ? (order.stops || []).join(" | ") : order.deliveryAddress;
  const html = `<h2>Paid order — M&C Logistics</h2>
    <p><b>Service:</b> ${order.serviceType}<br><b>Customer:</b> ${c.name} · ${c.phone} · ${c.email}<br>
    <b>Pickup:</b> ${order.pickupAddress}<br><b>Delivery:</b> ${dest}<br>
    <b>Date/Time:</b> ${order.date || "ASAP"} ${order.time || ""}<br><b>Weight:</b> ${order.weight} lb<br>
    <b>Total paid:</b> $${paid.toFixed(2)}<br><b>Stripe:</b> ${paymentId}<br>
    <b>Instructions:</b> ${order.instructions || "—"}</p>`;
  const from = process.env.MAIL_FROM || "orders@mclogistics.delivery";
  await t.sendMail({ from, to: ADMIN_EMAILS.join(","), subject: `Paid order $${paid.toFixed(2)} (${order.serviceType})`, html });
  if (c.email) await t.sendMail({ from, to: c.email, subject: "Your M&C Logistics delivery is confirmed", html });
}

async function shipday(order, paid, paymentId) {
  if (!process.env.SHIPDAY_API_KEY) return;
  const c = order.customer || {};
  const dest = order.serviceType === "Route Delivery" ? (order.stops || []).filter(Boolean).join(" | ") : order.deliveryAddress;
  await fetch("https://api.shipday.com/orders", {
    method: "POST",
    headers: { Authorization: "Basic " + process.env.SHIPDAY_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      orderNumber: order.id || ("MC-" + String(paymentId).slice(-8)),
      customerName: c.name, customerAddress: dest, customerEmail: c.email, customerPhoneNumber: c.phone,
      restaurantName: "M&C Logistics", restaurantAddress: order.pickupAddress,
      expectedDeliveryDate: order.date || undefined, expectedDeliveryTime: order.time || undefined,
      deliveryInstruction: order.instructions || "", totalOrderCost: paid, deliveryFee: paid, paymentMethod: "credit_card"
    })
  });
}
