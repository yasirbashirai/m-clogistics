/* ==========================================================================
   M&C Logistics — Smart rule-based chat assistant ("Marco")
   Self-injecting widget. No API keys, no backend, works offline.
   Answers FAQs, gives instant quotes, routes to call/book.
   ========================================================================== */
(function () {
  "use strict";

  var BIZ = {
    phone1: "(954) 203-2335",
    phone2: "(954) 544-0359",
    email: "info@mclogistics.delivery",
    hours: "Open 7 Days a Week · 7:00 AM–7:00 PM",
    area: "Miami-Dade, Broward & Palm Beach County"
  };

  // ---- Inject widget ----
  var wrap = document.createElement("div");
  wrap.innerHTML = [
    '<button class="cb-launch" id="cbLaunch" aria-label="Open chat">',
      '<span class="cb-badge">1</span>',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    '</button>',
    '<div class="cb-panel" id="cbPanel" role="dialog" aria-label="Chat assistant">',
      '<div class="cb-head">',
        '<div class="av">M</div>',
        '<div><b>Marco · M&amp;C Assistant</b><small><span class="dot"></span> Typically replies instantly</small></div>',
        '<button id="cbClose" aria-label="Close chat">&times;</button>',
      '</div>',
      '<div class="cb-body" id="cbBody"></div>',
      '<div class="cb-quick" id="cbQuick"></div>',
      '<form class="cb-input" id="cbForm">',
        '<input type="text" id="cbText" placeholder="Type your message…" autocomplete="off">',
        '<button type="submit" aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>',
      '</form>',
    '</div>'
  ].join("");
  document.body.appendChild(wrap);

  var launch = document.getElementById("cbLaunch");
  var panel  = document.getElementById("cbPanel");
  var close  = document.getElementById("cbClose");
  var body   = document.getElementById("cbBody");
  var quick  = document.getElementById("cbQuick");
  var form   = document.getElementById("cbForm");
  var text   = document.getElementById("cbText");
  var badge  = launch.querySelector(".cb-badge");
  var greeted = false;

  // ---- Quote mini-flow state ----
  var flow = null; // {step, data}

  function open() {
    panel.classList.add("open");
    badge.style.display = "none";
    text.focus();
    if (!greeted) { greeted = true; greet(); }
  }
  function closePanel() { panel.classList.remove("open"); }

  launch.addEventListener("click", function () {
    panel.classList.contains("open") ? closePanel() : open();
  });
  close.addEventListener("click", closePanel);

  function scroll() { body.scrollTop = body.scrollHeight; }

  function addMsg(t, who) {
    var d = document.createElement("div");
    d.className = "cb-msg " + (who || "bot");
    d.innerHTML = t;
    body.appendChild(d);
    scroll();
  }

  function typing(cb) {
    var t = document.createElement("div");
    t.className = "cb-typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(t); scroll();
    setTimeout(function () { t.remove(); cb(); }, 600);
  }

  function botSay(t) { typing(function () { addMsg(t, "bot"); }); }

  function setChips(arr) {
    quick.innerHTML = "";
    (arr || []).forEach(function (c) {
      var b = document.createElement("button");
      b.className = "cb-chip";
      b.textContent = c;
      b.addEventListener("click", function () { handle(c); });
      quick.appendChild(b);
    });
  }

  var DEFAULT_CHIPS = ["Get a quote", "Services", "Service area", "Hours", "Book a delivery"];

  function greet() {
    addMsg("👋 Hi, I'm <b>Marco</b>, the M&amp;C Logistics assistant. I can give you an <b>instant quote</b>, check our service area, or help you book. How can I help?", "bot");
    setChips(DEFAULT_CHIPS);
  }

  // ---- Intent matching ----
  function handle(raw) {
    var msg = (raw || "").trim();
    if (!msg) return;
    addMsg(msg, "user");
    text.value = "";

    // Active quote flow?
    if (flow) { return quoteFlow(msg); }

    var q = msg.toLowerCase();

    if (/quote|price|cost|how much|estimate|rate/.test(q)) return startQuote();
    if (/book|order|schedule|delivery now|pickup/.test(q)) {
      botSay("Great — you can book a delivery up to 200 lb in under a minute and pay online. 🚚<br><a href='booking.html' style='color:#E11D2A;font-weight:700'>Open the booking page →</a><br><br>Or call us and we'll set it up: <b>" + BIZ.phone1 + "</b>.");
      setChips(DEFAULT_CHIPS); return;
    }
    if (/service|deliver|courier|what do you/.test(q)) {
      botSay("We handle: <br>• Same-Day Delivery<br>• Medical Courier<br>• Legal Document Delivery<br>• Appliance Delivery &amp; Haul Away<br>• Tire Delivery<br>• Restaurant &amp; Catering<br>• Event Staffing<br>• Routed Business Deliveries<br><br><a href='services.html' style='color:#E11D2A;font-weight:700'>See all services →</a>");
      setChips(["Get a quote", "Pricing", "Book a delivery"]); return;
    }
    if (/area|where|location|county|miami|broward|palm|cover|serve/.test(q)) {
      botSay("We proudly serve <b>" + BIZ.area + "</b> — including Fort Lauderdale, Miami, Hollywood, Pembroke Pines, Boca Raton, West Palm Beach and surrounding areas.<br><br><a href='service-area.html' style='color:#E11D2A;font-weight:700'>View service area →</a>");
      setChips(DEFAULT_CHIPS); return;
    }
    if (/hour|open|time|when|close/.test(q)) {
      botSay("🕖 Our hours:<br>" + BIZ.hours + "<br><br>Need something urgent? Call <b>" + BIZ.phone1 + "</b>.");
      setChips(DEFAULT_CHIPS); return;
    }
    if (/pricing|how.*charge|fee/.test(q)) {
      botSay("Pricing starts at <b>$25</b> for small packages. Rush +$15, Weekend +$20. Oversized/appliance = custom quote.<br><br><a href='pricing.html' style='color:#E11D2A;font-weight:700'>Full pricing →</a>");
      setChips(["Get a quote", "Book a delivery"]); return;
    }
    if (/call|phone|number|contact|talk|human|agent|speak/.test(q)) {
      botSay("📞 Call us anytime:<br><b>" + BIZ.phone1 + "</b><br><b>" + BIZ.phone2 + "</b><br>✉️ " + BIZ.email + "<br><br><a href='contact.html' style='color:#E11D2A;font-weight:700'>Contact page →</a>");
      setChips(DEFAULT_CHIPS); return;
    }
    if (/business|account|recurring|route|contract|company/.test(q)) {
      botSay("We set up <b>business delivery accounts</b> with recurring daily/weekly routes for medical offices, restaurants, tire shops, retailers, law firms and more.<br><br>Call <b>" + BIZ.phone1 + "</b> or <a href='contact.html' style='color:#E11D2A;font-weight:700'>contact us</a> to set one up.");
      setChips(DEFAULT_CHIPS); return;
    }
    if (/track|where.*package|status/.test(q)) {
      botSay("📍 You can track your delivery live — see status, ETA and your driver on the map:<br><a href='service-area.html#track' style='color:#E11D2A;font-weight:700'>Track your package →</a><br><br>Or call <b>" + BIZ.phone1 + "</b> and we'll give you an update.");
      setChips(["Track a package", "Book a delivery", "Get a quote"]); return;
    }
    if (/^track a package$/i.test(msg)) { window.location.href = "service-area.html#track"; return; }
    if (/^(hi|hey|hello|yo|hiya)/.test(q)) {
      botSay("Hey! 👋 Want an instant quote or help booking a delivery?");
      setChips(DEFAULT_CHIPS); return;
    }
    if (/thank|thanks|cheers|great|awesome/.test(q)) {
      botSay("You're welcome! Anything else I can help with? 🚚");
      setChips(DEFAULT_CHIPS); return;
    }

    // Fallback
    botSay("I can help with <b>quotes</b>, <b>services</b>, <b>service area</b>, <b>hours</b>, and <b>booking</b>. For anything else, call us at <b>" + BIZ.phone1 + "</b>. What would you like?");
    setChips(DEFAULT_CHIPS);
  }

  // ---- Guided quote flow ----
  function startQuote() {
    flow = { step: "service", data: {} };
    botSay("Let's get you a quick estimate. 💬 First — what type of delivery?");
    setChips(["Same-Day", "Medical Courier", "Legal Documents", "Tire Delivery", "Appliance / Haul Away"]);
  }

  function quoteFlow(input) {
    var q = input.toLowerCase();
    if (flow.step === "service") {
      var map = { "same": "same-day", "medical": "medical", "legal": "legal", "document": "legal", "tire": "tire", "appliance": "appliance", "haul": "appliance", "routed": "routed", "event": "event" };
      var svc = "same-day";
      for (var k in map) { if (q.indexOf(k) > -1) { svc = map[k]; break; } }
      flow.data.service = svc;
      flow.step = "weight";
      botSay("Got it. About how much does it weigh?");
      setChips(["Under 25 lb", "25–50 lb", "50–100 lb", "Over 100 lb"]);
      return;
    }
    if (flow.step === "weight") {
      var w = 20;
      if (/over 100|over100|more than 100|heavy/.test(q)) w = 150;
      else if (/50|75|100/.test(q)) w = 90;
      else if (/25|50/.test(q)) w = 40;
      var num = q.match(/\d+/); if (num) w = Number(num[0]);
      flow.data.weight = w;
      flow.step = "zone";
      botSay("And roughly how far? 📍");
      setChips(["Within one county", "County to county", "Long distance"]);
      return;
    }
    if (flow.step === "zone") {
      var zone = "same";
      if (/county to county|cross|another county/.test(q)) zone = "cross";
      else if (/long|far|distance|extended/.test(q)) zone = "far";
      flow.data.zone = zone;
      flow.step = "rush";
      botSay("Do you need <b>rush</b> service (fastest available)?");
      setChips(["Standard", "Rush (+$15)"]);
      return;
    }
    if (flow.step === "rush") {
      flow.data.rush = /rush|yes|asap|fast/.test(q);
      // Finalize
      var result = window.MCQuote.quote(flow.data);
      flow = null;
      if (result.custom) {
        botSay("For this one I'll get you a <b>custom quote</b> — " + result.reason + "<br><br>Call <b>" + BIZ.phone1 + "</b> or <a href='contact.html' style='color:#E11D2A;font-weight:700'>request a quote here →</a> and we'll price it fast.");
        setChips(DEFAULT_CHIPS);
        return;
      }
      var html = "Here's your estimate for <b>" + result.service + "</b>:<br>";
      result.lines.forEach(function (l) { html += "• " + l.label + ": $" + l.amount + "<br>"; });
      html += "<br><b style='font-size:1.15em;color:#E11D2A'>Estimated total: $" + result.total + "</b><br><br>Ready to lock it in?<br><a href='booking.html' style='color:#E11D2A;font-weight:700'>Book &amp; pay online →</a>";
      botSay(html);
      setChips(["Book a delivery", "Call now", "Start over"]);
      return;
    }
  }

  // Special chip routing
  var origHandle = handle;
  handle = function (raw) {
    if (raw === "Start over") { flow = null; addMsg(raw, "user"); botSay("No problem — what can I help with?"); setChips(DEFAULT_CHIPS); return; }
    if (raw === "Call now") { addMsg(raw, "user"); botSay("📞 <b>" + BIZ.phone1 + "</b> &nbsp;or&nbsp; <b>" + BIZ.phone2 + "</b>"); setChips(DEFAULT_CHIPS); return; }
    return origHandle(raw);
  };

  form.addEventListener("submit", function (e) { e.preventDefault(); handle(text.value); });
})();
