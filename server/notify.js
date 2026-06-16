/* ==========================================================================
   M&C Logistics — email notifications (nodemailer).
   On a paid order: emails the dispatch team + a confirmation to the customer.
   On a contact/careers submission: emails the dispatch team.
   SMTP config comes from the admin dashboard (settings.smtp), so the client can
   enable email themselves — or from SMTP_* env vars, which take priority.
   No-ops cleanly (returns {sent:false}) until SMTP is configured either way.
     env: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
     dashboard: settings.smtp = { host, port, secure, user, pass, from }
   ========================================================================== */
"use strict";
const nodemailer = require("nodemailer");

// Build a transport from env (preferred) or the dashboard-saved smtp settings.
function transport(smtp) {
  smtp = smtp || {};
  const host = process.env.SMTP_HOST || smtp.host;
  if (!host) return null;
  const user = process.env.SMTP_USER || smtp.user;
  const pass = process.env.SMTP_PASS || smtp.pass;
  const secure = process.env.SMTP_SECURE != null
    ? String(process.env.SMTP_SECURE) === "true"
    : !!smtp.secure;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || smtp.port) || 587,
    secure,
    auth: user ? { user, pass } : undefined
  });
}
function mailFrom(smtp) {
  return process.env.MAIL_FROM || (smtp && smtp.from) || "M&C Logistics <dispatch@mclogistics.delivery>";
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

async function notifyPaidOrder(order, dispatchEmails, smtp) {
  const t = transport(smtp);
  if (!t) return { sent: false, reason: "smtp_not_configured" };
  const from = mailFrom(smtp);
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

// Email dispatch when a contact form or careers application comes in.
async function notifyContact(sub, dispatchEmails, smtp) {
  const t = transport(smtp);
  if (!t) return { sent: false, reason: "smtp_not_configured" };
  const from = mailFrom(smtp);
  const kind = sub.kind === "career" ? "career application" : "contact message";
  const body = [
    `New ${kind} from the website:`,
    "",
    `Reference: ${sub.id || "-"}`,
    `Name: ${sub.name || "-"}`,
    `Email: ${sub.email || "-"}`,
    `Phone: ${sub.phone || "-"}`,
    sub.position ? `Position: ${sub.position}` : null,
    "",
    "Message:",
    sub.message || "(none)"
  ].filter((l) => l !== null).join("\n");

  await t.sendMail({
    from,
    replyTo: sub.email || undefined,
    to: (dispatchEmails && dispatchEmails.length ? dispatchEmails : ["dispatch@mclogistics.delivery", "mcdeliverypersonnel24.7@gmail.com"]).join(","),
    subject: `New ${kind}${sub.name ? " — " + sub.name : ""}`,
    text: body
  });
  return { sent: true };
}

module.exports = { notifyPaidOrder, notifyContact, orderLines };
