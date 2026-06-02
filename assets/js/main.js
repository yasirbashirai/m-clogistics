/* ==========================================================================
   M&C Logistics — Shared site behavior
   ========================================================================== */
(function () {
  "use strict";

  // ---- Mobile nav toggle ----
  var toggle = document.querySelector(".nav__toggle");
  var links = document.querySelector(".nav__links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      links.classList.toggle("open");
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { links.classList.remove("open"); });
    });
  }

  // ---- Active nav link (matches body[data-page]) ----
  var page = document.body.getAttribute("data-page");
  if (page) {
    document.querySelectorAll(".nav__links a[data-nav]").forEach(function (a) {
      if (a.getAttribute("data-nav") === page) a.classList.add("active");
    });
  }

  // ---- Footer year ----
  var y = document.querySelector("[data-year]");
  if (y) y.textContent = new Date().getFullYear();

  // ---- Scroll reveal (+ staggered groups) ----
  var reveals = document.querySelectorAll(".reveal, .stagger");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  // ---- Contact form → backend (/api/contact); graceful confirmation either way ----
  document.querySelectorAll("form[data-demo-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var get = function (sel) { var el = form.querySelector(sel); return el ? el.value.trim() : ""; };
      var payload = {
        name: get('[name="name"]'), email: get('[name="email"]'),
        phone: get('[name="phone"]'), message: get('[name="message"]')
      };
      var endpoint = (window.MC_CONFIG && window.MC_CONFIG.contactEndpoint) || "/api/contact";
      var note = form.querySelector("[data-form-note]");
      var confirm = function () {
        if (note) {
          note.style.display = "block";
          note.textContent = "✓ Thanks, " + (payload.name || "there") + "! Your message has been received — we'll reach out shortly.";
        }
        form.reset();
      };
      var btn = form.querySelector('[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(confirm).catch(confirm)
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = "Send Message"; } });
    });
  });
})();
