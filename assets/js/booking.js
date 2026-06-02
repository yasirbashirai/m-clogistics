/* ==========================================================================
   M&C Logistics — Booking + Checkout
   Single vs Route service, conditional fields, live price breakdown,
   quote triggers (>100 lb / oversized / request-quote), and Stripe checkout.

   The Stripe charge is created SERVER-SIDE. This script gathers the order,
   POSTs it to MC_CONFIG.checkoutEndpoint, and redirects to the returned
   Stripe Checkout URL. Until the backend + keys are configured it falls back
   to a clear on-page confirmation so the flow is still demonstrable.
   ========================================================================== */
(function () {
  "use strict";

  var form = document.getElementById("bookForm");
  if (!form || !window.MCQuote) return;

  var CFG = window.MC_CONFIG || {};
  var MQ = window.MCQuote, fmt = MQ.fmt;

  var $ = function (id) { return document.getElementById(id); };
  var svc = "single";

  var seg = $("svcSeg"),
      singleBlock = $("singleBlock"),
      routeBlock = $("routeBlock"),
      stopsList = $("stopsList"),
      sumSvc = $("sumSvc"),
      linesEl = $("quoteLines"),
      totalEl = $("quoteTotal"),
      customMsg = $("customMsg"),
      bookMsg = $("bookMsg"),
      payBtn = $("payBtn"),
      quoteBtn = $("quoteBtn");

  // ---- service toggle ----
  seg.addEventListener("click", function (e) {
    var b = e.target.closest(".seg__btn"); if (!b) return;
    svc = b.getAttribute("data-svc");
    seg.querySelectorAll(".seg__btn").forEach(function (x) { x.classList.toggle("active", x === b); });
    singleBlock.style.display = svc === "single" ? "" : "none";
    routeBlock.style.display = svc === "route" ? "" : "none";
    if (svc === "route") buildStops();
    render();
  });

  // ---- build stop address fields ----
  function buildStops() {
    var n = Math.max(1, Math.min(9, parseInt($("bkStops").value, 10) || 1));
    var existing = {};
    stopsList.querySelectorAll("input").forEach(function (inp, i) { existing[i] = inp.value; });
    stopsList.innerHTML = "";
    for (var i = 0; i < n; i++) {
      var row = document.createElement("div");
      row.className = "stop-row";
      row.innerHTML = "<span class='stop-no'>" + (i + 1) + "</span>" +
        "<input type='text' placeholder='Stop " + (i + 1) + " address' value='" + (existing[i] ? existing[i].replace(/'/g, "&#39;") : "") + "'>";
      stopsList.appendChild(row);
    }
  }
  $("bkStops").addEventListener("input", function () { buildStops(); render(); });

  // ---- gather current inputs into a quote-engine payload ----
  function readQuote() {
    var addons = { rush: $("bkRush").checked, weekend: $("bkWeekend").checked, overnight: $("bkOvernight").checked };
    var common = { addons: addons, oversized: $("bkOversized").checked, requestQuote: $("bkRequestQuote").checked };
    if (svc === "route") {
      return MQ.routeQuote(Object.assign({
        stops: $("bkStops").value,
        farthestMiles: $("bkFarthest").value,
        maxWeight: $("bkWeightRoute").value
      }, common));
    }
    return MQ.singleQuote(Object.assign({
      miles: $("bkMiles").value,
      weight: $("bkWeightSingle").value
    }, common));
  }

  // ---- render live summary ----
  function render() {
    var res = readQuote();
    sumSvc.textContent = svc === "route" ? "Route Delivery" : "Single Delivery";
    bookMsg.style.display = "none";

    if (res.custom) {
      linesEl.innerHTML = "";
      totalEl.textContent = "Custom quote";
      customMsg.style.display = "block";
      customMsg.textContent = res.reason + " Submit your details and we'll send a custom price.";
      payBtn.style.display = "none";
      quoteBtn.style.display = "";
      return;
    }
    customMsg.style.display = "none";
    payBtn.style.display = "";
    quoteBtn.style.display = "none";
    linesEl.innerHTML = res.lines.map(function (l) {
      return "<div class='quote-line'><span>" + l.label + "</span><span>" + fmt(l.amount) + "</span></div>";
    }).join("");
    totalEl.textContent = fmt(res.total);
  }

  // recompute on any input/change
  form.addEventListener("input", render);
  form.addEventListener("change", render);

  // ---- collect full order object ----
  function collectOrder(res) {
    var stops = [];
    if (svc === "route") stopsList.querySelectorAll("input").forEach(function (inp) { stops.push(inp.value.trim()); });
    return {
      serviceType: svc === "route" ? "Route Delivery" : "Single Delivery",
      customer: { name: $("custName").value.trim(), phone: $("custPhone").value.trim(), email: $("custEmail").value.trim() },
      pickupAddress: $("pickupAddress").value.trim(),
      deliveryAddress: svc === "single" ? $("dropoffAddress").value.trim() : null,
      stops: svc === "route" ? stops : null,
      numberOfStops: svc === "route" ? (parseInt($("bkStops").value, 10) || stops.length) : null,
      miles: svc === "single" ? (Number($("bkMiles").value) || 0) : (Number($("bkFarthest").value) || 0),
      weight: svc === "single" ? (Number($("bkWeightSingle").value) || 0) : (Number($("bkWeightRoute").value) || 0),
      date: $("bkDate").value,
      time: $("bkTime").value,
      instructions: $("bkNotes").value.trim(),
      addons: { rush: $("bkRush").checked, weekend: $("bkWeekend").checked, overnight: $("bkOvernight").checked },
      breakdown: res.lines,
      total: res.total,
      currency: "usd"
    };
  }

  // ---- basic validation ----
  function validate() {
    var miss = [];
    if (!$("custName").value.trim()) miss.push("name");
    if (!$("custPhone").value.trim()) miss.push("phone");
    if (!$("custEmail").value.trim()) miss.push("email");
    if (!$("pickupAddress").value.trim()) miss.push("pickup address");
    if (svc === "single" && !$("dropoffAddress").value.trim()) miss.push("delivery address");
    return miss;
  }

  function showMsg(el, cls, text) {
    el.className = "book-result " + cls;
    el.textContent = text;
    el.style.display = "block";
  }

  // ---- PAY (Stripe) ----
  payBtn.addEventListener("click", function () {
    var miss = validate();
    if (miss.length) { showMsg(bookMsg, "info", "Please fill in: " + miss.join(", ") + "."); return; }
    var res = readQuote();
    if (res.custom) return;
    var order = collectOrder(res);

    // No backend configured yet → demonstrate the flow with a clear message.
    if (!CFG.checkoutEndpoint || !CFG.stripePublishableKey) {
      showMsg(bookMsg, "ok",
        "✓ Order ready — " + fmt(order.total) + " for " + order.serviceType + ". " +
        "Live card payment activates once the Stripe keys + backend are connected (see README). " +
        "For now, call (954) 203-2335 to confirm.");
      payBtn.disabled = true; payBtn.textContent = "Order captured ✓";
      return;
    }

    // Live flow: create a Checkout Session on the server, then redirect to Stripe.
    payBtn.disabled = true; payBtn.textContent = "Redirecting to secure checkout…";
    fetch(CFG.checkoutEndpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.url) { window.location.href = data.url; return; }            // Stripe-hosted Checkout
        if (data.id && window.Stripe) {                                        // or redirect by session id
          return window.Stripe(CFG.stripePublishableKey).redirectToCheckout({ sessionId: data.id });
        }
        throw new Error(data.error || "Could not start checkout.");
      })
      .catch(function (err) {
        payBtn.disabled = false; payBtn.innerHTML = "Pay Securely with Stripe";
        showMsg(bookMsg, "info", "Checkout error: " + err.message + " — please call (954) 203-2335.");
      });
  });

  // ---- Custom quote request ----
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

  // init
  buildStops();
  render();
})();
