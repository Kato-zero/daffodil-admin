"use strict";
/* Resend webhook receiver. Subscribe it to: contact.created, contact.updated, contact.deleted.
   Keeps Supabase in step when someone clicks the unsubscribe link in an email.
   Unsubscribes always win: this route only ever moves people to "unsubscribed" or imports new contacts. */
const L = require("./_lib");

async function handler(req, res) {
  if (req.method !== "POST") return L.json(res, 405, { error: "Method not allowed" });
  const raw = await L.readRaw(req);
  if (!L.verifySvix(raw, req.headers, L.env("RESEND_WEBHOOK_SECRET"))) return L.json(res, 401, { error: "Bad signature" });

  let evt;
  try { evt = JSON.parse(raw); } catch { return L.json(res, 400, { error: "Bad JSON" }); }
  const d = evt.data || {};
  const email = String(d.email || "").trim().toLowerCase();
  if (!/^contact\./.test(evt.type || "") || !email) return L.json(res, 200, { ok: true, ignored: true });

  const now = new Date().toISOString();
  try {
    const found = await L.sbAdmin("newsletter_subscribers?email=eq." + encodeURIComponent(email) + "&select=*");
    const s = found && found[0];
    const goneOrUnsub = evt.type === "contact.deleted" || !!d.unsubscribed;

    if (!s) {
      if (evt.type !== "contact.deleted") {
        await L.sbAdmin("newsletter_subscribers", {
          method: "POST", prefer: "return=minimal",
          body: {
            email, first_name: d.first_name || null, last_name: d.last_name || null,
            status: d.unsubscribed ? "unsubscribed" : "active", source: "resend",
            resend_contact_id: d.id || null, unsubscribed_at: d.unsubscribed ? now : null,
          },
        });
      }
    } else if (goneOrUnsub && s.status === "active") {
      await L.sbAdmin("newsletter_subscribers?id=eq." + s.id, {
        method: "PATCH", body: { status: "unsubscribed", unsubscribed_at: now, updated_at: now },
      });
    } else if (d.id && !s.resend_contact_id && evt.type !== "contact.deleted") {
      await L.sbAdmin("newsletter_subscribers?id=eq." + s.id, { method: "PATCH", body: { resend_contact_id: d.id, updated_at: now } });
    }
  } catch (e) {
    console.error("resend-webhook:", e);
    return L.json(res, 500, { error: "Could not process event" }); // Resend retries on non-2xx
  }
  return L.json(res, 200, { ok: true });
}

module.exports = handler;
/* Signature verification needs the exact raw body, so switch off Vercel's body parser. */
module.exports.config = { api: { bodyParser: false } };
