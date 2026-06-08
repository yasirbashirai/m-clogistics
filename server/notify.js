/* ==========================================================================
   M&C Logistics — email notifications (nodemailer).
   On a paid order: emails the dispatch team + a confirmation to the customer.
   No-ops cleanly (returns {sent:false}) until SMTP_* env vars are configured.
     SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
   ========================================================================== */
"use strict";
const nodemailer = require("nodemailer");

function transport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE) === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

const money = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

function orderLines(o) {
  const c = o.customer || {};
  const addons = Object.keys(o.addons || {}).filter((k) => o.addons[k]).join(", ") || "none";
  const stops = (o.stops || []).filter(Boolean);
  return [
    `Order: ${o.id}`,
    `Service type: ${o.serviceType}${o.timing ? " (" + o.timing + ")" : ""}`,
    `Customer: ${c.name} · ${c.phone} · ${c.email}`,
    `Pickup address: ${o.pickupAddress}`,
    o.serviceType === "Route Delivery"
      ? `Route stops (${o.numberOfStops}): ${stops.join(" | ")}`
      : `Delivery address: ${o.deliveryAddress}`,
    `Delivery date/time: ${(o.date || o.requestedDate || "ASAP")} ${o.time || ""}`.trim(),
    o.rolledOver ? `NOTE: ${o.rollNote || "Rolled to next available day (chosen day was full)."}` : null,
    `Vehicle: ${o.vehicle || "-"}`,
    `Package weight: ${o.weight} lb`,
    `Mileage: ${o.miles} mi${o.distanceSource ? " (" + o.distanceSource + ")" : ""}`,
    `Add-ons: ${addons}`,
    o.foamWrapItems ? `Foam-wrapped items: ${o.foamWrapItems}` : null,
    o.photoName ? `Item photo: ${o.photoName}` : null,
    `Total paid: ${money(o.amountPaid != null ? o.amountPaid : o.total)}`,
    `Stripe payment ID: ${o.stripePaymentId || "-"}`,
    o.instructions ? `Special instructions: ${o.instructions}` : null
  ].filter(Boolean);
}

async function notifyPaidOrder(order, dispatchEmails) {
  const t = transport();
  if (!t) return { sent: false, reason: "smtp_not_configured" };
  const from = process.env.MAIL_FROM || "M&C Logistics <dispatch@mclogistics.delivery>";
  const body = orderLines(order).join("\n");

  // 1) Dispatch / admin
  await t.sendMail({
    from,
    to: (dispatchEmails && dispatchEmails.length ? dispatchEmails : ["dispatch@mclogistics.delivery", "mcdeliverypersonnel24.7@gmail.com"]).join(","),
    subject: `New paid order ${order.id} — ${money(order.amountPaid != null ? order.amountPaid : order.total)}`,
    text: "A new order has been paid and is ready to dispatch.\n\n" + body
  });

  // 2) Customer confirmation
  if (order.customer && order.customer.email) {
    await t.sendMail({
      from,
      to: order.customer.email,
      subject: `M&C Logistics — order ${order.id} confirmed`,
      text: "Thank you! Your payment was received and your delivery is being dispatched.\n" +
            "(Service is rendered once payment is received.)\n\n" + body +
            "\n\nQuestions? Email dispatch@mclogistics.delivery"
    });
  }
  return { sent: true };
}

module.exports = { notifyPaidOrder, orderLines };
