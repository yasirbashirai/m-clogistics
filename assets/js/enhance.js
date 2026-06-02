/* ==========================================================================
   M&C Logistics — Advanced interactions (v2)
   Scroll progress · header state · count-up stats · gallery lightbox ·
   FAQ accordion · interactive Leaflet map · back-to-top
   ========================================================================== */
(function () {
  "use strict";

  /* ---- Scroll progress bar ---- */
  var bar = document.querySelector(".scroll-prog");
  var header = document.querySelector(".header");
  var toTop = document.querySelector(".to-top");
  function onScroll() {
    var h = document.documentElement;
    var scrolled = h.scrollTop;
    var max = h.scrollHeight - h.clientHeight;
    if (bar) bar.style.width = (max > 0 ? (scrolled / max) * 100 : 0) + "%";
    if (header) header.classList.toggle("scrolled", scrolled > 10);
    if (toTop) toTop.classList.toggle("show", scrolled > 600);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (toTop) toTop.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* ---- Count-up stats (triggers when scrolled into view) ---- */
  function countUp(el) {
    var raw = el.getAttribute("data-count");
    var target = parseFloat(raw);
    var suffix = el.getAttribute("data-suffix") || "";
    var prefix = el.getAttribute("data-prefix") || "";
    var dur = 1500, start = null;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = target * eased;
      var out = (target % 1 !== 0) ? val.toFixed(1) : Math.round(val).toLocaleString();
      el.textContent = prefix + out + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  var counters = document.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window && counters.length) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { countUp(e.target); cio.unobserve(e.target); }
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { cio.observe(el); });
  } else {
    counters.forEach(function (el) {
      el.textContent = (el.getAttribute("data-prefix") || "") + el.getAttribute("data-count") + (el.getAttribute("data-suffix") || "");
    });
  }

  /* ---- FAQ accordion ---- */
  document.querySelectorAll(".faq__q").forEach(function (q) {
    q.addEventListener("click", function () {
      var item = q.closest(".faq__item");
      var ans = item.querySelector(".faq__a");
      var isOpen = item.classList.contains("open");
      // close siblings
      var parent = item.parentNode;
      parent.querySelectorAll(".faq__item.open").forEach(function (o) {
        o.classList.remove("open");
        o.querySelector(".faq__a").style.maxHeight = null;
      });
      if (!isOpen) {
        item.classList.add("open");
        ans.style.maxHeight = ans.scrollHeight + "px";
      }
    });
  });

  /* ---- Gallery lightbox ---- */
  var gItems = Array.prototype.slice.call(document.querySelectorAll(".gallery__item"));
  var lb = document.querySelector(".lightbox");
  if (gItems.length && lb) {
    var lbImg = lb.querySelector("img");
    var idx = 0;
    var srcs = gItems.map(function (it) {
      var img = it.querySelector("img");
      return (img.getAttribute("data-full") || img.src);
    });
    function show(i) {
      idx = (i + srcs.length) % srcs.length;
      lbImg.src = srcs[idx];
    }
    gItems.forEach(function (it, i) {
      it.addEventListener("click", function () { show(i); lb.classList.add("open"); });
    });
    lb.querySelector(".lightbox__x").addEventListener("click", function () { lb.classList.remove("open"); });
    lb.querySelector(".lightbox__nav.prev").addEventListener("click", function (e) { e.stopPropagation(); show(idx - 1); });
    lb.querySelector(".lightbox__nav.next").addEventListener("click", function (e) { e.stopPropagation(); show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) lb.classList.remove("open"); });
    document.addEventListener("keydown", function (e) {
      if (!lb.classList.contains("open")) return;
      if (e.key === "Escape") lb.classList.remove("open");
      if (e.key === "ArrowRight") show(idx + 1);
      if (e.key === "ArrowLeft") show(idx - 1);
    });
  }

  /* ---- Interactive Leaflet map — South Florida service area (enhanced) ---- */
  var mapEl = document.getElementById("mc-map");
  if (mapEl && window.L) {
    var HQ = [26.2156, -80.2256]; // North Lauderdale, FL
    var map = L.map("mc-map", { scrollWheelZoom: false, attributionControl: true, zoomControl: true })
      .setView([26.25, -80.25], 9);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: "abcd", maxZoom: 19
    }).addTo(map);
    map.on("click", function () { map.scrollWheelZoom.enable(); });
    map.on("mouseout", function () { map.scrollWheelZoom.disable(); });

    var counties = [
      { name: "Palm Beach County", color: "#2b6cb0", center: [26.65, -80.27], eta: "Same-day · 60–120 min",
        cities: ["West Palm Beach","Boca Raton","Delray Beach","Boynton Beach","Lake Worth","Wellington"],
        pins: [[26.7153,-80.0534],[26.3683,-80.1289],[26.4615,-80.0728],[26.5318,-80.0905]],
        poly: [[26.97,-80.40],[26.97,-80.03],[26.33,-80.03],[26.33,-80.40]] },
      { name: "Broward County", color: "#1f9d55", center: [26.15, -80.23], eta: "Same-day · 30–90 min",
        cities: ["Fort Lauderdale","Hollywood","Pembroke Pines","Sunrise","Pompano Beach","Coral Springs","Davie","Plantation"],
        pins: [[26.1224,-80.1373],[26.0112,-80.1495],[26.0078,-80.2963],[26.1669,-80.2564],[26.2379,-80.1248],[26.2712,-80.2706]],
        poly: [[26.33,-80.40],[26.33,-80.05],[25.96,-80.05],[25.96,-80.40]] },
      { name: "Miami-Dade County", color: "#E11D2A", center: [25.72, -80.30], eta: "Same-day · 45–120 min",
        cities: ["Miami","Hialeah","Miami Gardens","Doral","Kendall","Homestead","Aventura","North Miami"],
        pins: [[25.7617,-80.1918],[25.8576,-80.2781],[25.9420,-80.2456],[25.8195,-80.3553],[25.6793,-80.3173],[25.4687,-80.4776]],
        poly: [[25.96,-80.50],[25.96,-80.12],[25.40,-80.12],[25.40,-80.50]] }
    ];

    var polys = {};
    counties.forEach(function (c) {
      // coverage polygon
      var p = L.polygon(c.poly, { color: c.color, weight: 2, fillColor: c.color, fillOpacity: 0.14, className: "mc-county" }).addTo(map);
      polys[c.name] = p;
      var popup = "<b>" + c.name + "</b><span class='pop-cities'>" + c.cities.join(" · ") + "</span><span class='pop-eta'>" + c.eta + "</span>";
      p.bindPopup(popup);
      p.on("mouseover", function () { p.setStyle({ fillOpacity: 0.30, weight: 3 }); });
      p.on("mouseout", function () { p.setStyle({ fillOpacity: 0.14, weight: 2 }); });

      // animated dashed route line HQ -> county center
      var route = L.polyline([HQ, c.center], { color: c.color, weight: 2.5, opacity: .6, dashArray: "2,9", lineCap: "round" }).addTo(map);

      // city pins with pulsing dot
      c.pins.forEach(function (latlng) {
        var icon = L.divIcon({ className: "", iconSize: [16,16], iconAnchor: [8,8], html:
          "<div class='mc-pin'><div class='mc-pin__dot' style='background:" + c.color + "'></div>" +
          "<div class='mc-pin__pulse'><span style='position:absolute;inset:-3px;border-radius:50%;background:" + c.color + ";opacity:.5;animation:pulse 2.4s infinite'></span></div></div>" });
        L.marker(latlng, { icon: icon }).addTo(map).bindPopup("<b>" + c.name + "</b><span class='pop-eta'>" + c.eta + "</span>");
      });
    });

    // coverage radius ring around HQ
    L.circle(HQ, { radius: 42000, color: "#E11D2A", weight: 1.5, opacity: .5, fillColor: "#E11D2A", fillOpacity: .04, dashArray: "4,8" }).addTo(map);

    // HQ marker
    var hq = L.divIcon({ className: "", iconSize: [90, 26], iconAnchor: [45, 13],
      html: "<div class='mc-hq'>★ M&amp;C HQ</div>" });
    L.marker(HQ, { icon: hq, zIndexOffset: 1000 }).addTo(map)
      .bindPopup("<b>M&amp;C Logistics HQ</b><span class='pop-cities'>North Lauderdale, FL 33068</span><span class='pop-eta'>Open 7 days · 7AM–7PM</span>");

    // focus toolbar
    var wrap = mapEl.closest(".map-wrap") || mapEl.parentNode;
    var bar = document.createElement("div");
    bar.className = "map-toolbar";
    bar.innerHTML = "<button class='active' data-focus='all'>All Coverage</button>" +
      counties.map(function (c) { return "<button data-focus='" + c.name + "'>" + c.name.replace(" County","") + "</button>"; }).join("");
    wrap.appendChild(bar);
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      bar.querySelectorAll("button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      var f = b.getAttribute("data-focus");
      if (f === "all") { map.flyTo([26.25, -80.25], 9, { duration: .8 }); }
      else { var pl = polys[f]; if (pl) { map.flyToBounds(pl.getBounds().pad(0.08), { duration: .8 }); pl.openPopup(); } }
    });

    setTimeout(function () { map.invalidateSize(); }, 250);
  }
})();
