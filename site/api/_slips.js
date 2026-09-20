// Paper slips, plus a SportyBet share code when they will issue one.
import { sql, rowToGame } from "./_db.js";
import { fetchEvent, scoreOf } from "./_card.js";
import { shareSelections } from "./_share.js";
import { notifyBooked } from "./_push.js";

let schemaReady = false;

export async function ensureSlips() {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS slips (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stake DOUBLE PRECISION NOT NULL,
      combined_odds DOUBLE PRECISION NOT NULL,
      potential DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      settled_at TIMESTAMPTZ,
      returned DOUBLE PRECISION
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS slip_legs (
      slip_id TEXT NOT NULL REFERENCES slips(id) ON DELETE CASCADE,
      pos INTEGER NOT NULL,
      game_id TEXT NOT NULL,
      event_id TEXT,
      home TEXT,
      away TEXT,
      league TEXT,
      kickoff BIGINT,
      selection TEXT NOT NULL,
      selection_label TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      match_status TEXT,
      played TEXT,
      set_score TEXT,
      ht_home INTEGER,
      ht_away INTEGER,
      ft_home INTEGER,
      ft_away INTEGER,
      won TEXT,
      PRIMARY KEY (slip_id, game_id)
    )`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS share_code TEXT`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS share_url TEXT`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS share_error TEXT`;
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS live_price DOUBLE PRECISION`;
  schemaReady = true;
}

function combine(a, b) {
  return Math.round(100 / (1 / a + 1 / b)) / 100;
}

function dcOdds(game) {
  const ft = game.ft || {};
  if (game.dc && game.dc.home_draw != null) return game.dc;
  if (ft.home == null || ft.draw == null || ft.away == null) return null;
  return {
    home_draw: combine(ft.home, ft.draw),
    home_away: combine(ft.home, ft.away),
    draw_away: combine(ft.draw, ft.away),
  };
}

const LABELS = {
  "1": "Home", X: "Draw", "2": "Away",
  "1X": "Home or Draw", "12": "Home or Away", X2: "Draw or Away",
};

export function resolvePick(game, selection) {
  const sel = String(selection || "");
  if (!LABELS[sel]) return null;
  const ft = game.ft || {};
  const dc = dcOdds(game);
  const price = ({
    "1": ft.home, X: ft.draw, "2": ft.away,
    "1X": dc && dc.home_draw, "12": dc && dc.home_away, X2: dc && dc.draw_away,
  })[sel];
  if (!isFinite(price) || price <= 1) return null;
  return { selection: sel, label: LABELS[sel], price: Number(price) };
}

export function dcHit(selection, home, away) {
  if (home == null || away == null) return null;
  if (selection === "1") return home > away;
  if (selection === "X") return home === away;
  if (selection === "2") return away > home;
  if (selection === "1X") return home >= away;
  if (selection === "X2") return away >= home;
  if (selection === "12") return home !== away;
  return null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export async function listSlips() {
  await ensureSlips();
  const slips = await sql`SELECT * FROM slips ORDER BY created_at DESC LIMIT 40`;
  const legs = await sql`SELECT * FROM slip_legs ORDER BY pos ASC`;
  const by = new Map(slips.map((s) => [s.id, { ...shapeSlip(s), legs: [] }]));
  for (const leg of legs) {
    const s = by.get(leg.slip_id);
    if (s) s.legs.push(shapeLeg(leg));
  }
  return [...by.values()];
}

function shapeSlip(s) {
  return {
    id: s.id,
    createdAt: s.created_at,
    stake: Number(s.stake),
    combinedOdds: Number(s.combined_odds),
    potential: Number(s.potential),
    status: s.status,
    settledAt: s.settled_at,
    returned: s.returned == null ? null : Number(s.returned),
    shareCode: s.share_code || null,
    shareUrl: s.share_url || null,
    shareError: s.share_error || null,
  };
}

function shapeLeg(l) {
  return {
    gameId: l.game_id,
    eventId: l.event_id,
    home: l.home,
    away: l.away,
    league: l.league || "",
    kickoff: l.kickoff ? Number(l.kickoff) : null,
    selection: l.selection,
    label: l.selection_label,
    price: Number(l.price),
    livePrice: l.live_price == null ? null : Number(l.live_price),
    status: l.match_status || "",
    played: l.played || "",
    setScore: l.set_score || "",
    ht: l.ht_home == null ? null : { home: l.ht_home, away: l.ht_away },
    ft: l.ft_home == null ? null : { home: l.ft_home, away: l.ft_away },
    won: l.won == null ? null : l.won === "yes",
  };
}

async function tryShare(legs) {
  try {
    const got = await shareSelections(legs);
    return { shareCode: got.shareCode, shareUrl: got.shareUrl, shareError: null };
  } catch (e) {
    return { shareCode: null, shareUrl: null, shareError: String(e?.message || e) };
  }
}

export async function createSlip(stake, incoming) {
  await ensureSlips();
  const raw = Array.isArray(incoming) ? incoming : [];
  if (!raw.length) throw new Error("Pick at least one game");
  const n = Number(stake);
  if (!isFinite(n) || n <= 0) throw new Error("Stake has to be a number above 0");

  const ids = [...new Set(raw.map((l) => String(l.gameId || l.id || "")).filter(Boolean))].slice(0, 12);
  const eventIds = [...new Set(raw.map((l) => String(l.eventId || "")).filter(Boolean))];
  const rows = eventIds.length
    ? await sql`SELECT * FROM games WHERE event_id = ANY(${eventIds}) OR game_id = ANY(${ids})`
    : await sql`SELECT * FROM games WHERE game_id = ANY(${ids})`;
  const byEvent = new Map(rows.map((r) => [String(r.event_id || ""), rowToGame(r)]));
  const byId = new Map(rows.map((r) => [String(r.game_id), rowToGame(r)]));
  const legs = [];
  for (const row of raw.slice(0, 12)) {
    const id = String(row.gameId || row.id || "");
    const eid = String(row.eventId || "");
    let g = (eid && byEvent.get(eid)) || byId.get(id);
    if (!g) throw new Error(`Game ${id} is not on the stored card`);
    if (g.eventId) {
      const ev = await fetchEvent(g.eventId);
      if (ev && ev.homeTeamName) {
        g = { ...g, home: ev.homeTeamName, away: ev.awayTeamName || g.away };
      }
    }
    const pick = resolvePick(g, row.selection);
    if (!pick) throw new Error(`${g.home} v ${g.away} has no price for that pick`);
    legs.push({
      gameId: g.id,
      eventId: g.eventId,
      home: g.home,
      away: g.away,
      league: g.league,
      kickoff: g.kickoff,
      ...pick,
    });
  }

  const combined = round2(legs.reduce((acc, l) => acc * l.price, 1));
  const potential = round2(n * combined);
  const id = crypto.randomUUID();
  const share = await tryShare(legs);

  await sql`
    INSERT INTO slips (id, stake, combined_odds, potential, status, share_code, share_url, share_error)
    VALUES (${id}, ${n}, ${combined}, ${potential}, 'open', ${share.shareCode}, ${share.shareUrl}, ${share.shareError})`;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    await sql`
      INSERT INTO slip_legs (
        slip_id, pos, game_id, event_id, home, away, league, kickoff,
        selection, selection_label, price)
      VALUES (
        ${id}, ${i}, ${l.gameId}, ${l.eventId}, ${l.home}, ${l.away}, ${l.league}, ${l.kickoff},
        ${l.selection}, ${l.label}, ${l.price})`;
  }

  await refreshSlips();
  const all = await listSlips();
  return all.find((s) => s.id === id);
}

export async function reshareSlip(slipId) {
  await ensureSlips();
  const rows = await sql`SELECT * FROM slip_legs WHERE slip_id = ${slipId} ORDER BY pos ASC`;
  if (!rows.length) throw new Error("That slip is gone");
  const legs = rows.map((l) => ({
    eventId: l.event_id,
    home: l.home,
    away: l.away,
    selection: l.selection,
    price: Number(l.price),
  }));
  const share = await tryShare(legs);
  await sql`
    UPDATE slips SET share_code = ${share.shareCode}, share_url = ${share.shareUrl}, share_error = ${share.shareError}
    WHERE id = ${slipId}`;
  const all = await listSlips();
  const slip = all.find((s) => s.id === slipId);
  if (!slip) throw new Error("That slip is gone");
  if (share.shareError) throw new Error(share.shareError);
  return slip;
}

export async function refreshSlips() {
  await ensureSlips();
  const open = await sql`SELECT * FROM slips WHERE status IN ('open', 'live')`;
  if (!open.length) return { updated: 0 };

  const legs = await sql`
    SELECT * FROM slip_legs
    WHERE slip_id IN (SELECT id FROM slips WHERE status IN ('open', 'live'))`;

  let liveMap = new Map();
  const eventIds = [...new Set(legs.map((l) => l.event_id).filter(Boolean))];
  const snaps = await Promise.all(eventIds.map((id) => fetchEvent(id)));
  for (const ev of snaps) {
    const snap = scoreOf(ev);
    if (snap && snap.eventId) liveMap.set(snap.eventId, snap);
  }

  let updated = 0;
  for (const leg of legs) {
    const snap = liveMap.get(leg.event_id);
    if (!snap) continue;
    const won = snap.ended ? dcHit(leg.selection, snap.ftHome, snap.ftAway) : null;
    const wonText = won == null ? null : (won ? "yes" : "no");
    const livePrice = snap.prices && isFinite(snap.prices[leg.selection])
      ? snap.prices[leg.selection]
      : null;
    await sql`
      UPDATE slip_legs SET
        home = COALESCE(NULLIF(${snap.home || ""}, ''), slip_legs.home),
        away = COALESCE(NULLIF(${snap.away || ""}, ''), slip_legs.away),
        match_status = ${snap.status},
        played = ${snap.played},
        set_score = ${snap.setScore},
        ht_home = ${snap.htHome},
        ht_away = ${snap.htAway},
        ft_home = ${snap.ftHome},
        ft_away = ${snap.ftAway},
        live_price = COALESCE(${livePrice}, slip_legs.live_price),
        won = ${wonText}
      WHERE slip_id = ${leg.slip_id} AND game_id = ${leg.game_id}`;
    updated++;
  }

  const freshLegs = await sql`
    SELECT * FROM slip_legs
    WHERE slip_id IN (SELECT id FROM slips WHERE status IN ('open', 'live'))`;
  const grouped = new Map();
  for (const l of freshLegs) {
    if (!grouped.has(l.slip_id)) grouped.set(l.slip_id, []);
    grouped.get(l.slip_id).push(l);
  }

  for (const slip of open) {
    const ls = grouped.get(slip.id) || [];
    const anyLost = ls.some((l) => l.won === "no");
    const allWon = ls.length > 0 && ls.every((l) => l.won === "yes");
    const anyLive = ls.some((l) => l.match_status && /^(H1|H2|HT|1H|2H|LIVE)/i.test(l.match_status));
    let status = "open";
    let returned = null;
    let settledAt = null;
    if (anyLost) {
      status = "lost";
      returned = 0;
      settledAt = new Date().toISOString();
    } else if (allWon) {
      status = "won";
      returned = Number(slip.potential);
      settledAt = new Date().toISOString();
    } else if (anyLive) {
      status = "live";
    }
    if (status !== slip.status || returned !== slip.returned) {
      await sql`
        UPDATE slips SET status = ${status}, returned = ${returned}, settled_at = ${settledAt}
        WHERE id = ${slip.id}`;
    }
  }
  const slips = await listSlips();
  let pushed = 0;
  try { pushed = (await notifyBooked(slips)).sent; } catch { /* keep scores */ }
  return { updated, pushed };
}
