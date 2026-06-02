"use strict";
const Stripe = require("stripe");
const { priceOrder } = require("./_lib/pricing");
const store = require("./_lib/store");
const { cors, readJson } = require("./_lib/util");

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const order = await readJson(req);
    const priced = priceOrder(order);
    if (priced.custom) return res.status(400).json({ error: "custom_quote", reason: priced.reason });

    // record the order with a tracking code (status: pending_payment)
    const rec = await store.create({ ...order, breakdown: priced.lines, total: priced.total });

    if (!process.env.STRIPE_SECRET_KEY) {
      // Stripe not connected yet → tell the client (it stays in demo mode)
      return res.status(200).json({ error: "stripe_not_configured", trackingCode: rec.id, total: priced.total });
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const origin = process.env.SITE_ORIGIN || ("https://" + req.headers.host);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: order.customer && order.customer.email,
      client_reference_id: rec.id,
      line_items: priced.lines.map((l) => ({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: Math.round(l.amount * 100), product_data: { name: "M&C — " + l.label } }
      })),
      success_url: origin + "/service-area.html?paid=1&code=" + rec.id,
      cancel_url: origin + "/booking.html?canceled=1",
      metadata: { orderId: rec.id, total: String(priced.total) }
    });
    res.json({ id: session.id, url: session.url, trackingCode: rec.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
