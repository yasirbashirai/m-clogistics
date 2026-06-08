/* ==========================================================================
   M&C Logistics — Shipday dispatch integration.
   After a paid order, creates a delivery in Shipday so it can be dispatched and
   tracked end-to-end (customer gets the Shipday tracking link by email/SMS).
   No-ops cleanly (returns {created:false}) until SHIPDAY_API_KEY is configured.
   Docs: https://docs.shipday.com  (POST https://api.shipday.com/orders,
   header  Authorization: Basic <API_KEY>)
   ========================================================================== */
"use strict";

async function createShipdayOrder(order) {
  const key = process.env.SHIPDAY_API_KEY;
  if (!key) return { created: false, reason: "shipday_not_configured" };

  const c = order.customer || {};
  const stops = (order.stops || []).filter(Boolean);
  const dropoff = order.serviceType === "Route Delivery" ? (stops[0] || order.pickupAddress) : order.deliveryAddress;
  const extraStops = stops.length > 1 ? " | Additional stops: " + stops.slice(1).join(" | ") : "";

  const payload = {
    orderNumber: order.id,
    customerName: c.name,
    customerAddress: dropoff,
    customerEmail: c.email,
    customerPhoneNumber: c.phone,
    restaurantName: "M&C Logistics",
    restaurantAddress: order.pickupAddress,
    expectedDeliveryDate: order.date || order.requestedDate || undefined,
    expectedDeliveryTime: order.time || undefined,
    deliveryInstruction: [order.instructions, extraStops, order.foamWrapItems ? `Foam-wrapped items: ${order.foamWrapItems}` : ""].filter(Boolean).join(" ").trim(),
    deliveryFee: 0,
    totalOrderCost: order.amountPaid != null ? order.amountPaid : order.total,
    paymentMethod: "credit_card",
    creditCardType: "stripe",
    creditCardId: order.stripePaymentId || undefined
  };

  try {
    const r = await fetch("https://api.shipday.com/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + key },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    return { created: r.ok, status: r.status, data };
  } catch (e) {
    return { created: false, error: e.message };
  }
}

module.exports = { createShipdayOrder };
