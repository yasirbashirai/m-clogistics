/* ==========================================================================
   M&C Logistics — authoritative server-side pricing.
   priceOrder(order, P) — P is the pricing config (from the store/admin) or the
   built-in default. The server NEVER trusts the price sent by the browser.
   Kept in sync with assets/js/quote-calculator.js.
   ========================================================================== */
"use strict";

const DEFAULT_P = {
  bands: [10, 20, 30, 40, 50, 60],
  weightClasses: [
    { maxWeight: 100, label: "Standard (≤100 lb)", tiers: [39.99, 49.99, 59.99, 69.99, 79.99, 89.99] },
    { maxWeight: 200, label: "Heavy (101–200 lb)", tiers: [39.99, 49.99, 59.99, 69.99, 79.99, 89.99] }
  ],
  maxWeight: 200,
  overageStartMiles: 60,
  overagePerMile: 1.5,
  route: { base: 49.99, perStop: 19.0 },
  addons: { helper: 75, furnitureDolly: 5, standardDolly: 5, rush: 15, overnight: 35, weekend: 20 },
  addonLabels: { helper: "Helper", furnitureDolly: "Furniture dolly", standardDolly: "Standard dolly", rush: "Rush delivery", overnight: "Overnight delivery", weekend: "Weekend delivery" },
  foamWrapPerItem: 5,
  outsideTriCountyMin: 89.99,
  // Box truck is flat-rated (not weight-band priced): $250 one-way / $500 round trip,
  // for loads up to 300 lb within a 60-mile radius. Beyond 60 mi adds the mileage surcharge.
  boxTruck: {
    flatRate: 250,
    roundTripRate: 500,
    maxWeight: 300,
    includedMiles: 60,
    label: "Box truck — pickup & drop-off (≤300 lb, within 60 mi)",
    roundTripLabel: "Box truck — round trip (≤300 lb, within 60 mi)"
  },
  vehicles: [
    { id: "car",          label: "Car",               surcharge: 0, dailyCap: 25 },
    { id: "compact_van",  label: "Compact cargo van", surcharge: 0, dailyCap: 20 },
    { id: "sprinter_van", label: "Sprinter van",      surcharge: 0, dailyCap: 25 },
    { id: "box_truck",    label: "Box truck",         surcharge: 0, dailyCap: 10 }
  ],
  dispatchLeadMinutes: 30
};

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function weightClassFor(P, weight) {
  const w = Math.max(0, Number(weight) || 0);
  return P.weightClasses.find((c) => w <= c.maxWeight) || null;
}

function distanceLines(P, wc, miles) {
  const m = Math.max(0, Number(miles) || 0);
  const lines = [];
  let total = 0;
  let idx = P.bands.findIndex((b) => m <= b);
  if (idx >= 0) {
    const lo = idx === 0 ? 0 : P.bands[idx - 1] + 1;
    lines.push({ label: `Distance (${lo}–${P.bands[idx]} mi)`, amount: wc.tiers[idx] });
    total += wc.tiers[idx];
  } else {
    const base = wc.tiers[wc.tiers.length - 1];
    lines.push({ label: "Distance", amount: base });
    total += base;
    const extra = Math.round(m - P.overageStartMiles);
    const over = r2(extra * P.overagePerMile);
    lines.push({ label: `Mileage surcharge (${extra} mi × $${P.overagePerMile.toFixed(2)})`, amount: over });
    total += over;
  }
  return { lines, total: r2(total) };
}

function extraLines(P, order) {
  const a = order.addons || {};
  const out = [];
  ["helper", "furnitureDolly", "standardDolly", "rush", "overnight", "weekend"].forEach((k) => {
    if (a[k]) out.push({ label: P.addonLabels[k] || k, amount: P.addons[k] });
  });
  const items = Math.max(0, parseInt(order.foamWrapItems, 10) || 0);
  if (items > 0) out.push({ label: `Foam wrap (${items} item${items > 1 ? "s" : ""} × $${P.foamWrapPerItem.toFixed(2)})`, amount: r2(items * P.foamWrapPerItem) });
  const veh = (P.vehicles || []).find((v) => v.id === order.vehicle);
  if (veh && veh.surcharge > 0) out.push({ label: veh.label, amount: veh.surcharge });
  return out;
}

// Box truck flat-rate quote — $250 one-way / $500 round trip (≤300 lb, within 60 mi),
// plus the mileage surcharge beyond 60 mi and any selected add-ons.
function boxTruckQuote(order, P) {
  const bt = P.boxTruck || DEFAULT_P.boxTruck;
  const weight = Math.max(0, Number(order.weight) || 0);
  if (weight > bt.maxWeight) return { custom: true, reason: `Box truck loads over ${bt.maxWeight} lb require a custom quote.` };

  const lines = [];
  let total = 0;
  const roundTrip = !!order.roundTrip;
  const base = roundTrip ? bt.roundTripRate : bt.flatRate;
  lines.push({ label: roundTrip ? bt.roundTripLabel : bt.label, amount: base });
  total += base;

  const miles = Math.max(0, Number(order.miles) || 0);
  if (miles > bt.includedMiles) {
    const extra = Math.round(miles - bt.includedMiles);
    const over = r2(extra * P.overagePerMile);
    lines.push({ label: `Mileage surcharge (${extra} mi × $${P.overagePerMile.toFixed(2)})`, amount: over });
    total += over;
  }

  extraLines(P, order).forEach((l) => { lines.push(l); total += l.amount; });
  return { custom: false, lines, total: r2(total) };
}

function priceOrder(order, P) {
  P = P || DEFAULT_P;
  // Forward-compatible: fill any missing config keys from the default.
  for (const k of Object.keys(DEFAULT_P)) if (P[k] === undefined) P[k] = DEFAULT_P[k];

  const oversized = !!order.oversized;
  const requestQuote = !!order.requestQuote || order.requestType === "Custom Quote";
  if (requestQuote) return { custom: true, reason: "Customer requested a custom quote." };
  if (oversized) return { custom: true, reason: "Oversized / special-handling item." };

  // Box truck uses its own flat-rate model (single pickup → drop-off, optional round trip).
  if (order.vehicle === "box_truck" && order.serviceType !== "Route Delivery") return boxTruckQuote(order, P);

  const lines = [];
  let total = 0;

  if (order.serviceType === "Route Delivery") {
    const heaviest = Number(order.weight) || 0;
    if (heaviest > P.maxWeight) return { custom: true, reason: `Any stop over ${P.maxWeight} lb requires a custom quote.` };
    const stops = Math.max(1, parseInt(order.numberOfStops, 10) || 1);
    lines.push({ label: "Route base fee", amount: P.route.base }); total += P.route.base;
    const stopsCost = r2(stops * P.route.perStop);
    lines.push({ label: `Stops: ${stops} × $${P.route.perStop.toFixed(2)}`, amount: stopsCost }); total += stopsCost;
    const far = Number(order.miles) || 0;
    if (far > P.overageStartMiles) {
      const extra = Math.round(far - P.overageStartMiles);
      const over = r2(extra * P.overagePerMile);
      lines.push({ label: `Mileage surcharge (${extra} mi × $${P.overagePerMile.toFixed(2)})`, amount: over }); total += over;
    }
  } else {
    const wc = weightClassFor(P, order.weight);
    if (!wc) return { custom: true, reason: `Deliveries over ${P.maxWeight} lb require a custom quote.` };
    const d = distanceLines(P, wc, Number(order.miles) || 0);
    d.lines.forEach((l) => { lines.push(l); total += l.amount; });
  }

  extraLines(P, order).forEach((l) => { lines.push(l); total += l.amount; });

  // Out-of-area minimum: deliveries outside the tri-county area start at a floor price.
  if (order.outsideTriCounty) {
    const min = P.outsideTriCountyMin != null ? P.outsideTriCountyMin : 89.99;
    if (total < min) { lines.push({ label: "Out-of-area minimum (outside tri-county)", amount: r2(min - total) }); total = min; }
  }

  return { custom: false, lines, total: r2(total) };
}

module.exports = { priceOrder, DEFAULT_P };
