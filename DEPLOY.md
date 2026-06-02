# Deploying M&C Logistics to Vercel (+ GitHub)

The site (static HTML/CSS/JS) **and** the checkout/admin backend (`/api` serverless
functions) deploy together to Vercel from one GitHub repo. No separate server to run.

You can deploy **right now** with no keys — it goes live in demo mode — and add Stripe /
database / email / Shipday keys later, each as a Vercel Environment Variable.

---

## 1. Push to GitHub

The repo is already git-initialised and committed (branch `main`).

```bash
cd "Claude code 2026/mc-logistics"
# create an empty repo on github.com first (e.g. mc-logistics), then:
git remote add origin https://github.com/<your-username>/mc-logistics.git
git push -u origin main
```

## 2. Import to Vercel

1. Go to **vercel.com → Add New → Project → Import** your `mc-logistics` repo.
2. Framework preset: **Other** (leave build settings empty — it's static + `/api`).
3. Click **Deploy**. In ~1 minute you get a live URL like `mc-logistics.vercel.app`.
4. Later, add your domain: **Project → Settings → Domains → `mclogistics.delivery`**.

That's it — the whole site, the booking calculator, and the `/api` endpoints are live.
The booking form stays in safe **demo mode** until you add the Stripe keys below.

## 3. Environment Variables (Vercel → Project → Settings → Environment Variables)

Add these when you're ready (re-deploy after adding). All optional to start:

| Variable | What it does |
|---|---|
| `ADMIN_TOKEN` | Password for the **admin dashboard** (`/admin.html`). Set this first. |
| `STRIPE_SECRET_KEY` | `sk_live_…` — enables real card charges. |
| `SITE_ORIGIN` | `https://mclogistics.delivery` (used for Stripe success/cancel URLs). |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | **Persistent orders** (see §5). Without these, orders are in-memory only and reset. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | Order + confirmation emails to dispatch@ and the customer. |
| `SHIPDAY_API_KEY` | Auto-create the delivery in Shipday after payment. |
| `GOOGLE_MAPS_API_KEY` | (Optional) used by pricing in the future for server-side mileage. |

## 4. Turn on Stripe payments

1. Stripe Dashboard → **Developers → API keys** → copy the **Secret key** (`sk_…`).
2. Add it as `STRIPE_SECRET_KEY` in Vercel (step 3) and redeploy.
3. In **`booking.html`**, set the **publishable** key (safe for the browser):
   ```js
   window.MC_CONFIG = {
     stripePublishableKey: "pk_live_…",
     checkoutEndpoint: "/api/create-checkout-session",
     quoteEndpoint: "/api/quote-request"
   };
   ```
   Commit + push (Vercel auto-redeploys).
4. **Webhook:** Stripe → Developers → Webhooks → Add endpoint
   `https://<your-domain>/api/webhook`, event `checkout.session.completed`.
   (We verify the payment by re-fetching the session server-side, so it's secure on Vercel.)

Flow: booking form → `/api/create-checkout-session` → Stripe-hosted payment →
`/api/webhook` → email dispatch + Shipday + order marked paid in the admin dashboard.

## 5. Persistent orders (recommended) — free Upstash Redis

Vercel functions are stateless, so without a database the admin dashboard's orders reset.
Fix in 2 minutes, free:

1. Vercel → **Storage → Create → Upstash Redis** (or upstash.com). Connect it to the project.
2. It auto-adds `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. Redeploy.

Now every paid booking is stored and appears in the admin dashboard permanently.

## 6. Admin dashboard

Open `https://<your-domain>/admin.html`, leave **Backend URL blank** (same site), enter your
`ADMIN_TOKEN`, sign in. Manage every order's status (`paid → assigned → picked_up →
in_transit → delivered`) — which drives the public tracker at
`/service-area.html?code=MC-XXXXXX`.

## Local development

```bash
npm i -g vercel
cd "Claude code 2026/mc-logistics"
vercel dev        # serves the site + /api functions at http://localhost:3000
```
(Or use the standalone Express version in `/server` — see README — for a non-Vercel host.)
