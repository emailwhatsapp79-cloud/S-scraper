// Paper slips. Nothing here is sent to SportyBet.
import { sql, rowToGame } from "./_db.js";
import { fetchEvent, scoreOf } from "./_card.js";

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
  schemaReady = true;
}

function combine(a, b) {
  return Math.round(100 / (1 / a + 1 / b)) / 100;
}

export function naturalPick(game) {
  const ft = game.ft || {};
  if (ft.home == null || ft.away == null) return null;
  const fav = ft.home <= ft.away ? "home" : "away";
  let dc = game.dc;
  if (!dc && ft.draw != null) {
    dc = {
      home_draw: combine(ft.home, ft.draw),
      home_away: combine(ft.home, ft.away),
      draw_away: combine(ft.draw, ft.away),
    };
  }
  if (!dc) return null;
  if (fav === "home") {
    return { selection: "1X", label: "Home or Draw", price: Number(dc.home_draw), fav };
  }
  return { selection: "X2", label: "Draw or Away", price: Number(dc.draw_away), fav };
}

export function dcHit(selection, home, away) {
  if (home == null || away == null) return null;
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
    status: l.match_status || "",
    played: l.played || "",
    setScore: l.set_score || "",
    ht: l.ht_home == null ? null : { home: l.ht_home, away: l.ht_away },
    ft: l.ft_home == null ? null : { home: l.ft_home, away: l.ft_away },
    won: l.won == null ? null : l.won === "yes",
  };
}

export async function createSlip(stake, gameIds) {
  await ensureSlips();
  const ids = [...new Set((gameIds || []).map(String))].slice(0, 12);
  if (!ids.length) throw new Error("Pick at least one game");
  const n = Number(stake);
  if (!isFinite(n) || n <= 0) throw new Error("Stake has to be a number above 0");

  const rows = await sql`SELECT * FROM games WHERE game_id = ANY(${ids})`;
  const byId = new Map(rows.map((r) => [r.game_id, rowToGame(r)]));
  const legs = [];
  for (const id of ids) {
    const g = byId.get(id);
    if (!g) throw new Error(`Game ${id} is not on the stored card`);
    const pick = naturalPick(g);
    if (!pick || !isFinite(pick.price) || pick.price <= 1) {
      throw new Error(`${g.home} v ${g.away} has no double-chance price`);
    }
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

  await sql`
    INSERT INTO slips (id, stake, combined_odds, potential, status)
    VALUES (${id}, ${n}, ${combined}, ${potential}, 'open')`;
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
    if (snap) {
      liveMap.set(snap.gameId, snap);
      if (snap.eventId) liveMap.set(snap.eventId, snap);
    }
  }

  let updated = 0;
  for (const leg of legs) {
    const snap = liveMap.get(leg.game_id) || liveMap.get(leg.event_id);
    if (!snap) continue;
    const won = snap.ended ? dcHit(leg.selection, snap.ftHome, snap.ftAway) : null;
    const wonText = won == null ? null : (won ? "yes" : "no");
    await sql`
      UPDATE slip_legs SET
        match_status = ${snap.status},
        played = ${snap.played},
        set_score = ${snap.setScore},
        ht_home = ${snap.htHome},
        ht_away = ${snap.htAway},
        ft_home = ${snap.ftHome},
        ft_away = ${snap.ftAway},
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
  return { updated };
}
