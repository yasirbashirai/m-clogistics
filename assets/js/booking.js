/* ==========================================================================
   M&C Logistics — Booking + Checkout
   • Single vs Route service with conditional fields
   • Distance is calculated AUTOMATICALLY from the addresses — the customer
     never types miles (backend /api/distance, with a keyless geocode fallback)
   • Live price that builds as options are clicked (no static price table)
   • Delivery type (Same-Day / Rush / Overnight / Scheduled) + 30-min lead time
   • Vehicle type with per-day booking caps (rolls to next day when full)
   • Add-ons: Helper, dollies, foam wrap (qty), weekend auto-fee, photo upload
   • Quote triggers (>200 lb / oversized / request-quote) → custom-quote path
   • Stripe charge is created SERVER-SIDE; service is dispatched once paid.
   ========================================================================== */
(function () {
  "use strict";

  var form = document.getElementById("bookForm");
  if (!form || !window.MCQuote) return;

  var CFG = window.MC_CONFIG || {};
  var MQ = window.MCQuote, fmt = MQ.fmt, P = MQ.P;
  var $ = function (id) { return document.getElementById(id); };

  var svc = "single";
  var miles = null;          // authoritative auto-distance (single drop-off / route farthest stop)
  var distSource = "";       // "google" | "server" | "estimate"
  var lastKey = "";          // address signature of the last computed distance
  var distSeq = 0;           // guards against stale async distance results
  var rolledDate = null;     // next-available date when the chosen day is full
  var geoCache = {};         // memoize geocodes so route lookups don't refetch the pickup

  var seg = $("svcSeg"), singleBlock = $("singleBlock"), routeBlock = $("routeBlock"),
      stopsList = $("stopsList"), sumSvc = $("sumSvc"), linesEl = $("quoteLines"),
      totalEl = $("quoteTotal"), customMsg = $("customMsg"), bookMsg = $("bookMsg"),
      availMsg = $("availMsg"), payBtn = $("payBtn"), quoteBtn = $("quoteBtn"),
      distReadout = $("distReadout"), distText = $("distText");

  /* ------------------------------------------------------------------ utils */
  function localISO(d) {
    d = d || new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }
  function humanDate(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function vehLabel(id) { var v = P.vehicles.find(function (x) { return x.id === id; }); return v ? v.label : id; }
  function isWeekend(iso) {
    var d = iso ? new Date(iso + "T12:00:00") : new Date();
    var day = d.getDay();
    return day === 0 || day === 6;
  }
  function effectiveDate() {
    return ($("bkTiming").value === "scheduled" && $("bkDate").value) ? $("bkDate").value : localISO();
  }

  /* --------------------------------------------------- distance (auto miles) */
  function haversineMiles(a, b) {
    var R = 3958.8, toRad = function (x) { return x * Math.PI / 180; };
    var dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function geocode(q) {
    if (geoCache[q]) return Promise.resolve(geoCache[q]);
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q);
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pt = (j && j[0]) ? { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) } : null;
        if (pt) geoCache[q] = pt;
        return pt;
      });
  }
  // Resolve miles between two addresses: backend first, keyless geocode fallback.
  function pairMiles(from, to) {
    var viaBackend = Promise.resolve(null);
    if (CFG.distanceEndpoint) {
      viaBackend = fetch(CFG.distanceEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: from, to: to })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return (d && d.miles != null && !d.error) ? { miles: Math.round(d.miles), source: d.source || "server" } : null; })
        .catch(function () { return null; });
    }
    return viaBackend.then(function (res) {
      if (res) return res;
      return Promise.all([geocode(from), geocode(to)]).then(function (pts) {
        if (pts[0] && pts[1]) {
          var mi = haversineMiles(pts[0], pts[1]) * 1.3;   // ~road factor
          return { miles: Math.max(1, Math.round(mi)), source: "estimate" };
        }
        return null;
      }).catch(function () { return null; });
    });
  }

  function setDist(text, state) {
    distText.textContent = text;
    distReadout.classList.toggle("is-loading", state === "loading");
    distReadout.classList.toggle("is-ready", state === "ready");
  }

  function addressTargets() {
    var p = $("pickupAddress").value.trim();
    if (!p) return null;
    if (svc === "single") {
      var d = $("dropoffAddress").value.trim();
      return d ? { from: p, tos: [d] } : null;
    }
    var tos = [];
    stopsList.querySelectorAll("input").forEach(function (i) { var v = i.value.trim(); if (v) tos.push(v); });
    return tos.length ? { from: p, tos: tos } : null;
  }

  var distTimer;
  function scheduleDistance() {
    clearTimeout(distTimer);
    var t = addressTargets();
    if (!t) {
      miles = null; lastKey = "";
      setDist("Enter the pickup and delivery addresses — we calculate the distance automatically.", "");
      render();
      return;
    }
    var key = t.from + "=>" + t.tos.join("|");
    if (key === lastKey && miles != null) return;
    setDist("Calculating distance…", "loading");
    distTimer = setTimeout(function () { computeDistance(t, key); }, 700);
  }

  function computeDistance(t, key) {
    var seq = ++distSeq;
    var jobs = t.tos.map(function (to) { return pairMiles(t.from, to); });
    Promise.all(jobs).then(function (results) {
      if (seq !== distSeq) return;   // a newer request superseded this one
      var best = 0;
      results.forEach(function (r) { if (r && r.miles > best) { best = r.miles; distSource = r.source; } });
      if (best > 0) {
        miles = best; lastKey = key;
        var label = (svc === "route" ? "Farthest stop ≈ " : "Distance ≈ ") + best + " mi";
        if (distSource === "estimate") label += " (estimated — dispatch confirms)";
        setDist(label, "ready");
      } else {
        miles = null;
        setDist("We couldn't auto-calculate the distance. Check the addresses, or dispatch will confirm it.", "");
      }
      render();
    });
  }

  /* ----------------------------------------------------------- service toggle */
  seg.addEventListener("click", function (e) {
    var b = e.target.closest(".seg__btn"); if (!b) return;
    svc = b.getAttribute("data-svc");
    seg.querySelectorAll(".seg__btn").forEach(function (x) { x.classList.toggle("active", x === b); });
    singleBlock.style.display = svc === "single" ? "" : "none";
    routeBlock.style.display = svc === "route" ? "" : "none";
    if (svc === "route") buildStops();
    miles = null; lastKey = "";
    scheduleDistance();
    render();
  });

  /* ------------------------------------------------------ build stop fields */
  function buildStops() {
    var n = Math.max(1, Math.min(9, parseInt($("bkStops").value, 10) || 1));
    var existing = {};
    stopsList.querySelectorAll("input").forEach(function (inp, i) { existing[i] = inp.value; });
    stopsList.innerHTML = "";
    for (var i = 0; i < n; i++) {
      var row = document.createElement("div");
      row.className = "stop-row";
      row.innerHTML = "<span class='stop-no'>" + (i + 1) + "</span>" +
        "<input type='text' autocomplete='off' placeholder='Stop " + (i + 1) + " address' value='" +
        (existing[i] ? existing[i].replace(/'/g, "&#39;") : "") + "'>";
      stopsList.appendChild(row);
    }
    stopsList.querySelectorAll("input").forEach(function (inp) { inp.addEventListener("input", function () { lastKey = ""; scheduleDistance(); }); });
  }
  $("bkStops").addEventListener("input", function () { buildStops(); lastKey = ""; scheduleDistance(); render(); });

  /* ----------------------------------------------------------- pricing read */
  function effectiveAddons() {
    var timing = $("bkTiming").value;
    return {
      helper: $("bkHelper").checked,
      furnitureDolly: $("bkFurnitureDolly").checked,
      standardDolly: $("bkStandardDolly").checked,
      rush: timing === "rush",
      overnight: timing === "overnight",
      weekend: isWeekend(effectiveDate())
    };
  }
  function readQuote() {
    var common = {
      addons: effectiveAddons(),
      foamWrapItems: $("bkFoam").value,
      vehicle: $("bkVehicle").value,
      oversized: $("bkOversized").checked,
      outsideTriCounty: false, // out-of-area is handled manually — see the note on the form ("price may vary")
      requestQuote: $("bkRequestQuote").checked
    };
    if (svc === "route") {
      return MQ.routeQuote(Object.assign({ stops: $("bkStops").value, farthestMiles: miles || 0, maxWeight: $("bkWeightRoute").value }, common));
    }
    return MQ.singleQuote(Object.assign({ miles: miles || 0, weight: $("bkWeightSingle").value }, common));
  }

  /* ---------------------------------------------------------- render summary */
  function render() {
    var res = readQuote();
    sumSvc.textContent = svc === "route" ? "Route Delivery" : "Single Delivery";
    bookMsg.style.display = "none";

    if (res.custom) {
      linesEl.innerHTML = "";
      totalEl.textContent = "Custom quote";
      customMsg.style.display = "block";
      customMsg.textContent = res.reason + " Submit your details and we'll send a custom price.";
      payBtn.style.display = "none"; quoteBtn.style.display = "";
      return;
    }
    customMsg.style.display = "none";
    quoteBtn.style.display = "none";
    payBtn.style.display = "";

    // Single delivery needs an auto-distance before it can be priced.
    if (svc === "single" && miles == null) {
      linesEl.innerHTML = "";
      totalEl.textContent = "—";
      payBtn.disabled = true;
      return;
    }
    payBtn.disabled = false;
    linesEl.innerHTML = res.lines.map(function (l) {
      return "<div class='quote-line'><span>" + l.label + "</span><span>" + fmt(l.amount) + "</span></div>";
    }).join("");
    totalEl.textContent = fmt(res.total);
  }

  /* ------------------------------------------------- vehicle / availability */
  function setVehNote() {
    var v = P.vehicles.find(function (x) { return x.id === $("bkVehicle").value; });
    $("vehNote").textContent = v ? (v.label + " · up to " + v.dailyCap + " bookings per day") : "";
  }
  function checkAvailability() {
    rolledDate = null;
    if (!CFG.availabilityEndpoint) { availMsg.style.display = "none"; return; }
    var vehicle = $("bkVehicle").value, date = effectiveDate();
    fetch(CFG.availabilityEndpoint + "?vehicle=" + encodeURIComponent(vehicle) + "&date=" + encodeURIComponent(date))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.full) {
          rolledDate = d.nextDate;
          availMsg.className = "book-result info"; availMsg.style.display = "block";
          availMsg.textContent = "Bookings are full for " + humanDate(date) + " on " + vehLabel(vehicle) +
            ". Your delivery will be scheduled for the next available day (" + humanDate(d.nextDate) + ").";
        } else { availMsg.style.display = "none"; }
      })
      .catch(function () { availMsg.style.display = "none"; });
  }

  /* ----------------------------------------------------------- validation */
  function validate() {
    var miss = [];
    if (!$("custName").value.trim()) miss.push("name");
    if (!$("custPhone").value.trim()) miss.push("phone");
    if (!$("custEmail").value.trim()) miss.push("email");
    if (!$("pickupAddress").value.trim()) miss.push("pickup address");
    if (svc === "single" && !$("dropoffAddress").value.trim()) miss.push("delivery address");
    return miss;
  }
  function leadOk() {
    if ($("bkTiming").value !== "scheduled") return { ok: true };
    if (!$("bkDate").value) return { ok: false, msg: "Please choose a delivery date." };
    var lead = (P.dispatchLeadMinutes || 30) * 60000;
    var dt = new Date($("bkDate").value + "T" + ($("bkTime").value || "12:00"));
    if (dt.getTime() < Date.now() + lead) return { ok: false, msg: "Please choose a time at least " + (P.dispatchLeadMinutes || 30) + " minutes from now." };
    return { ok: true };
  }

  function showMsg(el, cls, text) { el.className = "book-result " + cls; el.textContent = text; el.style.display = "block"; }

  /* ---------------------------------------------------------- collect order */
  function collectOrder(res) {
    var stops = [];
    if (svc === "route") stopsList.querySelectorAll("input").forEach(function (inp) { stops.push(inp.value.trim()); });
    var timing = $("bkTiming").value;
    var photo = $("bkPhoto").files && $("bkPhoto").files[0];
    return {
      serviceType: svc === "route" ? "Route Delivery" : "Single Delivery",
      timing: timing,
      customer: { name: $("custName").value.trim(), phone: $("custPhone").value.trim(), email: $("custEmail").value.trim() },
      pickupAddress: $("pickupAddress").value.trim(),
      deliveryAddress: svc === "single" ? $("dropoffAddress").value.trim() : null,
      stops: svc === "route" ? stops : null,
      numberOfStops: svc === "route" ? (parseInt($("bkStops").value, 10) || stops.length) : null,
      miles: miles || 0,
      distanceSource: distSource,
      weight: svc === "single" ? (Number($("bkWeightSingle").value) || 0) : (Number($("bkWeightRoute").value) || 0),
      vehicle: $("bkVehicle").value,
      outsideTriCounty: false, // out-of-area is handled manually — see the note on the form ("price may vary")
      requestedDate: effectiveDate(),
      date: timing === "scheduled" ? $("bkDate").value : "",
      time: timing === "scheduled" ? $("bkTime").value : "",
      addons: effectiveAddons(),
      foamWrapItems: parseInt($("bkFoam").value, 10) || 0,
      photoName: photo ? photo.name : "",
      instructions: $("bkNotes").value.trim(),
      breakdown: res.lines, total: res.total, currency: "usd"
    };
  }

  /* ---------------------------------------------------------------- PAY */
  payBtn.addEventListener("click", function () {
    var miss = validate();
    if (miss.length) { showMsg(bookMsg, "info", "Please fill in: " + miss.join(", ") + "."); return; }
    if (svc === "single" && miles == null) { showMsg(bookMsg, "info", "We're still calculating the distance — please wait a moment or recheck the addresses."); return; }
    var lead = leadOk();
    if (!lead.ok) { showMsg(bookMsg, "info", lead.msg); return; }

    var res = readQuote();
    if (res.custom) return;
    var order = collectOrder(res);

    if (!CFG.checkoutEndpoint || !CFG.stripePublishableKey) {
      var roll = rolledDate ? " (scheduled for " + humanDate(rolledDate) + " — chosen day is full)" : "";
      showMsg(bookMsg, "ok",
        "✓ Order ready — " + fmt(order.total) + " for " + order.serviceType + roll + ". " +
        "Live card payment activates once the Stripe keys + backend are connected (see README). " +
        "Service is dispatched once payment is received. For help, email dispatch@mclogistics.delivery.");
      payBtn.disabled = true; payBtn.textContent = "Order captured ✓";
      return;
    }

    payBtn.disabled = true; payBtn.textContent = "Redirecting to secure checkout…";
    fetch(CFG.checkoutEndpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.url) { window.location.href = data.url; return; }
        if (data.id && window.Stripe) { return window.Stripe(CFG.stripePublishableKey).redirectToCheckout({ sessionId: data.id }); }
        throw new Error(data.error || "Could not start checkout.");
      })
      .catch(function (err) {
        payBtn.disabled = false; payBtn.innerHTML = "Pay Securely with Stripe";
        showMsg(bookMsg, "info", "Checkout error: " + err.message + " — please email dispatch@mclogistics.delivery.");
      });
  });

  /* ----------------------------------------------------- custom quote request */
  quoteBtn.addEventListener("click", function () {
    var miss = validate();
    if (miss.length) { showMsg(bookMsg, "info", "Please fill in: " + miss.join(", ") + "."); return; }
    var order = collectOrder({ lines: [], total: null });
    order.requestType = "Custom Quote";

    var done = function () {
      showMsg(bookMsg, "ok", "✓ Your request has been submitted. M&C Logistics will review your delivery details and contact you with a custom quote.");
      quoteBtn.disabled = true; quoteBtn.textContent = "Request submitted ✓";
    };
    if (CFG.quoteEndpoint) {
      fetch(CFG.quoteEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) })
        .then(done).catch(done);
    } else { done(); }
  });

  /* ---------------------------------------------------------------- wiring */
  $("pickupAddress").addEventListener("input", function () { lastKey = ""; scheduleDistance(); });
  $("dropoffAddress").addEventListener("input", function () { lastKey = ""; scheduleDistance(); });

  $("bkTiming").addEventListener("change", function () {
    $("schedRow").style.display = this.value === "scheduled" ? "" : "none";
    checkAvailability(); render();
  });
  $("bkDate").addEventListener("change", function () { checkAvailability(); render(); });
  $("bkVehicle").addEventListener("change", function () { setVehNote(); checkAvailability(); render(); });

  // generic recompute for the remaining option controls
  form.addEventListener("input", render);
  form.addEventListener("change", render);

  /* ------------------------------------------------------------------- init */
  $("bkDate").min = localISO();
  buildStops();
  setVehNote();
  checkAvailability();
  scheduleDistance();
  render();
})();
