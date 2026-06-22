/* ==========================================================================
   M&C Logistics — Square payments integration (Online Checkout / Payment Links).
   Mirrors the old Stripe Checkout flow: we create a Square-hosted payment page,
   redirect the customer to it, and a webhook (plus an authoritative server-side
   re-fetch) confirms payment before the order is ever dispatched.

   Credentials are read ENV-FIRST, then fall back to the admin dashboard
   settings (settings.payments.square{...}) so the client can self-configure
   without env vars / a redeploy — same pattern as the old Stripe wiring.

   Docs: https://developer.squareup.com/reference/square/checkout-api
         https://developer.squareup.com/reference/square/payments-api
   ========================================================================== */
"use strict";
const crypto = require("crypto");

// Square's API version (monthly release date). Override with SQUARE_VERSION if needed.
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2024-10-17";

// Resolve Square config: env vars win, then admin settings, else blanks.
function squareConfig(settings) {
  const sq = (settings && settings.payments && settings.payments.square) || {};
  const env = (process.env.SQUARE_ENV || sq.env || (settings && settings.payments && settings.payments.mode === "live" ? "production" : "")).toLowerCase();
  const isProd = env === "production" || env === "live" || env === "prod";
  return {
    accessToken: process.env.SQUARE_ACCESS_TOKEN || sq.accessToken || "",
    locationId: process.env.SQUARE_LOCATION_ID || sq.locationId || "",
    applicationId: process.env.SQUARE_APPLICATION_ID || sq.applicationId || "",
    signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || sq.webhookSignatureKey || "",
    production: isProd,
    base: isProd ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com"
  };
}

function isConfigured(settings) {
  const c = squareConfig(settings);
  return !!(c.accessToken && c.locationId);
}

// Square requires E.164. Normalize common US formats; return undefined if we
// can't be confident, so a malformed phone never blocks the whole checkout.
function e164(phone) {
  const d = String(phone || "").replace(/[^\d]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (String(phone || "").trim().startsWith("+") && d.length >= 8 && d.length <= 15) return "+" + d;
  return undefined;
}

// Only pre-fill the email if it looks valid (Square rejects the whole request on a
// bad email / reserved domain). The customer can still type it on the checkout page.
function validEmail(email) {
  const e = String(email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return undefined;
  if (/@(example|test)\.(com|net|org)$/i.test(e)) return undefined;
  return e;
}

function headers(cfg) {
  return {
    "Square-Version": SQUARE_VERSION,
    Authorization: "Bearer " + cfg.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

// Create a Square hosted checkout page for a priced order. Returns
// { url, orderId, paymentLinkId } on success, or { error } otherwise.
async function createPaymentLink(order, priced, opts) {
  const cfg = squareConfig(opts && opts.settings);
  if (!cfg.accessToken || !cfg.locationId) return { error: "square_not_configured" };

  const lines = (priced.lines || []).map((l) => ({
    name: ("M&C — " + l.label).slice(0, 500),
    quantity: "1",
    base_price_money: { amount: Math.round(Number(l.amount) * 100), currency: "USD" }
  }));
  // Square rejects an order with no line items — fall back to a single total line.
  if (!lines.length) {
    lines.push({ name: "M&C — Delivery", quantity: "1", base_price_money: { amount: Math.round(Number(priced.total) * 100), currency: "USD" } });
  }

  const body = {
    idempotency_key: (order.id + "-" + Date.now()).slice(0, 192),
    order: {
      location_id: cfg.locationId,
      reference_id: String(order.id).slice(0, 40),
      line_items: lines
    },
    checkout_options: {
      redirect_url: (opts && opts.redirectUrl) || undefined,
      ask_for_shipping_address: false
    },
    pre_populated_data: {
      buyer_email: validEmail(order.customer && order.customer.email),
      buyer_phone_number: e164(order.customer && order.customer.phone)
    }
  };

  try {
    const r = await fetch(cfg.base + "/v2/online-checkout/payment-links", {
      method: "POST", headers: headers(cfg), body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    const link = data && data.payment_link;
    if (r.ok && link && link.url) {
      return { url: link.url, orderId: link.order_id, paymentLinkId: link.id };
    }
    const msg = (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].code)) || ("http_" + r.status);
    return { error: msg };
  } catch (e) {
    return { error: e.message };
  }
}

// Authoritatively re-fetch a payment by id (used to confirm a webhook is real —
// a forged webhook can't make Square's API return COMPLETED for our account).
async function getPayment(paymentId, settings) {
  const cfg = squareConfig(settings);
  if (!cfg.accessToken || !paymentId) return null;
  try {
    const r = await fetch(cfg.base + "/v2/payments/" + encodeURIComponent(paymentId), { headers: headers(cfg) });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    return (data && data.payment) || null;
  } catch (_) { return null; }
}

// HMAC-SHA256 webhook signature check (defense in depth; the re-fetch above is
// the real guarantee). Square signs base64( HMAC( signatureKey, notifyUrl + rawBody ) ).
function verifySignature(signatureKey, notificationUrl, rawBody, signatureHeader) {
  if (!signatureKey || !signatureHeader || rawBody == null) return false;
  try {
    const payload = String(notificationUrl) + (Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    const expected = crypto.createHmac("sha256", signatureKey).update(payload).digest("base64");
    const a = Buffer.from(expected), b = Buffer.from(String(signatureHeader));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

module.exports = { squareConfig, isConfigured, createPaymentLink, getPayment, verifySignature, SQUARE_VERSION };
