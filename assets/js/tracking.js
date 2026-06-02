/* ==========================================================================
   M&C Logistics — Live Tracking
   Demo tracking engine. Any tracking number resolves to a plausible, animated
   delivery status (deterministic from the number, so the same code is stable).
   Drives: status timeline, ETA countdown, progress bar, animated driver on map.
   No backend required — ready to swap for a real dispatch API later.
   ========================================================================== */
(function () {
  "use strict";

  var form = document.getElementById("trkForm");
  if (!form) return;

  var input   = document.getElementById("trkInput");
  var result  = document.getElementById("trkResult");
  var empty   = document.getElementById("trkEmpty");
  var codeOut = document.getElementById("trkCode");
  var etaOut  = document.getElementById("trkEta");
  var barFill = document.getElementById("trkBar");
  var steps   = document.querySelectorAll("#trkSteps .trk-step");
  var fromOut = document.getElementById("trkFrom");
  var toOut   = document.getElementById("trkTo");
  var driverOut = document.getElementById("trkDriver");
  var statusPill = document.getElementById("trkStatusPill");

  var STAGES = [
    { key: "ordered",  label: "Order Received" },
    { key: "pickup",   label: "Picked Up" },
    { key: "transit",  label: "In Transit" },
    { key: "out",      label: "Out for Delivery" },
    { key: "done",     label: "Delivered" }
  ];

  var ROUTES = [
    { from: "Miami, FL",            to: "Fort Lauderdale, FL",   path: [[25.7617,-80.1918],[25.94,-80.18],[26.12,-80.15],[26.1224,-80.1373]] },
    { from: "Hialeah, FL",          to: "Boca Raton, FL",        path: [[25.8576,-80.2781],[26.05,-80.22],[26.30,-80.14],[26.3683,-80.1289]] },
    { from: "Pembroke Pines, FL",   to: "West Palm Beach, FL",   path: [[26.0078,-80.2963],[26.30,-80.20],[26.55,-80.10],[26.7153,-80.0534]] },
    { from: "Doral, FL",            to: "Pompano Beach, FL",     path: [[25.8195,-80.3553],[26.05,-80.25],[26.20,-80.13],[26.2379,-80.1248]] },
    { from: "Kendall, FL",          to: "Sunrise, FL",           path: [[25.6793,-80.3173],[25.95,-80.27],[26.10,-80.25],[26.1669,-80.2564]] }
  ];

  var DRIVERS = ["Marco R.", "Luis T.", "Andre P.", "Sofia M.", "Devon K."];

  // Simple deterministic hash so the same code always shows the same status
  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return h;
  }

  var mapState = null;

  function render(code) {
    var clean = code.trim().toUpperCase();
    var h = hash(clean);
    var stageIdx = h % STAGES.length;           // 0..4
    var route = ROUTES[h % ROUTES.length];
    var driver = DRIVERS[(h >> 3) % DRIVERS.length];
    var minutes = stageIdx >= STAGES.length - 1 ? 0 : (8 + (h % 34)); // ETA mins

    empty.style.display = "none";
    result.style.display = "block";

    codeOut.textContent = clean;
    fromOut.textContent = route.from;
    toOut.textContent = route.to;
    driverOut.textContent = driver;

    var delivered = stageIdx >= STAGES.length - 1;
    statusPill.textContent = STAGES[stageIdx].label;
    statusPill.className = "trk-pill " + (delivered ? "trk-pill--done" : "trk-pill--live");

    // Timeline
    steps.forEach(function (s, i) {
      s.classList.remove("done", "current");
      if (i < stageIdx) s.classList.add("done");
      else if (i === stageIdx) s.classList.add("current");
    });

    // Progress bar (animate)
    var pct = (stageIdx / (STAGES.length - 1)) * 100;
    barFill.style.width = "0%";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { barFill.style.width = pct + "%"; });
    });

    // ETA countdown
    if (delivered) {
      etaOut.textContent = "Delivered ✓";
    } else {
      startCountdown(minutes);
    }

    // Map with animated driver
    drawMap(route, stageIdx);

    // reveal result
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---- ETA countdown ---- */
  var countTimer = null;
  function startCountdown(mins) {
    if (countTimer) clearInterval(countTimer);
    var total = mins * 60; // seconds
    function tick() {
      var m = Math.floor(total / 60);
      var s = total % 60;
      etaOut.textContent = m + "m " + (s < 10 ? "0" : "") + s + "s";
      if (total <= 0) { clearInterval(countTimer); etaOut.textContent = "Arriving now"; return; }
      total--;
    }
    tick();
    countTimer = setInterval(tick, 1000);
  }

  /* ---- Animated mini-map ---- */
  function drawMap(route, stageIdx) {
    var el = document.getElementById("trk-map");
    if (!el || !window.L) return;

    if (!mapState) {
      var map = L.map("trk-map", { scrollWheelZoom: false, zoomControl: true, attributionControl: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd", maxZoom: 18
      }).addTo(map);
      mapState = { map: map, layers: [] };
    }
    var map = mapState.map;
    mapState.layers.forEach(function (l) { map.removeLayer(l); });
    mapState.layers = [];

    var line = L.polyline(route.path, { color: "#E11D2A", weight: 4, opacity: .85, dashArray: "1,8", lineCap: "round" }).addTo(map);
    mapState.layers.push(line);
    map.fitBounds(line.getBounds().pad(0.25));

    // origin + destination pins
    function pin(latlng, color, label) {
      var m = L.marker(latlng, { icon: L.divIcon({ className: "", iconSize: [16,16], iconAnchor: [8,8],
        html: "<div style='background:" + color + ";width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)'></div>" }) }).addTo(map);
      m.bindTooltip(label, { permanent: false });
      mapState.layers.push(m);
    }
    pin(route.path[0], "#15171a", route.from);
    pin(route.path[route.path.length - 1], "#1f9d55", route.to);

    // driver position along the route based on stage
    var prog = Math.min(stageIdx / (STAGES.length - 1), 1);
    var pos = pointAlong(route.path, prog);
    var truck = L.marker(pos, { icon: L.divIcon({ className: "", iconSize: [34,34], iconAnchor: [17,17],
      html: "<div class='trk-truck'>🚚</div>" }) }).addTo(map);
    truck.bindPopup("<b>" + STAGES[stageIdx].label + "</b>");
    mapState.layers.push(truck);

    // animate driver creeping forward a little (live feel) unless delivered
    if (stageIdx < STAGES.length - 1) {
      var p = prog;
      var anim = setInterval(function () {
        p += 0.004;
        if (p >= Math.min(prog + 0.12, 1)) { clearInterval(anim); return; }
        truck.setLatLng(pointAlong(route.path, p));
      }, 120);
      mapState.layers.push({ removeLayer: function(){}, _anim: anim }); // tracked loosely
    }

    setTimeout(function () { map.invalidateSize(); }, 200);
  }

  // linear interpolation along a multi-point path, t in [0,1]
  function pointAlong(path, t) {
    if (t <= 0) return path[0];
    if (t >= 1) return path[path.length - 1];
    var segs = path.length - 1;
    var f = t * segs;
    var i = Math.floor(f);
    var r = f - i;
    var a = path[i], b = path[i + 1];
    return [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r];
  }

  // If a backend is configured, look up the REAL order status (set via the
  // admin dashboard). Otherwise fall back to the deterministic demo above.
  var TRACK_BASE = (window.MC_CONFIG && window.MC_CONFIG.trackBase) || "";
  var STATUS_STAGE = { paid: 0, assigned: 1, picked_up: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 };

  function renderReal(code) {
    fetch(TRACK_BASE.replace(/\/$/, "") + "/track/" + encodeURIComponent(code.trim().toUpperCase()))
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (o) {
        var idx = STATUS_STAGE[o.status] != null ? STATUS_STAGE[o.status] : 0;
        empty.style.display = "none"; result.style.display = "block";
        codeOut.textContent = o.code;
        fromOut.textContent = o.from || "—"; toOut.textContent = o.to || "—";
        driverOut.textContent = o.driver || "Assigned at pickup";
        var delivered = o.status === "delivered";
        statusPill.textContent = (o.status || "").replace(/_/g, " ");
        statusPill.className = "trk-pill " + (delivered ? "trk-pill--done" : "trk-pill--live");
        steps.forEach(function (s, i) { s.classList.remove("done", "current"); if (i < idx) s.classList.add("done"); else if (i === idx) s.classList.add("current"); });
        var pct = (idx / (STAGES.length - 1)) * 100;
        barFill.style.width = "0%"; requestAnimationFrame(function () { requestAnimationFrame(function () { barFill.style.width = pct + "%"; }); });
        etaOut.textContent = delivered ? "Delivered ✓" : (o.eta || "On schedule");
        result.scrollIntoView({ behavior: "smooth", block: "nearest" });
      })
      .catch(function () { render(code); });   // fall back to demo on any error
  }
  function lookup(code) { if (TRACK_BASE) renderReal(code); else render(code); }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = input.value.trim();
    if (!v) { input.focus(); return; }
    lookup(v);
  });

  // Sample chips
  document.querySelectorAll("[data-trk-demo]").forEach(function (b) {
    b.addEventListener("click", function () {
      input.value = b.getAttribute("data-trk-demo");
      lookup(input.value);
    });
  });

  // Deep link: service-area.html?code=MC-XXXX (used after Stripe success)
  var qs = new URLSearchParams(window.location.search);
  var dl = qs.get("code") || qs.get("track");
  if (dl) { input.value = dl; lookup(dl); }
})();
