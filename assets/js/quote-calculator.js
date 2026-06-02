/* ==========================================================================
   M&C Logistics — Quote Engine  (shared by Pricing page, Booking page, chatbot)
   Implements the official M&C pricing spec:
     • Single Delivery — distance tiers + mileage overage
     • Route Delivery  — base fee + per-stop fee + mileage overage
     • Add-ons (rush / weekend / overnight)
     • Instant checkout only up to 100 lb; >100 lb / oversized / "request quote"
       => returns a custom-quote result (no instant price).
   Pure front-end math. The Stripe charge itself is created server-side
   (see /server/create-checkout-session + README).
   ========================================================================== */
(function (global) {
  "use strict";

  var P = {
    // Single Delivery distance tiers (price for the whole delivery within the band)
    singleTiers: [
      { max: 10, price: 29.99, label: "0–10 mi" },
      { max: 20, price: 39.99, label: "11–20 mi" },
      { max: 30, price: 49.99, label: "21–30 mi" },
      { max: 40, price: 59.99, label: "31–40 mi" },
      { max: 50, price: 69.99, label: "41–50 mi" },
      { max: 60, price: 79.99, label: "51–60 mi" }
    ],
    overageStartMiles: 60,
    overagePerMile: 1.50,
    route: { base: 49.99, perStop: 19.00 },
    addons: {
      rush:      { amount: 15, label: "Rush Delivery" },
      weekend:   { amount: 20, label: "Weekend Delivery" },
      overnight: { amount: 35, label: "Overnight Delivery" }
    },
    maxWeight: 100,        // lb — per delivery (single) / per stop (route)
    gasPerGallon: 4.10     // assumption used in distance pricing model
  };

  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function fmt(n) { return "$" + r2(n).toFixed(2); }

  // Add-on line items from a flags object {rush,weekend,overnight}
  function addonLines(a) {
    a = a || {};
    var out = [];
    ["rush", "weekend", "overnight"].forEach(function (k) {
      if (a[k]) out.push({ label: P.addons[k].label, amount: P.addons[k].amount });
    });
    return out;
  }

  function customResult(reason, service) {
    return { custom: true, reason: reason, service: service || "Custom", lines: [], total: null };
  }

  function overWeight(w) { return Number(w) > P.maxWeight; }

  // ---- SINGLE DELIVERY ----
  // input: { miles, weight, addons:{rush,weekend,overnight}, oversized, requestQuote }
  function singleQuote(input) {
    input = input || {};
    if (input.requestQuote) return customResult("You requested a custom quote.", "Single Delivery");
    if (input.oversized)    return customResult("Appliance, furniture, oversized or special-handling items are priced per job.", "Single Delivery");
    if (overWeight(input.weight)) return customResult("Deliveries over " + P.maxWeight + " lb require a custom quote.", "Single Delivery");

    var miles = Math.max(0, Number(input.miles) || 0);
    var lines = [], total = 0;

    var tier = P.singleTiers.find(function (t) { return miles <= t.max; });
    if (tier) {
      lines.push({ label: "Distance (" + tier.label + ")", amount: tier.price });
      total += tier.price;
    } else {
      var last = P.singleTiers[P.singleTiers.length - 1];   // 51–60 band = $79.99
      lines.push({ label: "Distance (0–60 mi base)", amount: last.price });
      total += last.price;
      var over = r2((miles - P.overageStartMiles) * P.overagePerMile);
      lines.push({ label: "Mileage surcharge (" + Math.round(miles - P.overageStartMiles) + " mi × $" + P.overagePerMile.toFixed(2) + ")", amount: over });
      total += over;
    }

    addonLines(input.addons).forEach(function (l) { lines.push(l); total += l.amount; });

    return { custom: false, service: "Single Delivery", miles: miles, lines: lines, total: r2(total) };
  }

  // ---- ROUTE DELIVERY ----
  // input: { stops(number), farthestMiles, weights:[..]|maxWeight, addons, oversized, requestQuote }
  function routeQuote(input) {
    input = input || {};
    if (input.requestQuote) return customResult("You requested a custom quote.", "Route Delivery");
    if (input.oversized)    return customResult("Appliance, furniture, oversized or special-handling items are priced per job.", "Route Delivery");

    // weight check — any stop over 100 lb => custom
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
      var over = r2((farthest - P.overageStartMiles) * P.overagePerMile);
      lines.push({ label: "Mileage surcharge (" + Math.round(farthest - P.overageStartMiles) + " mi × $" + P.overagePerMile.toFixed(2) + ")", amount: over });
      total += over;
    }

    addonLines(input.addons).forEach(function (l) { lines.push(l); total += l.amount; });

    return { custom: false, service: "Route Delivery", stops: stops, farthestMiles: farthest, lines: lines, total: r2(total) };
  }

  // ---- Backward-compatible simple quote (used by the chatbot) ----
  // Maps the old {service, weight, zone, rush, weekend} to a Single Delivery estimate.
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
    P: P, fmt: fmt, r2: r2, addonLines: addonLines,
    singleQuote: singleQuote, routeQuote: routeQuote, quote: quote
  };

  /* ----------------------------------------------------------------------
     PRICING-PAGE instant estimator binding (only runs if the widget exists)
     Expected elements: #qcType, #qcMiles, #qcWeight, #qcStops (+ wrapper #qcStopsRow),
       #qcRush, #qcWeekend, #qcOvernight, #qcOversized, #qcLines, #qcTotal
     ---------------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", function () {
    var typeEl = document.getElementById("qcType");
    if (!typeEl) return;
    var milesEl = document.getElementById("qcMiles"),
        weightEl = document.getElementById("qcWeight"),
        stopsEl = document.getElementById("qcStops"),
        stopsRow = document.getElementById("qcStopsRow"),
        rushEl = document.getElementById("qcRush"),
        wkndEl = document.getElementById("qcWeekend"),
        overEl = document.getElementById("qcOvernight"),
        bigEl = document.getElementById("qcOversized"),
        linesEl = document.getElementById("qcLines"),
        totalEl = document.getElementById("qcTotal");

    function render() {
      var isRoute = typeEl.value === "route";
      if (stopsRow) stopsRow.style.display = isRoute ? "" : "none";
      var addons = { rush: rushEl && rushEl.checked, weekend: wkndEl && wkndEl.checked, overnight: overEl && overEl.checked };
      var common = { addons: addons, oversized: bigEl && bigEl.checked };
      var res = isRoute
        ? routeQuote(Object.assign({ stops: stopsEl && stopsEl.value, farthestMiles: milesEl && milesEl.value, maxWeight: weightEl && weightEl.value }, common))
        : singleQuote(Object.assign({ miles: milesEl && milesEl.value, weight: weightEl && weightEl.value }, common));

      if (!linesEl || !totalEl) return;
      if (res.custom) {
        linesEl.innerHTML = "<div class='qc-custom'>" + res.reason + "</div>";
        totalEl.textContent = "Custom quote";
        return;
      }
      linesEl.innerHTML = res.lines.map(function (l) {
        return "<div class='quote-line'><span>" + l.label + "</span><span>" + fmt(l.amount) + "</span></div>";
      }).join("");
      totalEl.textContent = fmt(res.total);
    }

    [typeEl, milesEl, weightEl, stopsEl, rushEl, wkndEl, overEl, bigEl].forEach(function (el) {
      if (el) el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input", render);
    });
    render();
  });

})(window);
