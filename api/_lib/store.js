/* ==========================================================================
   Serverless order store for Vercel.
   Uses Upstash Redis (free, via REST — no SDK) when configured, otherwise an
   in-memory fallback (per-instance, ephemeral — fine for testing without a DB).
   Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Vercel to persist.
   ========================================================================== */
"use strict";

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "mc:orders";
const STATUSES = ["pending_payment", "paid", "assigned", "picked_up", "in_transit", "delivered", "canceled"];

let mem = [];   // in-memory fallback

async function cmd(args) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const j = await r.json();
  return j.result;
}

async function readAll() {
  if (!URL) return mem;
  const v = await cmd(["GET", KEY]);
  return v ? JSON.parse(v) : [];
}
async function writeAll(list) {
  if (!URL) { mem = list; return; }
  await cmd(["SET", KEY, JSON.stringify(list)]);
}

function code() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor((Date.now() * (i + 7) + Math.random() * 1e6) % a.length)];
  return "MC-" + s;
}

async function create(order) {
  const list = await readAll();
  const rec = { id: code(), createdAt: new Date().toISOString(), status: "pending_payment", paid: false, ...order };
  list.unshift(rec);
  await writeAll(list);
  return rec;
}
async function update(id, patch) {
  const list = await readAll();
  const i = list.findIndex((o) => o.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
  await writeAll(list);
  return list[i];
}
async function get(id) { return (await readAll()).find((o) => o.id === id) || null; }
async function all() { return await readAll(); }

module.exports = { create, update, get, all, STATUSES };
