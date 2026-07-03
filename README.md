# M&C Logistics — Website

A modern, professional marketing site for **M&C Logistics**, a South Florida same-day
delivery and courier company serving Miami-Dade, Broward, and Palm Beach County.

Built as a fast, dependency-light **static site** (plain HTML, CSS, and vanilla JS) so it
can be hosted anywhere — no build step required.

## ✨ Features

- **Cinematic landing page** with the real M&C courier photography, animated gradient hero,
  floating glass status cards, and scroll-triggered reveal/stagger animations.
- **Live package tracking** (`service-area.html#track`) — enter a tracking number to see a
  status timeline, live ETA countdown, and an animated driver on a Leaflet map.
- **Instant quote calculator** — shared pricing engine (`window.MCQuote`) powering both the
  Pricing page estimator and the chatbot's guided quote flow.
- **Online booking flow** — multi-step stepper with live quote summary (`booking.html`).
- **"Marco" chat assistant** — self-injecting, offline rule-based bot for quotes, services,
  hours, service area, tracking, and booking.
- **Interactive service-area map** — Leaflet map with clickable county coverage polygons.
- Fully **responsive** with a mobile nav, and respects `prefers-reduced-motion`.

## 📂 Structure

```
mc-logistics/
├── index.html            # Landing page
├── services.html         # Services overview
├── booking.html          # Book a Delivery — live quote + Stripe checkout
├── pricing.html          # Redirects to booking.html (pricing is now live on the form)
├── about.html            # About the company
├── service-area.html     # Coverage map + LIVE TRACKING
├── careers.html          # Careers / hiring + application form
├── contact.html          # Contact form + embedded Google Map
├── testimonials.html     # Real customer reviews (assets/testimonials screenshots)
├── admin.html            # Private dispatch dashboard (noindex)
├── server/               # Express API (Stripe, distance, caps, email, Shipday)
│   ├── app.js  pricing.js  store.js  notify.js  shipday.js
└── assets/
    ├── css/styles.css     # Full design system + premium revamp layer
    ├── img/               # Optimized M&C brand photography
    ├── testimonials/      # Real review screenshots used on testimonials.html
    └── js/
        ├── main.js            # Nav, scroll reveal, footer year, form handler
        ├── enhance.js         # Scroll progress, count-up, FAQ, gallery, map
        ├── quote-calculator.js# Shared pricing engine (weight tiers, add-ons, vehicles)
        ├── booking.js         # Booking logic: auto-distance, options, caps, checkout
        ├── tracking.js        # Live tracking engine
        └── chatbot.js         # "Marco" chat assistant
```

## 🚀 Running locally

It's a static site — just open `index.html`, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

Serving over `http://` (rather than `file://`) is recommended so the Leaflet maps and
embedded Google Map load cleanly.

## 💳 Booking & Stripe Checkout

The **Booking** page (the nav "Book a Delivery" item; `pricing.html` now just
redirects here) uses one pricing engine — `assets/js/quote-calculator.js`, mirrored
server-side by `server/pricing.js` (the server never trusts the browser's price).
The customer **never types miles** — distance is calculated automatically from the
addresses, and the **price builds live as options are clicked** (no price table is shown):

| Item | Pricing |
|---|---|
| **Single — Standard (≤100 lb)** | 0–10 mi $39.99 · 11–20 $49.99 · 21–30 $59.99 · 31–40 $69.99 · 41–50 $79.99 · 51–60 $89.99 |
| **Single — Heavy (101–200 lb)** | 0–10 mi $89.99 · 11–20 $99.99 · 21–30 $109.99 · 31–40 $119.99 · 41–50 $129.99 · 51–60 $139.99 |
| **Mileage overage** | every mile **over 60** × $1.50 (single & route) |
| **Route Delivery** | $49.99 base + **$19.00 per stop** + overage on the farthest stop |
| **Add-ons** | Helper +$75 · Furniture dolly +$5 · Standard dolly +$5 · Foam/blanket wrap +$5/item · Rush +$15 · Overnight +$35 · Weekend +$20 (auto on Sat/Sun) |
| **Vehicle** | Car / Compact cargo van / Sprinter van (no surcharge — used for the daily booking caps) |
| **Custom quote** | over **200 lb**, appliance/furniture/oversized, or "Request Quote" → no instant checkout |

**Delivery type** is Same-Day / Rush / Overnight / Scheduled (date picker). Every order
needs **≥30 minutes'** dispatch lead time. **Vehicle daily caps** (Car 25, Compact cargo
van 20, Sprinter van 25) are enforced server-side — a full day rolls to the next available
day with a "bookings are full" note. Service is **dispatched once payment is received**.

The booking form (`booking.html` + `assets/js/booking.js`) supports Single vs Route
(up to 9 stops), shows a live price breakdown, and hands off to **Stripe Checkout**.

### Turning on live payments (needs a backend — secret keys can't live in the browser)

A ready-to-deploy backend is in **`/server`** (Express; adapt to Vercel/Netlify functions
if preferred). It re-computes the price server-side (never trusts the browser), creates the
Stripe Checkout Session, and on payment emails dispatch + creates the Shipday delivery.

1. `cd server && cp .env.example .env` and fill in keys (Stripe, SMTP, optional Google
   Distance Matrix + Shipday). `npm install && npm start`.
2. Point Stripe webhooks at `POST /webhook` (event `checkout.session.completed`).
3. In **`booking.html`**, set `window.MC_CONFIG`:
   ```js
   stripePublishableKey: "pk_live_…",
   checkoutEndpoint: "https://your-backend/create-checkout-session",
   quoteEndpoint:    "https://your-backend/quote-request"
   ```
Until those are set, the booking form runs in **demo mode** — it shows the exact order +
total and tells the customer to call, instead of charging a card.

### Mileage (automatic)
The customer never types miles. The booking page calls **`POST /api/distance`** as soon as
both addresses are entered. With `GOOGLE_MAPS_API_KEY` set, the server uses the Google
**Distance Matrix API** (authoritative). Without a key it falls back to a keyless geocode
(OpenStreetMap/Nominatim) + haversine estimate (×1.3 road factor) so the flow still works in
demo. If the backend isn't reachable at all (pure static hosting), the browser does the same
keyless geocode itself. Add a Google key for production accuracy.

### Vehicle daily caps
**`GET /api/availability?vehicle=&date=`** reports whether a day is full for a vehicle type
and the next open day. On checkout the server re-checks authoritatively and rolls a full day
to the next available date (Car 25/day, Compact cargo van 20/day, Sprinter van 25/day —
editable in the admin **Services & Pricing** tab).

### Email notifications
On a paid order the webhook emails the **dispatch list** (`dispatch@mclogistics.delivery`,
`info@mclogistics.delivery`) and a confirmation to the customer (`server/notify.js`,
via nodemailer). Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM`. Until set, it no-ops cleanly.

### Shipday
Set `SHIPDAY_API_KEY` and every paid order auto-creates a Shipday delivery (`server/shipday.js`:
customer, pickup, drop-off/stops, date/time, weight, instructions, total, Stripe ID) for
dispatch + tracking. Until set, it no-ops cleanly.

> **Note on WordPress:** the original brief targets the WordPress site. This repo implements
> the same system natively. To do it inside WordPress instead, replicate the pricing table
> in Fluent Forms Pro calculation fields and use the same `/server` endpoints (or a
> Zapier/Make webhook) for Stripe → email → Shipday.

## 🛠️ Dispatch Admin Dashboard

`admin.html` is a private dashboard (not linked in the site nav, `noindex`) to manage every
booking and its tracking status.

- Open `admin.html`, enter your **backend URL** + **ADMIN_TOKEN**, sign in (stored locally).
- See summary stats (orders, paid, in-transit, delivered, revenue).
- Every **paid** booking appears automatically with customer, route, weight, total, Stripe ID.
- Change an order's **status** (`paid → assigned → picked_up → in_transit → delivered`) from
  the dropdown — this drives the public tracking page.
- Search + filter by status.

Backend endpoints powering it (in `/server`):
`GET /admin/orders`, `PATCH /admin/orders/:id` (both require header `x-admin-token`),
and public `GET /track/:code`.

### Live tracking
Each paid order gets a tracking code (e.g. `MC-7F3K92`) and the Stripe success page links to
`service-area.html?code=MC-7F3K92`. To show **real** status there (instead of the demo),
set `window.MC_CONFIG.trackBase` in `service-area.html` to your backend URL. The tracking
widget then reads the status you set in the admin dashboard; with no backend it stays in demo
mode. (Shipday can also own tracking end-to-end — see below.)

## 🔌 Connecting the payment gateway (Stripe)

1. **Get keys** — Stripe Dashboard → Developers → API keys. Copy the **Secret key**
   (`sk_…`, backend only) and **Publishable key** (`pk_…`, safe for the browser).
2. **Deploy `/server`** (Render, Railway, Fly, a VPS, etc.) with the `.env` filled in
   (`STRIPE_SECRET_KEY`, `SITE_ORIGIN`, `ADMIN_TOKEN`, SMTP, optional Google/Shipday).
3. **Add the webhook** — Stripe Dashboard → Developers → Webhooks → endpoint
   `https://your-backend/webhook`, event `checkout.session.completed`; put the signing secret
   in `STRIPE_WEBHOOK_SECRET`.
4. **Point the site at it** — in `booking.html` set:
   ```js
   window.MC_CONFIG = {
     stripePublishableKey: "pk_live_…",
     checkoutEndpoint: "https://your-backend/create-checkout-session",
     quoteEndpoint:    "https://your-backend/quote-request"
   };
   ```
That's the whole gateway link: browser → your endpoint (creates a Checkout Session) →
Stripe-hosted payment page → webhook → email + Shipday + admin dashboard. The card data
never touches your site (Stripe-hosted), so you stay PCI-light.

> Other gateways (PayPal, Square, Authorize.net) can be added the same way — add a sibling
> endpoint in `/server` that creates that provider's checkout and a matching `MC_CONFIG`
> entry. The pricing engine (`server/pricing.js`) stays identical.

## 🔎 SEO

Every page includes a unique title + meta description, canonical URL, Open Graph and
Twitter Card tags, and **JSON-LD `LocalBusiness` structured data** (name, phones, address,
area served, opening hours). A `sitemap.xml` and `robots.txt` are included.

> ⚠️ The canonical/OG/sitemap URLs use the placeholder domain
> `https://mclogistics.delivery`. **Find-and-replace it with your real domain** before
> going live (it appears in each page's `<head>`, `sitemap.xml`, and `robots.txt`).

## 📞 Business details

- **Phone:** (954) 203-2335 · (954) 544-0359
- **Email:** info@mclogistics.delivery
- **Area:** North Lauderdale, FL 33068 — serving Miami-Dade, Broward & Palm Beach County

## 🎨 Brand

Red `#E11D2A` / charcoal `#15171a` / white. Headings in **Sora**, body in **Inter**.

> Note: The tracking, booking, quote, and chatbot flows are fully functional front-end
> demos with no backend. They're structured so the demo data can be swapped for a real
> dispatch/pricing API later.
