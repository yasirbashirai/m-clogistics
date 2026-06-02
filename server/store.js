/* ==========================================================================
   M&C Logistics — tiny JSON order store
   Good enough for a single small backend instance. For production volume,
   swap these functions for Postgres / Mongo / Firestore (same interface).
   ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "orders.json");
const STATUSES = ["pending_payment", "paid", "assigned", "picked_up", "in_transit", "delivered", "canceled"];

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) { return []; }
}
function save(list) { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }

function code() {
  // human-friendly tracking code, e.g. MC-7F3K92
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor((Date.now() * (i + 7) + Math.random() * 1e6) % a.length)];
  return "MC-" + s;
}

function create(order) {
  const list = load();
  const rec = {
    id: code(),
    createdAt: new Date().toISOString(),
    status: "pending_payment",
    paid: false,
    ...order
  };
  list.unshift(rec);
  save(list);
  return rec;
}

function update(id, patch) {
  const list = load();
  const i = list.findIndex((o) => o.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
  save(list);
  return list[i];
}

function get(id) { return load().find((o) => o.id === id) || null; }
function all() { return load(); }

module.exports = { create, update, get, all, STATUSES };
