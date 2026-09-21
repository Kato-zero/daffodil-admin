"use strict";
/* ADMIN endpoint: POST { action, ... } with "Authorization: Bearer <Supabase session token>".
   Actions: health | add-subscriber | set-status | send-test | send-broadcast | sync */
const L = require("./_lib");

const iso = () => new Date().toISOString();

/* Test sends go through the normal email API, which doesn't fill in broadcast placeholders. */
function forTest(html) {
  return html
    .replace(/\{\{\{\s*(?:contact\.first_name|FIRST_NAME)\s*(?:\|\s*([^}]*?)\s*)?\}\}\}/gi, (m, f) => f || "there")
    .replace(/\{\{\{\s*RESEND_UNSUBSCRIBE_URL\s*\}\}\}/g, "#unsubscribe-link-appears-in-real-sends");
}

async function getCampaign(id) {
  if (!L.UUID.test(String(id || ""))) { const e = new Error("Unknown newsletter."); e.code = 404; throw e; }
  const rows = await L.sbAdmin("newsletter_campaigns?id=eq." + id + "&select=*");
  if (!rows || !rows[0]) { const e = new Error("Newsletter not found."); e.code = 404; throw e; }
  return rows[0];
}

/* ---------- actions ---------- */
async function addSubscriber(b) {
  const email = String(b.email || "").trim().toLowerCase();
  if (!L.EMAIL.test(email)) { const e = new Error("Enter a valid email address."); e.code = 400; throw e; }
  const r = await L.subscribe({ email, name: b.name, source: "admin" });
  if (r.blocked) { const e = new Error("That address unsubscribed earlier. Use Reactivate on their row if they asked to rejoin."); e.code = 409; throw e; }
  return { ok: true, created: r.created };
}

async function setStatus(b) {
  if (!L.UUID.test(String(b.id || ""))) { const e = new Error("Unknown subscriber."); e.code = 404; throw e; }
  if (!["active", "unsubscribed"].includes(b.status)) { const e = new Error("Invalid status."); e.code = 400; throw e; }
  const rows = await L.sbAdmin("newsletter_subscribers?id=eq." + b.id + "&select=*");
  const sub = rows && rows[0];
  if (!sub) { const e = new Error("Subscriber not found."); e.code = 404; throw e; }
  const unsub = b.status === "unsubscribed";
  let contactId = sub.resend_contact_id;
  try {
    const c = await L.resend("/contacts/" + encodeURIComponent(sub.email), { method: "PATCH", body: { unsubscribed: unsub } });
    if (c && c.id) contactId = c.id;
    if (!unsub) await L.ensureInSegment(sub.email);
  } catch (e) {
    if (e.status !== 404) throw e;
    contactId = (await L.pushContact({ email: sub.email, first_name: sub.first_name, last_name: sub.last_name, unsubscribed: unsub })) || contactId;
  }
  await L.sbAdmin("newsletter_subscribers?id=eq." + sub.id, {
    method: "PATCH",
    body: { status: b.status, unsubscribed_at: unsub ? iso() : null, resend_contact_id: contactId, sync_error: null, updated_at: iso() },
  });
  return { ok: true };
}

async function sendTest(b) {
  const to = String(b.to || "").trim();
  if (!L.EMAIL.test(to)) { const e = new Error("Enter a valid test address."); e.code = 400; throw e; }
  const c = await getCampaign(b.campaignId);
  if (!c.subject || !c.html) { const e = new Error("Add a subject and some content first."); e.code = 400; throw e; }
  const body = { from: L.env("RESEND_FROM"), to: [to], subject: "[TEST] " + c.subject, html: forTest(c.html) };
  if (L.env("RESEND_REPLY_TO")) body.reply_to = L.env("RESEND_REPLY_TO");
  await L.resend("/emails", { method: "POST", body });
  return { ok: true };
}

async function sendBroadcast(b) {
  const c = await getCampaign(b.campaignId);
  if (!c.subject.trim() || !c.html.trim()) { const e = new Error("Add a subject and some content first."); e.code = 400; throw e; }
  if (!["draft", "failed"].includes(c.status)) { const e = new Error("This newsletter has already been sent or is sending."); e.code = 409; throw e; }

  const recipients = await L.sbCount("newsletter_subscribers?status=eq.active&select=id");
  if (!recipients) { const e = new Error("There are no active subscribers to send to."); e.code = 400; throw e; }

  // Claim the campaign so a double click or second tab can't send it twice.
  const claimed = await L.sbAdmin("newsletter_campaigns?id=eq." + c.id + "&status=in.(draft,failed)", {
    method: "PATCH", prefer: "return=representation", body: { status: "sending", error: null, updated_at: iso() },
  });
  if (!claimed || !claimed.length) { const e = new Error("This newsletter is already being sent."); e.code = 409; throw e; }

  let broadcastId = c.resend_broadcast_id || null;
  try {
    const bc = await L.resend("/broadcasts", {
      method: "POST",
      body: {
        segment_id: L.segmentId(),
        from: L.env("RESEND_FROM"),
        subject: c.subject,
        preview_text: c.preview_text || undefined,
        html: c.html,
        name: c.subject.slice(0, 100),
        reply_to: L.env("RESEND_REPLY_TO") || undefined,
      },
    });
    broadcastId = bc.id;
    await L.sbAdmin("newsletter_campaigns?id=eq." + c.id, { method: "PATCH", body: { resend_broadcast_id: broadcastId, updated_at: iso() } });
    await L.resend("/broadcasts/" + broadcastId + "/send", { method: "POST", body: {} });
    await L.sbAdmin("newsletter_campaigns?id=eq." + c.id, {
      method: "PATCH",
      body: { status: "sent", sent_at: iso(), recipients_count: recipients, error: null, updated_at: iso() },
    });
    return { ok: true, broadcastId, recipients };
  } catch (err) {
    await L.sbAdmin("newsletter_campaigns?id=eq." + c.id, {
      method: "PATCH", body: { status: "failed", error: String(err.message).slice(0, 500), resend_broadcast_id: broadcastId, updated_at: iso() },
    }).catch(() => {});
    throw err;
  }
}

/* Two-way reconcile between Supabase and the Resend segment.
   - Contacts only in Resend are imported.
   - Unsubscribes always win: if either side says unsubscribed, both end up unsubscribed.
   - Active subscribers missing from Resend are pushed (20 per run, to stay inside rate limits). */
async function doSync() {
  const seg = L.segmentId();
  const now = iso();
  const remote = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const r = await L.resend("/segments/" + seg + "/contacts?limit=100" + (after ? "&after=" + encodeURIComponent(after) : ""));
    const data = (r && r.data) || [];
    remote.push(...data);
    if (!(r && r.has_more) || !data.length) break;
    after = data[data.length - 1].id;
    await L.sleep(250);
  }
  const local = await L.sbAll("newsletter_subscribers?select=*&order=id.asc");
  const byEmail = new Map(local.map((s) => [s.email, s]));
  const remoteByEmail = new Map();
  remote.forEach((c) => remoteByEmail.set(String(c.email).toLowerCase(), c));

  // Every upserted row carries the full column set so merge-duplicates never blanks a column.
  const full = (s, p) => ({
    email: s.email, first_name: s.first_name ?? null, last_name: s.last_name ?? null, status: s.status,
    source: s.source || "resend", resend_contact_id: s.resend_contact_id ?? null, sync_error: s.sync_error ?? null,
    subscribed_at: s.subscribed_at || now, unsubscribed_at: s.unsubscribed_at ?? null, updated_at: now, ...(p || {}),
  });
  const upserts = new Map();
  const put = (row) => upserts.set(row.email, row);

  let imported = 0, unsubscribedLocal = 0;
  const pushUnsub = [];
  for (const [email, c] of remoteByEmail) {
    const s = byEmail.get(email);
    if (!s) {
      put(full({ email, first_name: c.first_name || null, last_name: c.last_name || null, status: c.unsubscribed ? "unsubscribed" : "active", source: "resend", subscribed_at: c.created_at }, {
        resend_contact_id: c.id, unsubscribed_at: c.unsubscribed ? now : null,
      }));
      imported++;
      continue;
    }
    const patch = {};
    if (s.resend_contact_id !== c.id) patch.resend_contact_id = c.id;
    if (c.unsubscribed && s.status === "active") { patch.status = "unsubscribed"; patch.unsubscribed_at = now; unsubscribedLocal++; }
    if (!c.unsubscribed && s.status === "unsubscribed") pushUnsub.push(s);
    if (Object.keys(patch).length) put(full(s, { ...patch, sync_error: null }));
  }

  const queue = [
    ...pushUnsub.map((s) => ({ s, unsub: true })),
    ...local.filter((s) => s.status === "active" && !remoteByEmail.has(s.email)).map((s) => ({ s, unsub: false })),
  ];
  const MAX = 20;
  let pushed = 0;
  for (const { s, unsub } of queue.slice(0, MAX)) {
    try {
      if (unsub) {
        await L.resend("/contacts/" + encodeURIComponent(s.email), { method: "PATCH", body: { unsubscribed: true } });
      } else {
        const id = await L.pushContact({ email: s.email, first_name: s.first_name, last_name: s.last_name });
        put(full(s, { resend_contact_id: id || s.resend_contact_id, sync_error: null }));
      }
      pushed++;
    } catch (e) {
      put(full(s, { sync_error: String(e.message).slice(0, 300) }));
    }
    await L.sleep(350);
  }

  const rows = [...upserts.values()];
  for (let i = 0; i < rows.length; i += 500) {
    await L.sbAdmin("newsletter_subscribers?on_conflict=email", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows.slice(i, i + 500) });
  }
  return { ok: true, imported, unsubscribed_local: unsubscribedLocal, pushed, remaining: Math.max(0, queue.length - MAX), in_resend: remoteByEmail.size };
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return L.json(res, 405, { error: "Method not allowed" });
  if (!L.env("SUPABASE_URL") || !L.env("SUPABASE_SERVICE_ROLE_KEY")) {
    return L.json(res, 500, { error: "Server setup incomplete. Missing: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY" });
  }
  let admin = null;
  try { admin = await L.requireAdmin(req); } catch { /* fall through */ }
  if (!admin) return L.json(res, 401, { error: "Not authorised. Sign in again." });

  const b = await L.readJson(req);
  const missing = L.missingEnv();
  if (b.action === "health") return L.json(res, 200, { ok: !missing.length, missing });
  if (missing.length) return L.json(res, 500, { error: "Server setup incomplete. Missing: " + missing.join(", ") });

  try {
    switch (b.action) {
      case "add-subscriber": return L.json(res, 200, await addSubscriber(b));
      case "set-status": return L.json(res, 200, await setStatus(b));
      case "send-test": return L.json(res, 200, await sendTest(b));
      case "send-broadcast": return L.json(res, 200, await sendBroadcast(b));
      case "sync": return L.json(res, 200, await doSync());
      default: return L.json(res, 400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error("newsletter-admin:", b.action, e);
    return L.json(res, typeof e.code === "number" ? e.code : 500, { error: e.message || "Something went wrong." });
  }
};
