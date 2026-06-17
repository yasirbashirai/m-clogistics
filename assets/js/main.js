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

  /* ==========================================================================
     EMAIL DELIVERY — Web3Forms
     Every website form (contact, careers, custom-quote requests) is emailed to
     dispatch@mclogistics.delivery through Web3Forms. No SMTP / server setup.

     >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
     ONE-TIME SETUP: paste your free access key on the line below.
       1. Go to https://web3forms.com
       2. Enter  dispatch@mclogistics.delivery  and create an access key
       3. Open that inbox, copy the key you receive, and paste it between the
          quotes below (replace PASTE-YOUR-WEB3FORMS-ACCESS-KEY-HERE).
     Until a real key is in place, forms show an honest error (no silent fail).
     >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  */
  var WEB3FORMS_KEY = "3872c1bc-5549-4471-b600-cfcbee00bf5e";

  // Shared sender used by every form on the site. Returns a promise that
  // resolves on confirmed delivery and REJECTS on any failure (so the UI can
  // show a truthful message instead of a fake "thank you").
  window.MCForms = {
    key: WEB3FORMS_KEY,
    ready: function () { return /^[0-9a-f-]{16,}$/i.test(WEB3FORMS_KEY); },
    send: function (fields, subject) {
      var body = {
        access_key: WEB3FORMS_KEY,
        subject: subject || "New website submission — M&C Logistics",
        from_name: "M&C Logistics Website"
      };
      Object.keys(fields || {}).forEach(function (k) {
        if (fields[k] != null && fields[k] !== "") body[k] = fields[k];
      });
      if (fields && fields.email) body.replyto = fields.email;
      return fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.success) throw new Error((d && d.message) || "Submission failed");
        return d;
      });
    }
  };

  // ---- Contact form → emails dispatch@ via Web3Forms (+ best-effort admin save) ----
  document.querySelectorAll("form[data-demo-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var get = function (sel) { var el = form.querySelector(sel); return el ? el.value.trim() : ""; };
      var payload = {
        name: get('[name="name"]'), email: get('[name="email"]'),
        phone: get('[name="phone"]'), message: get('[name="message"]')
      };
      var note = form.querySelector("[data-form-note]");
      var setNote = function (txt, ok) {
        if (!note) return;
        note.style.display = "block";
        note.textContent = txt;
        note.style.color = ok ? "" : "#b00020";
      };
      var btn = form.querySelector('[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

      // Keep a copy in the admin dashboard (best-effort; does not block email).
      var endpoint = (window.MC_CONFIG && window.MC_CONFIG.contactEndpoint) || "/api/contact";
      fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(function () {});

      window.MCForms.send(payload, "New contact message — " + (payload.name || "Website"))
        .then(function () {
          setNote("✓ Thanks, " + (payload.name || "there") + "! Your message has been received — we'll reach out shortly.", true);
          form.reset();
        })
        .catch(function () {
          setNote("⚠ Sorry — your message couldn't be sent just now. Please call (954) 203-2335 or email dispatch@mclogistics.delivery.", false);
        })
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = "Send Message"; } });
    });
  });
})();
