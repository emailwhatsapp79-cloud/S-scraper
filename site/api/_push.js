import webpush from "web-push";
import { sql } from "./_db.js";
import { touchHealth } from "./_health.js";

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

/** One real server push to a single device, so turning pings on proves the
 *  whole path (server -> push service -> phone), not just the page. */
export async function testSub(sub) {
  await ensure();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM push_subs`;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      JSON.stringify({ title: "✅ Vantage pings work", body: "This came from the server, the same way slip updates will.", kind: "yes", url: "/book", tag: "test-" + Date.now() }),
      { TTL: 900, urgency: "high" },
    );
    return { sent: true, devices: n };
  } catch (e) {
    return { sent: false, devices: n, code: e?.statusCode || String(e?.message || e).slice(0, 80) };
  }
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
  const fails = [];
  let ok = 0;
  // Every ping is about a live bet, so all of them go out "high": a phone in
  // battery saver holds "normal" pushes back until it wakes, minutes late.
  // TTL 15 min so a phone that is briefly offline still gets it.
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        body,
        { TTL: 900, urgency: "high" },
      );
      ok++;
    } catch (e) {
      const code = e?.statusCode;
      fails.push({ host: String(r.endpoint).split("/")[2], code: code || String(e?.message || e).slice(0, 80) });
      if (code === 404 || code === 410) await dropSub(r.endpoint);
    }
  }));
  // Last delivery, so a silent phone can be told apart from a push that failed.
  await touchHealth("push", { at: Date.now(), tag: payload.tag, devices: rows.length, ok, fails });
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
      if (l.sport === "tt" || l.sport === "tn") continue;   // live updates cover these (notifySets)
      if (l.won === true) {
        if (await sendOnce("leg-" + l.gameId + "-yes", {
          kind: "yes",
          sound: "/sounds/yes.wav",
          url: "/book",
          title: "✅ " + (l.label || "Leg") + " won",
          body: (l.home || "") + " v " + (l.away || "") + (l.setScore ? " · FT " + l.setScore.replace(":", "–") : ""),
        })) sent++;
      } else if (l.won === false) {
        if (await sendOnce("leg-" + l.gameId + "-no", {
          kind: "no",
          sound: "/sounds/no.wav",
          url: "/book",
          title: "❌ " + (l.label || "Leg") + " lost",
          body: (l.home || "") + " v " + (l.away || "") + (l.setScore ? " · FT " + l.setScore.replace(":", "–") : ""),
        })) sent++;
      } else if (active && l.kickoff && l.sport !== "tt" && l.sport !== "tn") {
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
        title: "🎉 " + (sp.shareCode || "Slip") + " WON " + (sp.legs || []).length + "/" + (sp.legs || []).length + "!",
        body: "Payout " + naira(sp.returned || sp.potential) + " on " + naira(sp.stake) + " · congratulations",
      })) sent++;
    }
    if (sp.status === "lost" && recent) {
      if (await sendOnce("slip-" + sp.id + "-lost", {
        kind: "no",
        sound: "/sounds/no.wav",
        url: "/ledger",
        title: (sp.shareCode || "Slip") + " lost",
        body: (sp.legs || []).filter((x) => x.won === true).length + "/" + (sp.legs || []).length + " legs won",
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

// Live updates for every TT / tennis leg of an open slip, from the pick's side:
// game started, every finished set (leads / trails / level), every point of
// a deciding set, and the leg's result with the slip's tally. One push per
// event (sendOnce keys), so nothing repeats.
function pairsOf(text) {
  return [...String(text || "").matchAll(/(\d+):(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}
const naira = (n) => "₦" + Math.round(Number(n) || 0).toLocaleString("en-NG");

export async function notifySets(legs, slips) {
  if (!Array.isArray(legs) || !legs.length) return { sent: 0 };
  try {
    const { loadPrefs } = await import("./_vault.js");
    if ((await loadPrefs()).pings === false) return { sent: 0 };
  } catch { return { sent: 0 }; }
  await ensure();
  const bySlip = new Map();
  for (const l of legs) {
    if (!bySlip.has(l.slip_id)) bySlip.set(l.slip_id, []);
    bySlip.get(l.slip_id).push(l);
  }
  const code = new Map((slips || []).map((s) => [String(s.id), s.share_code || ""]));
  let sent = 0;
  for (const l of legs) {
    const home = pickedHome(l.selection);
    if (home == null) continue;
    const tn = l.sport === "tn";
    if (l.sport !== "tt" && !tn) continue;
    const mineName = lastName(home ? l.home : l.away);
    const oppName = lastName(home ? l.away : l.home);
    const all = bySlip.get(l.slip_id) || [];
    const won = all.filter((x) => x.won === "yes").length;
    const tally = (code.get(String(l.slip_id)) || "Slip") + " · " + won + "/" + all.length + " won";
    const odds = Number(l.live_price) > 1 ? " · odds " + Number(l.live_price).toFixed(2) : "";
    const base = String(l.slip_id) + "-" + String(l.game_id);
    const flip = (p) => (home ? p : [p[1], p[0]]);

    // Result of the leg.
    if (l.won === "yes" || l.won === "no") {
      const ss = pairsOf(l.set_score)[0];
      const sets = ss ? flip(ss).join("–") : "";
      const lost = all.some((x) => x.won === "no");
      if (await sendOnce("res-" + base, l.won === "yes" ? {
        kind: "yes", url: "/book",
        title: "✅ " + mineName + " WON " + sets,
        body: tally + (lost ? "" : " · " + (all.length - won) + " to go"),
      } : {
        kind: "no", url: "/book",
        title: "❌ " + mineName + " lost " + sets,
        body: (code.get(String(l.slip_id)) || "Slip") + " is lost",
      })) sent++;
      continue;
    }
    const st = String(l.match_status || "");
    const live = /^(set\s*\d|\d+(st|nd|rd|th)|playing|.*break)/i.test(st);
    if (!live) continue;
    const ssRaw = pairsOf(l.set_score)[0] || [0, 0];
    const [ms, ts] = flip(ssRaw);

    // Game started.
    if (await sendOnce("start-" + base, {
      kind: "kick", url: "/book",
      title: "▶ " + mineName + " v " + oppName + " started" + odds,
      body: tally,
    })) sent++;

    // A set just finished.
    if (ms + ts > 0) {
      const sets = pairsOf(l.game_score);
      const last = sets[ms + ts - 1] ? flip(sets[ms + ts - 1]) : null;
      const wonLast = last ? last[0] > last[1] : ms > ts;
      const need = tn ? 2 : 3;
      const state = ms > ts ? "leads " + ms + "–" + ts : ms < ts ? "trails " + ms + "–" + ts : "level " + ms + "–" + ts;
      const brink = ts === need - 1 && ms < ts;
      const icon = brink ? "🚨" : wonLast ? "✅" : "⚠️";
      if (await sendOnce("set-" + base + "-" + ssRaw[0] + ":" + ssRaw[1], {
        kind: wonLast ? "kick" : "no", url: "/book",
        title: icon + " " + mineName + (wonLast ? " won" : " lost") + " set " + (ms + ts) + (last ? " " + last[0] + "–" + last[1] : "") + " · " + state,
        body: tally + odds,
      })) sent++;

      // Every point of a deciding set.
      if (ms === need - 1 && ts === need - 1) {
        const pt = pairsOf(l.played)[0];
        if (pt && pt[0] + pt[1] > 0) {
          const [mp, tp] = flip(pt);
          if (await sendOnce("pt-" + base + "-" + pt[0] + ":" + pt[1], {
            kind: mp >= tp ? "kick" : "no", url: "/book",
            title: "🚨 Deciding set · " + mineName + " " + mp + "–" + tp + " " + oppName,
            body: tally + odds,
          })) sent++;
        }
      }
    }
  }
  return { sent };
}

// Started, and whether a booked game is going your way or not. Table tennis
// and tennis set scores (1–0, 1–1, …) stay in notifySets. Each moment is
// claimed once, so a score is never sent twice.
export async function notifyMoments(legs) {
  if (!Array.isArray(legs) || !legs.length) return { sent: 0 };
  try {
    const { loadPrefs } = await import("./_vault.js");
    if ((await loadPrefs()).pings === false) return { sent: 0 };
  } catch { return { sent: 0 }; }
  const { legMoments } = await import("./_watch.js");
  let sent = 0;
  for (const l of legs) {
    for (const m of legMoments(l)) {
      if (await sendOnce(m.key, {
        kind: m.kind,
        url: "/book",
        title: m.title,
        body: m.body,
      })) sent++;
    }
  }
  return { sent };
}

// Red flags (see _flags.js): one alert per leg when it turns "danger", with
// what was seen, and every flag logged in slip_flags for the briefing.
export async function notifyFlags(legs, slips) {
  if (!Array.isArray(legs) || !legs.length) return { sent: 0 };
  const { legFlags } = await import("./_flags.js");
  await sql`CREATE TABLE IF NOT EXISTS slip_flags (
    slip_id TEXT NOT NULL, game_id TEXT NOT NULL, level TEXT NOT NULL,
    reasons TEXT, set_score TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (slip_id, game_id, level)
  )`;
  let pingsOff = false;
  try { const { loadPrefs } = await import("./_vault.js"); pingsOff = (await loadPrefs()).pings === false; } catch { /* default on */ }
  const potential = new Map((slips || []).map((s) => [String(s.id), Number(s.potential) || 0]));
  let sent = 0;
  for (const l of legs) {
    if (l.sport !== "tt" && l.sport !== "tn") continue;
    const f = legFlags(l);
    if (f.level === "none") continue;
    const why = f.reasons.join(" · ");
    await sql`INSERT INTO slip_flags (slip_id, game_id, level, reasons, set_score)
      VALUES (${String(l.slip_id)}, ${String(l.game_id)}, ${f.level}, ${why}, ${l.set_score || ""})
      ON CONFLICT (slip_id, game_id, level) DO NOTHING`;
    if (f.level !== "danger" || pingsOff) continue;
    const home = pickedHome(l.selection);
    const who = home ? l.home : l.away;
    const pot = potential.get(String(l.slip_id));
    if (await sendOnce("flag-" + l.slip_id + "-" + l.game_id, {
      kind: "no",
      url: "/book",
      title: "🚩 Think about cashing out · " + lastName(who) + " struggling",
      body: why + (pot ? " · slip pays ₦" + Math.round(pot).toLocaleString("en-NG") + " if it holds" : ""),
    })) sent++;
  }
  return { sent };
}
