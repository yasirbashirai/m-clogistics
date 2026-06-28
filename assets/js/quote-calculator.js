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
    // Route pricing: a job only becomes a "route" (discounted) at routeThreshold stops.
    //   • Under the threshold → every stop is billed at smallStop ($39.99 each).
    //   • At/over the threshold → first stop $49.99 (base) + each additional stop $19.99 (perStop).
    route: { base: 49.99, perStop: 19.99, smallStop: 39.99, routeThreshold: 9 },
    addons: {
      helper:         { amount: 75, label: "Helper" },
      furnitureDolly: { amount: 5,  label: "Furniture dolly" },
      standardDolly:  { amount: 5,  label: "Standard dolly" },
      rush:           { amount: 15, label: "Rush delivery" },
      overnight:      { amount: 35, label: "Overnight delivery" },
      weekend:        { amount: 20, label: "Weekend delivery" }
    },
    // Fallback labels — used if P.addons ever arrives as a flat number map (server shape).
    addonLabels: { helper: "Helper", furnitureDolly: "Furniture dolly", standardDolly: "Standard dolly", rush: "Rush delivery", overnight: "Overnight delivery", weekend: "Weekend delivery" },
    foamWrapPerItem: 5,        // $ per foam/blanket-wrapped item
    // Deliveries outside Miami-Dade/Broward/Palm Beach: flat base + mileage beyond 60 mi.
    outsideTriCountyBase: 150,
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

  // Add-on price/label readers that tolerate BOTH config shapes:
  //   • object shape  {amount, label}   (this file's default)
  //   • flat-number map  {helper: 75}   (server / admin-saved shape)  + P.addonLabels
  // Without this, once /api/config loads the server's flat pricing the booking page
  // would render every selected add-on as "undefined".
  function addonFee(k) {
    var v = P.addons && P.addons[k];
    if (v && typeof v === "object") return Number(v.amount) || 0;
    return Number(v) || 0;
  }
  function addonLabel(k) {
    var v = P.addons && P.addons[k];
    if (v && typeof v === "object" && v.label != null) return v.label;
    return (P.addonLabels && P.addonLabels[k]) || k;
  }

  // Add-on / wrap / vehicle line items from a rich selection object.
  // input: { addons:{helper,furnitureDolly,standardDolly,rush,overnight,weekend}, foamWrapItems, vehicle }
  function extraLines(input) {
    input = input || {};
    var a = input.addons || {}, out = [];
    ["helper", "furnitureDolly", "standardDolly", "rush", "overnight", "weekend"].forEach(function (k) {
      if (a[k]) out.push({ label: addonLabel(k), amount: addonFee(k) });
    });
    var items = Math.max(0, parseInt(input.foamWrapItems, 10) || 0);
    if (items > 0) out.push({ label: "Foam wrap (" + items + " item" + (items > 1 ? "s" : "") + " × $" + P.foamWrapPerItem.toFixed(2) + ")", amount: r2(items * P.foamWrapPerItem) });
    var veh = P.vehicles.find(function (v) { return v.id === input.vehicle; });
    if (veh && veh.surcharge > 0) out.push({ label: veh.label, amount: veh.surcharge });
    return out;
  }

  // Mileage surcharge beyond the included radius (every mile over 60 × $1.50).
  function mileageLine(miles) {
    var m = Math.max(0, Number(miles) || 0);
    if (m <= P.overageStartMiles) return null;
    var extra = Math.round(m - P.overageStartMiles);
    return { label: "Mileage surcharge (" + extra + " mi × $" + P.overagePerMile.toFixed(2) + ")", amount: r2(extra * P.overagePerMile) };
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
    var lines = [], total = 0;
    if (input.outsideTriCounty) {
      // Outside the service area: flat $150 base + mileage beyond 60 mi (no weight bands).
      var base = Number(P.outsideTriCountyBase) || 150;
      lines.push({ label: "Out-of-area base (outside service area)", amount: base });
      total += base;
      var ml = mileageLine(miles);
      if (ml) { lines.push(ml); total += ml.amount; }
    } else {
      var d = distanceLine(wc, miles);
      d.lines.forEach(function (l) { lines.push(l); }); total += d.total;
    }
    extraLines(input).forEach(function (l) { lines.push(l); total += l.amount; });

    return { custom: false, service: "Single Delivery", weightClass: wc.label, miles: miles, outsideTriCounty: !!input.outsideTriCounty, lines: lines, total: r2(total) };
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
    var threshold = P.route.routeThreshold || 9;
    var isRoute = stops >= threshold;                          // a true (discounted) route at 9+ stops
    var smallStop = Number(P.route.smallStop) || 39.99;
    var perStop = Number(P.route.perStop) || 19.99;
    var addRate = isRoute ? perStop : smallStop;               // additional-stop rate
    // First stop / starting fee: out-of-area $150, else $49.99 for a route, else $39.99.
    var startFee = input.outsideTriCounty ? (Number(P.outsideTriCountyBase) || 150)
                 : (isRoute ? P.route.base : smallStop);

    var lines = [], total = 0;
    lines.push({ label: input.outsideTriCounty ? "Out-of-area base — first stop" : (isRoute ? "Route base — first stop" : "First stop"), amount: startFee });
    total += startFee;

    var additional = stops - 1;
    if (additional > 0) {
      var addCost = r2(additional * addRate);
      lines.push({ label: "Additional stops: " + additional + " × $" + addRate.toFixed(2), amount: addCost });
      total += addCost;
    }

    var farthest = Math.max(0, Number(input.farthestMiles) || 0);
    var ml = mileageLine(farthest);
    if (ml) { lines.push(ml); total += ml.amount; }

    extraLines(input).forEach(function (l) { lines.push(l); total += l.amount; });

    return { custom: false, service: "Route Delivery", stops: stops, isRoute: isRoute, farthestMiles: farthest, outsideTriCounty: !!input.outsideTriCounty, lines: lines, total: r2(total) };
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
