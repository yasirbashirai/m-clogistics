/* ==========================================================================
   M&C Logistics — Authoritative server-side pricing
   Mirrors assets/js/quote-calculator.js. The server NEVER trusts the price
   sent by the browser — it recomputes from miles / stops / weight / add-ons.
   ========================================================================== */
"use strict";

const P = {
  singleTiers: [
    { max: 10, price: 29.99 }, { max: 20, price: 39.99 }, { max: 30, price: 49.99 },
    { max: 40, price: 59.99 }, { max: 50, price: 69.99 }, { max: 60, price: 79.99 }
  ],
  overageStartMiles: 60,
  overagePerMile: 1.5,
  route: { base: 49.99, perStop: 19.0 },
  addons: { rush: 15, weekend: 20, overnight: 35 },
  maxWeight: 100
};

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function addonLines(a = {}) {
  const out = [];
  if (a.rush) out.push({ label: "Rush Delivery", amount: P.addons.rush });
  if (a.weekend) out.push({ label: "Weekend Delivery", amount: P.addons.weekend });
  if (a.overnight) out.push({ label: "Overnight Delivery", amount: P.addons.overnight });
  return out;
}

/** Returns { custom:true, reason } OR { lines:[{label,amount}], total } */
function priceOrder(order) {
  const addons = order.addons || {};
  const oversized = !!order.oversized;
  const requestQuote = !!order.requestQuote || order.requestType === "Custom Quote";
  const weight = Number(order.weight) || 0;

  if (requestQuote) return { custom: true, reason: "Customer requested a custom quote." };
  if (oversized) return { custom: true, reason: "Oversized / special-handling item." };
  if (weight > P.maxWeight) return { custom: true, reason: `Over ${P.maxWeight} lb.` };

  const lines = [];
  let total = 0;

  if (order.serviceType === "Route Delivery") {
    const stops = Math.max(1, parseInt(order.numberOfStops, 10) || 1);
    lines.push({ label: "Route base fee", amount: P.route.base }); total += P.route.base;
    const stopsCost = r2(stops * P.route.perStop);
    lines.push({ label: `Stops: ${stops} × $${P.route.perStop.toFixed(2)}`, amount: stopsCost }); total += stopsCost;
    const far = Number(order.miles) || 0;
    if (far > P.overageStartMiles) {
      const over = r2((far - P.overageStartMiles) * P.overagePerMile);
      lines.push({ label: `Mileage surcharge (${Math.round(far - P.overageStartMiles)} mi)`, amount: over }); total += over;
    }
  } else {
    const miles = Number(order.miles) || 0;
    const tier = P.singleTiers.find((t) => miles <= t.max);
    if (tier) { lines.push({ label: "Distance", amount: tier.price }); total += tier.price; }
    else {
      const base = P.singleTiers[P.singleTiers.length - 1].price;
      lines.push({ label: "Distance (0–60 mi base)", amount: base }); total += base;
      const over = r2((miles - P.overageStartMiles) * P.overagePerMile);
      lines.push({ label: `Mileage surcharge (${Math.round(miles - P.overageStartMiles)} mi)`, amount: over }); total += over;
    }
  }

  addonLines(addons).forEach((l) => { lines.push(l); total += l.amount; });
  return { custom: false, lines, total: r2(total) };
}

module.exports = { priceOrder, P };
