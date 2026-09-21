"use strict";
/* Shared helpers for the Daffodil Care newsletter API routes.
   Files starting with "_" are not deployed as routes by Vercel. */
const crypto = require("crypto");

const env = (k) => (process.env[k] || "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Resend renamed "Audiences" to "Segments". Either env name works. */
const segmentId = () => env("RESEND_SEGMENT_ID") || env("RESEND_AUDIENCE_ID");

function missingEnv() {
  const m = [];
  ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "RESEND_FROM"].forEach((k) => { if (!env(k)) m.push(k); });
  if (!segmentId()) m.push("RESEND_SEGMENT_ID");
  return m;
}

/* ---------- http helpers ---------- */
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    const t = typeof req.body === "string" ? req.body : await readRaw(req);
    return t ? JSON.parse(t) : {};
  } catch { return {}; }
}
function cors(req, res) {
  const allowed = env("NEWSLETTER_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (allowed.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ---------- Supabase (service role, server-side only) ---------- */
const sbBase = () => env("SUPABASE_URL").replace(/\/$/, "");
function sbHeaders(extra) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...(extra || {}) };
}
async function sbAdmin(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(sbBase() + "/rest/v1/" + path, {
    method,
    headers: sbHeaders(prefer ? { Prefer: prefer } : null),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Database error (" + r.status + "): " + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
async function sbAll(path, size = 1000) {
  let out = [], off = 0;
  for (;;) {
    const page = await sbAdmin(path + (path.includes("?") ? "&" : "?") + "limit=" + size + "&offset=" + off);
    out = out.concat(page || []);
    if (!page || page.length < size) break;
    off += size;
  }
  return out;
}
async function sbCount(path) {
  const r = await fetch(sbBase() + "/rest/v1/" + path, { headers: sbHeaders({ Prefer: "count=exact", Range: "0-0" }) });
  if (!r.ok) throw new Error("Database error (" + r.status + ")");
  const n = parseInt((r.headers.get("content-range") || "").split("/")[1], 10);
  return Number.isFinite(n) ? n : 0;
}

/* Verifies the caller's Supabase session token. Optional ADMIN_EMAILS allow-list. */
async function requireAdmin(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(sbBase() + "/auth/v1/user", {
    headers: { apikey: env("SUPABASE_ANON_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.email) return null;
  const allow = env("ADMIN_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(String(u.email).toLowerCase())) return null;
  return u;
}

/* ---------- Resend ---------- */
async function resend(path, { method = "GET", body } = {}) {
  const r = await fetch("https://api.resend.com" + path, {
    method,
    headers: { Authorization: "Bearer " + env("RESEND_API_KEY"), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let data = null;
  try { data = t ? JSON.parse(t) : null; } catch { data = { message: t }; }
  if (!r.ok) {
    const e = new Error("Resend: " + ((data && (data.message || data.error)) || r.status));
    e.status = r.status;
    throw e;
  }
  return data;
}
const isAlready = (e) => e && (e.status === 409 || e.status === 422 || /already|exist/i.test(e.message || ""));

async function ensureInSegment(email) {
  const seg = segmentId();
  if (!seg) return;
  try { await resend("/contacts/" + encodeURIComponent(email) + "/segments/" + seg, { method: "POST" }); }
  catch (e) { if (!isAlready(e)) throw e; }
}

/* Creates the contact in Resend (or updates it if it exists) and puts it in the newsletter segment. Returns the contact id. */
async function pushContact({ email, first_name, last_name, unsubscribed }) {
  const body = { email };
  if (first_name) body.first_name = first_name;
  if (last_name) body.last_name = last_name;
  if (unsubscribed !== undefined) body.unsubscribed = !!unsubscribed;
  let c;
  try {
    c = await resend("/contacts", { method: "POST", body });
  } catch (e) {
    if ([401, 403, 429].includes(e.status) || e.status >= 500) throw e;
    const patch = { ...body }; delete patch.email;
    try { c = await resend("/contacts/" + encodeURIComponent(email), { method: "PATCH", body: patch }); }
    catch { throw e; }
  }
  await ensureInSegment(email);
  return c && c.id ? c.id : null;
}

/* ---------- subscribers ---------- */
function splitName(name) {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { first: p[0] ? p[0].slice(0, 60) : null, last: p.length > 1 ? p.slice(1).join(" ").slice(0, 80) : null };
}

/* Adds a subscriber. An address that previously unsubscribed is never re-activated here:
   unsubscribes always win. Re-activating is a deliberate admin action. */
async function subscribe({ email, name, source }) {
  email = String(email || "").trim().toLowerCase();
  const { first, last } = splitName(name);
  const found = await sbAdmin("newsletter_subscribers?email=eq." + encodeURIComponent(email) + "&select=*");
  let row = found && found[0];
  if (row && row.status === "unsubscribed") return { row, created: false, blocked: true };
  let created = false;
  if (!row) {
    const ins = await sbAdmin("newsletter_subscribers", {
      method: "POST", prefer: "return=representation",
      body: { email, first_name: first, last_name: last, source: source || "website" },
    });
    row = ins[0]; created = true;
  }
  if (created || !row.resend_contact_id) {
    try {
      const id = await pushContact({ email, first_name: row.first_name, last_name: row.last_name });
      await sbAdmin("newsletter_subscribers?id=eq." + row.id, { method: "PATCH", body: { resend_contact_id: id || row.resend_contact_id, sync_error: null, updated_at: new Date().toISOString() } });
    } catch (e) {
      await sbAdmin("newsletter_subscribers?id=eq." + row.id, { method: "PATCH", body: { sync_error: String(e.message).slice(0, 300), updated_at: new Date().toISOString() } }).catch(() => {});
    }
  }
  return { row, created, blocked: false };
}

/* ---------- Resend webhook (Svix) signature check ---------- */
function verifySvix(raw, headers, secret) {
  const id = headers["svix-id"], ts = headers["svix-timestamp"], sig = headers["svix-signature"];
  if (!id || !ts || !sig || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(id + "." + ts + "." + raw).digest("base64");
  return String(sig).split(" ").some((part) => {
    const [v, s] = part.split(",");
    if (v !== "v1" || !s) return false;
    const a = Buffer.from(s), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = {
  env, sleep, UUID, EMAIL, segmentId, missingEnv,
  json, readRaw, readJson, cors,
  sbAdmin, sbAll, sbCount, requireAdmin,
  resend, ensureInSegment, pushContact, splitName, subscribe, verifySvix,
};
