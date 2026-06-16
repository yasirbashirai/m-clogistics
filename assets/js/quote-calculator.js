/* ==========================================================================
   M&C Logistics — Quote Engine  (shared by Booking page + chatbot)
   Implements the revised M&C pricing spec:
     • Single Delivery — weight-class distance tiers + mileage overage
         – Standard   (≤100 lb): 0–10 mi $39.99 … +$10/band up to 60 mi
         – Heavy   (101–200 lb): same in-area tiers as Standard. The $89.99
             rate applies only to deliveries outside the service area.
         – over 200 lb / appliance / oversized / "Request Quote" => custom quote
     • Route Delivery  — base fee + per-stop fee + farthest-stop mileage overage
     • Mileage overage — every mile over 60 × $1.50
     • Add-ons — Helper $75, Furniture dolly $5, Standard dolly $5,
                 Foam-wrap $5/item, Rush $15, Overnight $35, Weekend $20
     • Vehicle type — Car / Compact cargo van / Sprinter van / Box truck (no surcharge;
                 used for the per-day booking caps enforced server-side)
   Pricing numbers are NEVER trusted from the browser — the Stripe charge is
   recomputed server-side (see /server/pricing.js, kept in sync with this file).
   The customer never types miles; distance is calculated from the addresses.
   ========================================================================== */
(function (global) {
  "use strict";

  var P = {
    // Distance tiers by weight class. tiers[i] is the flat price for band bands[i].
    bands: [10, 20, 30, 40, 50, 60],
    weightClasses: [
      { maxWeight: 100, label: "Standard (≤100 lb)", tiers: [39.99, 49.99, 59.99, 69.99, 79.99, 89.99] },
      { maxWeight: 200, label: "Heavy (101–200 lb)", tiers: [39.99, 49.99, 59.99, 69.99, 79.99, 89.99] }
    ],
    maxWeight: 200,            // over this => custom quote (no instant checkout)
    overageStartMiles: 60,
    overagePerMile: 1.50,
    route: { base: 49.99, perStop: 19.00 },
    addons: {
      helper:         { amount: 75, label: "Helper" },
      furnitureDolly: { amount: 5,  label: "Furniture dolly" },
      standardDolly:  { amount: 5,  label: "Standard dolly" },
      rush:           { amount: 15, label: "Rush delivery" },
      overnight:      { amount: 35, label: "Overnight delivery" },
      weekend:        { amount: 20, label: "Weekend delivery" }
    },
    foamWrapPerItem: 5,        // $ per foam/blanket-wrapped item
    outsideTriCountyMin: 89.99, // deliveries outside Miami-Dade/Broward/Palm Beach start here
    // Box truck is flat-rated: $250 one-way / $500 round trip, ≤300 lb, within a 60-mi radius.
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
    dispatchLeadMinutes: 30,   // every order needs ≥30 min before a driver is dispatched
    gasPerGallon: 4.10         // assumption baked into the distance pricing model
  };

  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function fmt(n) { return "$" + r2(n).toFixed(2); }

  // Which weight class a package falls in (null => over the 200 lb instant-checkout cap)
  function weightClassFor(weight) {
    var w = Math.max(0, Number(weight) || 0);
    for (var i = 0; i < P.weightClasses.length; i++) {
      if (w <= P.weightClasses[i].maxWeight) return P.weightClasses[i];
    }
    return null;
  }

  // Distance line for a given weight class + miles (tier price, or last band + overage)
  function distanceLine(wc, miles) {
    var m = Math.max(0, Number(miles) || 0);
    var lines = [], total = 0, idx = -1;
    for (var i = 0; i < P.bands.length; i++) { if (m <= P.bands[i]) { idx = i; break; } }
    if (idx >= 0) {
      var lo = idx === 0 ? 0 : P.bands[idx - 1] + 1;
      lines.push({ label: "Distance (" + lo + "–" + P.bands[idx] + " mi)", amount: wc.tiers[idx] });
      total += wc.tiers[idx];
    } else {
      var basePrice = wc.tiers[wc.tiers.length - 1];   // 51–60 band price
      lines.push({ label: "Distance", amount: basePrice });
      total += basePrice;
      var extra = Math.round(m - P.overageStartMiles);
      var over = r2(extra * P.overagePerMile);
      lines.push({ label: "Mileage surcharge (" + extra + " mi × $" + P.overagePerMile.toFixed(2) + ")", amount: over });
      total += over;
    }
    return { lines: lines, total: r2(total) };
  }

  // Add-on / wrap / vehicle line items from a rich selection object.
  // input: { addons:{helper,furnitureDolly,standardDolly,rush,overnight,weekend}, foamWrapItems, vehicle }
  function extraLines(input) {
    input = input || {};
    var a = input.addons || {}, out = [];
    ["helper", "furnitureDolly", "standardDolly", "rush", "overnight", "weekend"].forEach(function (k) {
      if (a[k]) out.push({ label: P.addons[k].label, amount: P.addons[k].amount });
    });
    var items = Math.max(0, parseInt(input.foamWrapItems, 10) || 0);
    if (items > 0) out.push({ label: "Foam wrap (" + items + " item" + (items > 1 ? "s" : "") + " × $" + P.foamWrapPerItem.toFixed(2) + ")", amount: r2(items * P.foamWrapPerItem) });
    var veh = P.vehicles.find(function (v) { return v.id === input.vehicle; });
    if (veh && veh.surcharge > 0) out.push({ label: veh.label, amount: veh.surcharge });
    return out;
  }

  // Deliveries outside the tri-county area have a minimum charge. If the computed
  // total is below it, add a line to bring it up to the out-of-area minimum.
  function applyOutOfAreaFloor(input, lines, total) {
    if (!input.outsideTriCounty) return total;
    var min = P.outsideTriCountyMin;
    if (total < min) {
      lines.push({ label: "Out-of-area minimum (outside tri-county)", amount: r2(min - total) });
      return min;
    }
    return total;
  }

  function customResult(reason, service) {
    return { custom: true, reason: reason, service: service || "Custom", lines: [], total: null };
  }

  // ---- BOX TRUCK (flat rate) ----
  // input: { miles, weight, roundTrip, addons, foamWrapItems, vehicle }
  function boxTruckQuote(input) {
    var bt = P.boxTruck;
    var weight = Math.max(0, Number(input.weight) || 0);
    if (weight > bt.maxWeight) return customResult("Box truck loads over " + bt.maxWeight + " lb require a custom quote.", "Box Truck");

    var roundTrip = !!input.roundTrip;
    var base = roundTrip ? bt.roundTripRate : bt.flatRate;
    var lines = [{ label: roundTrip ? bt.roundTripLabel : bt.label, amount: base }];
    var total = base;

    var miles = Math.max(0, Number(input.miles) || 0);
    if (miles > bt.includedMiles) {
      var extra = Math.round(miles - bt.includedMiles);
      var over = r2(extra * P.overagePerMile);
      lines.push({ label: "Mileage surcharge (" + extra + " mi × $" + P.overagePerMile.toFixed(2) + ")", amount: over });
      total += over;
    }
    extraLines(input).forEach(function (l) { lines.push(l); total += l.amount; });
    return { custom: false, service: "Box Truck", miles: miles, roundTrip: roundTrip, lines: lines, total: r2(total) };
  }

  // ---- SINGLE DELIVERY ----
  // input: { miles, weight, addons, foamWrapItems, vehicle, oversized, requestQuote, roundTrip }
  function singleQuote(input) {
    input = input || {};
    if (input.requestQuote) return customResult("You requested a custom quote.", "Single Delivery");
    if (input.oversized)    return customResult("Appliance, furniture, oversized or special-handling items are priced per job.", "Single Delivery");
    // Box truck is flat-rated (pickup → drop-off, optional round trip) — not weight-band priced.
    if (input.vehicle === "box_truck") return boxTruckQuote(input);
    var wc = weightClassFor(input.weight);
    if (!wc) return customResult("Deliveries over " + P.maxWeight + " lb require a custom quote.", "Single Delivery");

    var miles = Math.max(0, Number(input.miles) || 0);
    var d = distanceLine(wc, miles);
    var lines = d.lines.slice(), total = d.total;
    extraLines(input).forEach(function (l) { lines.push(l); total += l.amount; });
    total = applyOutOfAreaFloor(input, lines, total);

    return { custom: false, service: "Single Delivery", weightClass: wc.label, miles: miles, lines: lines, total: r2(total) };
  }

  // ---- ROUTE DELIVERY ----
  // input: { stops(number), farthestMiles, weights:[..]|maxWeight, addons, foamWrapItems, vehicle, oversized, requestQuote }
  function routeQuote(input) {
    input = input || {};
    if (input.requestQuote) return customResult("You requested a custom quote.", "Route Delivery");
    if (input.oversized)    return customResult("Appliance, furniture, oversized or special-handling items are priced per job.", "Route Delivery");

    var heaviest = 0;
    if (Array.isArray(input.weights)) heaviest = input.weights.reduce(function (m, w) { return Math.max(m, Number(w) || 0); }, 0);
    else heaviest = Number(input.maxWeight) || Number(input.weight) || 0;
    if (heaviest > P.maxWeight) return customResult("Any stop over " + P.maxWeight + " lb requires a custom quote.", "Route Delivery");

    var stops = Math.max(1, parseInt(input.stops, 10) || 0);
    var lines = [], total = 0;

    lines.push({ label: "Route base fee", amount: P.route.base });
    total += P.route.base;

    var stopsCost = r2(stops * P.route.perStop);
    lines.push({ label: "Stops: " + stops + " × $" + P.route.perStop.toFixed(2), amount: stopsCost });
    total += stopsCost;

    var farthest = Math.max(0, Number(input.farthestMiles) || 0);
    if (farthest > P.overageStartMiles) {
      var extra = Math.round(farthest - P.overageStartMiles);
      var over = r2(extra * P.overagePerMile);
      lines.push({ label: "Mileage surcharge (" + extra + " mi × $" + P.overagePerMile.toFixed(2) + ")", amount: over });
      total += over;
    }

    extraLines(input).forEach(function (l) { lines.push(l); total += l.amount; });
    total = applyOutOfAreaFloor(input, lines, total);

    return { custom: false, service: "Route Delivery", stops: stops, farthestMiles: farthest, lines: lines, total: r2(total) };
  }

  // ---- Backward-compatible simple quote (used by the chatbot) ----
  function quote(input) {
    input = input || {};
    if (input.service === "appliance" || input.service === "event") {
      return customResult("This service is priced per job — request a custom quote.", "Custom");
    }
    var milesByZone = { same: 8, cross: 25, far: 55 };
    var miles = milesByZone[input.zone] != null ? milesByZone[input.zone] : 8;
    return singleQuote({
      miles: miles,
      weight: input.weight,
      addons: { rush: !!input.rush, weekend: !!input.weekend }
    });
  }

  global.MCQuote = {
    P: P, fmt: fmt, r2: r2,
    weightClassFor: weightClassFor, extraLines: extraLines,
    singleQuote: singleQuote, routeQuote: routeQuote, quote: quote
  };

})(window);
