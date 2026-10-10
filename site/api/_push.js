import webpush from "web-push";
import { sql } from "./_db.js";

export const VAPID_PUBLIC = "BCherTiAf4kuWJW2iqfmGWhtFCIrwxIujL3-g_R5q3Pf_VT2zjZ9uu9aWnSoqz9TxyhL9SNd9wP4hYsV-1NtMQA";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "2-3ePmQknzsSUT4yqv84vbWCQs33b3JPimggL5DHNwY";

webpush.setVapidDetails("mailto:vfs@local", VAPID_PUBLIC, VAPID_PRIVATE);

let ready = false;
async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS push_sent (
    k TEXT PRIMARY KEY,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  ready = true;
}

export async function saveSub(sub) {
  await ensure();
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || "");
  const auth = String(sub?.keys?.auth || "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw new Error("Bad subscription");
  await sql`
    INSERT INTO push_subs (endpoint, p256dh, auth) VALUES (${endpoint}, ${p256dh}, ${auth})
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`;
}

async function dropSub(endpoint) {
  await sql`DELETE FROM push_subs WHERE endpoint = ${endpoint}`;
}

export async function dropAllSubs() {
  await ensure();
  await sql`DELETE FROM push_subs`;
}

export async function dropSubPublic(endpoint) {
  await ensure();
  if (endpoint) await dropSub(endpoint);
  else await sql`DELETE FROM push_subs`;
}

async function claimed(k) {
  await ensure();
  const rows = await sql`
    INSERT INTO push_sent (k) VALUES (${k})
    ON CONFLICT (k) DO NOTHING
    RETURNING k`;
  return rows.length > 0;
}

async function broadcast(payload) {
  await ensure();
  const rows = await sql`SELECT endpoint, p256dh, auth FROM push_subs`;
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        body,
        { TTL: 180, urgency: payload.kind === "kick" ? "high" : "normal" },
      );
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) await dropSub(r.endpoint);
    }
  }));
}

async function sendOnce(k, payload) {
  if (!(await claimed(k))) return false;
  await broadcast({ ...payload, tag: k });
  return true;
}

const RECENT = 45 * 60 * 1000;

export async function notifyBooked(slips) {
  if (!Array.isArray(slips) || !slips.length) return { sent: 0 };
  try {
    const { loadPrefs } = await import("./_vault.js");
    const p = await loadPrefs();
    if (p.pings === false) return { sent: 0 };
  } catch {
    return { sent: 0 };
  }
  const now = Date.now();
  let sent = 0;
  for (const sp of slips) {
    const settledMs = sp.settledAt ? Date.parse(sp.settledAt) : 0;
    const recent = isFinite(settledMs) && settledMs > 0 && now - settledMs < RECENT;
    const active = sp.status === "open" || sp.status === "live";
    if (!active && !recent) continue;

    for (const l of sp.legs || []) {
      if (sp.status === "lost") break;   // once lost, only "Bet missed" below
      if (l.won === true) {
        if (await sendOnce("leg-" + l.gameId + "-yes", {
          kind: "yes",
          sound: "/sounds/yes.wav",
          url: "/book",
          title: "Yes",
          body: (l.home || "") + " v " + (l.away || "") + " · " + (l.label || "") + " in",
        })) sent++;
      } else if (l.won === false) {
        if (await sendOnce("leg-" + l.gameId + "-no", {
          kind: "no",
          sound: "/sounds/no.wav",
          url: "/book",
          title: "No",
          body: (l.home || "") + " v " + (l.away || "") + " · " + (l.label || "") + " missed",
        })) sent++;
      } else if (active && l.kickoff) {
        const d = Number(l.kickoff) - now;
        if (d > 0 && d <= 5 * 60 * 1000) {
          if (await sendOnce("kick-" + l.gameId, {
            kind: "kick",
            sound: "/sounds/kick.wav",
            url: "/book",
            title: "Kicks soon",
            body: (l.home || "") + " v " + (l.away || ""),
          })) sent++;
        }
      }
    }

    if (sp.status === "won" && recent) {
      if (await sendOnce("slip-" + sp.id + "-won", {
        kind: "yes",
        sound: "/sounds/yes.wav",
        url: "/ledger",
        title: "Bet landed",
        body: (sp.shareCode ? sp.shareCode + " · " : "") + (sp.legs || []).length + " legs in",
      })) sent++;
    }
    if (sp.status === "lost" && recent) {
      if (await sendOnce("slip-" + sp.id + "-lost", {
        kind: "no",
        sound: "/sounds/no.wav",
        url: "/ledger",
        title: "Bet missed",
        body: (sp.shareCode ? sp.shareCode + " · " : "") + (sp.legs || []).length + " legs",
      })) sent++;
    }
  }
  return { sent };
}

// Live set alerts for table tennis and tennis legs: every new set score from
// the first set on (1-0, 1-1, ...) until the match ends; the existing Yes / No
// push then gives the result. Each score is claimed once per slip and leg in
// push_sent, so a score is never sent twice.
function pickedHome(sel) {
  const s = String(sel || "");
  if (s === "1") return true;
  if (s === "2") return false;
  const m = s.match(/^(\d+):(\d+)$/);
  return m ? Number(m[1]) > Number(m[2]) : null;
}

function lastName(s) {
  const t = String(s || "").trim();
  return t.includes(",") ? t.split(",")[0].trim() : (t.split(/\s+/).pop() || t);
}

export async function notifySets(legs) {
  if (!Array.isArray(legs) || !legs.length) return { sent: 0 };
  try {
    const { loadPrefs } = await import("./_vault.js");
    if ((await loadPrefs()).pings === false) return { sent: 0 };
  } catch { return { sent: 0 }; }
  await ensure();
  let sent = 0;
  for (const l of legs) {
    if (l.sport !== "tt" && l.sport !== "tn") continue;
    if (l.won === "yes" || l.won === "no") continue;
    const m = String(l.set_score || "").match(/^(\d+)\s*:\s*(\d+)$/);
    if (!m) continue;
    const home = pickedHome(l.selection);
    if (home == null) continue;
    const a = Number(m[1]), b = Number(m[2]);
    const mine = home ? a : b, theirs = home ? b : a;
    if (a + b === 0) continue;           // not started, or no set finished yet
    const base = String(l.slip_id) + "-" + String(l.game_id);
    const who = home ? l.home : l.away;
    const verb = mine < theirs ? "behind" : mine > theirs ? "ahead" : "level";
    if (await sendOnce("set-" + base + "-" + a + ":" + b, {
      kind: mine < theirs ? "no" : "kick",
      url: "/book",
      title: lastName(l.home) + " " + a + "–" + b + " " + lastName(l.away) + " · " + lastName(who) + " " + verb,
      body: (l.home || "") + " v " + (l.away || "") + " · your pick: " + (who || ""),
    })) sent++;
  }
  return { sent };
}
