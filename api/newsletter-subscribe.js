"use strict";
/* PUBLIC endpoint: POST { email, name?, company? }
   `company` is a honeypot field: real visitors never fill it in. */
const L = require("./_lib");

module.exports = async (req, res) => {
  L.cors(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return L.json(res, 405, { error: "Method not allowed" });

  const b = await L.readJson(req);
  if (b.company) return L.json(res, 200, { ok: true }); // bot: pretend it worked

  const email = String(b.email || "").trim().toLowerCase();
  if (!L.EMAIL.test(email) || email.length > 254) {
    return L.json(res, 400, { error: "Please enter a valid email address." });
  }
  if (!L.env("SUPABASE_URL") || !L.env("SUPABASE_SERVICE_ROLE_KEY")) {
    return L.json(res, 500, { error: "Signups are not available right now." });
  }

  try {
    await L.subscribe({ email, name: b.name, source: "website" });
    // Same response whether the address is new, already subscribed, or previously unsubscribed,
    // so the form can't be used to find out who is on the list.
    return L.json(res, 200, { ok: true });
  } catch (e) {
    console.error("newsletter-subscribe:", e);
    return L.json(res, 500, { error: "Something went wrong. Please try again in a moment." });
  }
};
