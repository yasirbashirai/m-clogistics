/* ==========================================================================
   M&C Logistics — unified data store (collections + config)
   Backends, auto-selected:
     • Upstash Redis (REST) if UPSTASH_REDIS_REST_URL/_TOKEN set  → persists everywhere
     • Local JSON file if writable (local dev)                    → persists locally
     • In-memory fallback                                          → ephemeral
   Holds: orders, quotes, submissions, settings, pricing.
   ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = "mc:data";
const FILE = process.env.VERCEL ? "/tmp/mc-data.json" : path.join(__dirname, "data.json");

const STATUSES = ["pending_payment", "paid", "assigned", "picked_up", "in_transit", "delivered", "canceled"];

const DEFAULTS = {
  orders: [], quotes: [], submissions: [],
  settings: {
    business: { name: "M&C Logistics", phone1: "(954) 203-2335", phone2: "(954) 544-0359",
      email: "mcdeliverypersonnel24.7@gmail.com", address: "North Lauderdale, FL 33068", hours: "Open 7 Days · 7AM–7PM" },
    payments: { provider: "stripe", mode: "test", stripePublishableKey: "", stripeSecretKeySet: false, stripeWebhookSet: false },
    integrations: { shipdayEnabled: false, googleMapsEnabled: false, smtpEnabled: false },
    dispatchEmails: ["dispatch@mclogistics.delivery", "mcdeliverypersonnel24.7@gmail.com"]
  },
  pricing: {
    bands: [10, 20, 30, 40, 50, 60],
    weightClasses: [
      { maxWeight: 100, label: "Standard (≤100 lb)", tiers: [39.99, 49.99, 59.99, 69.99, 79.99, 89.99] },
      { maxWeight: 200, label: "Heavy (101–200 lb)", tiers: [39.99, 49.99, 59.99, 69.99, 79.99, 89.99] }
    ],
    maxWeight: 200,
    overageStartMiles: 60, overagePerMile: 1.5,
    route: { base: 49.99, perStop: 19.0 },
    addons: { helper: 75, furnitureDolly: 5, standardDolly: 5, rush: 15, overnight: 35, weekend: 20 },
    addonLabels: { helper: "Helper", furnitureDolly: "Furniture dolly", standardDolly: "Standard dolly", rush: "Rush delivery", overnight: "Overnight delivery", weekend: "Weekend delivery" },
    foamWrapPerItem: 5,
    vehicles: [
      { id: "car",          label: "Car",               surcharge: 0, dailyCap: 25 },
      { id: "compact_van",  label: "Compact cargo van", surcharge: 0, dailyCap: 20 },
      { id: "sprinter_van", label: "Sprinter van",      surcharge: 0, dailyCap: 25 },
      { id: "box_truck",    label: "Box truck",         surcharge: 0, dailyCap: 10 }
    ],
    dispatchLeadMinutes: 30
  }
};

let mem = null;

async function redisCmd(args) {
  const r = await fetch(UP_URL, {
    method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  return (await r.json()).result;
}

async function read() {
  let data;
  if (UP_URL) {
    const v = await redisCmd(["GET", REDIS_KEY]);
    data = v ? JSON.parse(v) : null;
  } else {
    try { data = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { data = mem; }
  }
  if (!data) data = JSON.parse(JSON.stringify(DEFAULTS));
  // ensure all keys exist (forward-compatible)
  for (const k of Object.keys(DEFAULTS)) if (data[k] === undefined) data[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
  return data;
}
async function write(data) {
  if (UP_URL) await redisCmd(["SET", REDIS_KEY, JSON.stringify(data)]);
  else { try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (_) {} mem = data; }
}

function code(prefix) {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor((Date.now() * (i + 7) + Math.random() * 1e6) % a.length)];
  return (prefix || "MC") + "-" + s;
}

/* ---- collections ---- */
async function listColl(coll) { return (await read())[coll] || []; }
async function addColl(coll, item, prefix) {
  const d = await read();
  const rec = { id: code(prefix), createdAt: new Date().toISOString(), ...item };
  if (!d[coll]) d[coll] = [];
  d[coll].unshift(rec);
  await write(d);
  return rec;
}
async function updateColl(coll, id, patch) {
  const d = await read();
  const list = d[coll] || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
  await write(d);
  return list[i];
}
async function getColl(coll, id) { return (await listColl(coll)).find((x) => x.id === id) || null; }
async function removeColl(coll, id) {
  const d = await read();
  d[coll] = (d[coll] || []).filter((x) => x.id !== id);
  await write(d);
  return true;
}

/* ---- config blobs (settings / pricing) ---- */
async function getConfig(key) { return (await read())[key]; }
async function setConfig(key, value) {
  const d = await read();
  d[key] = { ...(d[key] || {}), ...value };
  await write(d);
  return d[key];
}

module.exports = {
  STATUSES, DEFAULTS,
  listColl, addColl, updateColl, getColl, removeColl,
  getConfig, setConfig, code
};
