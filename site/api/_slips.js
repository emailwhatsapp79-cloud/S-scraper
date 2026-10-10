// Paper slips, plus a SportyBet share code when they will issue one.
import { sql, rowToGame } from "./_db.js";
import { fetchEvent, scoreOf, FOOTBALL_BASE } from "./_card.js";
import { shareSelections } from "./_share.js";
import { notifyBooked, notifySets } from "./_push.js";
import { placeOrder, loadGifts, priceLeg } from "./_fc.js";
import { readSession, writeSession } from "./_fc_session.js";

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
      market_id TEXT,
      outcome_id TEXT,
      PRIMARY KEY (slip_id, game_id)
    )`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS share_code TEXT`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS share_url TEXT`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS share_error TEXT`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS order_id TEXT`;
  await sql`ALTER TABLE slips ADD COLUMN IF NOT EXISTS pay_with TEXT`;
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS sport TEXT`;
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS market_id TEXT`;
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS outcome_id TEXT`;
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS specifier TEXT`;
  // What the card said when the leg was booked: strong / good / lean / none,
  // or "against" (backed the side the stats did not favour), plus our chance.
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS tag TEXT`;
  await sql`ALTER TABLE slip_legs ADD COLUMN IF NOT EXISTS chance DOUBLE PRECISION`;
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
  const sets = String(selection || "").match(/^(\d+):(\d+)$/);
  if (sets) return home === Number(sets[1]) && away === Number(sets[2]);
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
    orderId: s.order_id || null,
    payWith: s.pay_with || null,
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
    sport: l.sport || "fb",
    marketId: l.market_id || null,
    outcomeId: l.outcome_id || null,
    specifier: l.specifier || "",
    tag: l.tag || null,
    chance: l.chance == null ? null : Number(l.chance),
  };
}

// Table tennis legs that reach the server without a tag (an old page still
// open, or legs left in the Betslip from before) get it worked out here from
// the same stats % the card shows: 75%+ Strong, 70%+ Good, 65%+ Lean, else No
// tag; backing the other side is "against".
export function tagFromStats(stats, selection) {
  if (!stats || (selection !== "1" && selection !== "2")) return null;
  const home = Number(stats.home) >= Number(stats.away);
  const pct = home ? Number(stats.home) : Number(stats.away);
  const mine = selection === "1" ? Number(stats.home) : Number(stats.away);
  const tag = (selection === "1") !== home ? "against"
    : pct >= 75 ? "strong" : pct >= 70 ? "good" : pct >= 65 ? "lean" : "none";
  return { tag, chance: Math.round(mine) / 100 };
}

async function fillTTTags(legs) {
  const need = legs.filter((l) => l.sport === "tt" && !l.tag && (l.selection === "1" || l.selection === "2"));
  if (!need.length) return;
  try {
    const { forecastCard } = await import("./_ratings.js");
    const games = need.map((l) => ({ home: l.home, away: l.away, tourn: l.league, start: l.kickoff }));
    await forecastCard(games);
    need.forEach((l, i) => {
      const t = tagFromStats(games[i].stats, l.selection);
      if (t) { l.tag = t.tag; if (l.chance == null) l.chance = t.chance; }
    });
  } catch { /* the slip still books, just untagged */ }
}

// Tennis tags from the tennis stats model (Strong 80 / Good 75 / Lean 70),
// for the side the pick backs (set scores back the side that wins them).
async function fillTnTags(legs) {
  const homeOf = (sel) => (sel === "1" || sel === "2:0" || sel === "2:1") ? true
    : (sel === "2" || sel === "0:2" || sel === "1:2") ? false : null;
  const need = legs.filter((l) => l.sport === "tn" && !l.tag && homeOf(String(l.selection)) != null);
  if (!need.length) return;
  try {
    const { forecastTennis } = await import("./_tn_model.js");
    const games = need.map((l) => ({ home: l.home, away: l.away, start: l.kickoff }));
    await forecastTennis(games);
    need.forEach((l, i) => {
      const s = games[i].stats;
      if (!s) return;
      const mine = homeOf(String(l.selection)) ? s.home : s.away;
      l.tag = mine >= 80 ? "strong" : mine >= 75 ? "good" : mine >= 70 ? "lean" : mine < 50 ? "against" : "none";
      if (l.chance == null) l.chance = mine / 100;
    });
  } catch { /* the slip still books, just untagged */ }
}

const TAGS = new Set(["strong","good","lean","none","against"]);

async function tryShare(legs) {
  try {
    const football = (legs || []).some((l) => l.sport === "fc" || l.source === "football");
    const got = await shareSelections(legs, football ? "football" : "sporty");
    return { shareCode: got.shareCode, shareUrl: got.shareUrl, shareError: null };
  } catch (e) {
    return { shareCode: null, shareUrl: null, shareError: String(e?.message || e) };
  }
}

function ttRowToGame(r) {
  return {
    id: r.match_id,
    eventId: r.event_id || null,
    home: r.home,
    away: r.away,
    league: r.tourn || "Table tennis",
    kickoff: r.start_at ? Number(r.start_at) : null,
    ft: { home: r.win_home, draw: null, away: r.win_away },
    sport: "tt",
  };
}

export async function createSlip(stake, incoming, book, opts = {}) {
  await ensureSlips();
  const raw = Array.isArray(incoming) ? incoming : [];
  if (!raw.length) throw new Error("Pick at least one game");
  const n = Number(stake);
  if (!isFinite(n) || n <= 0) throw new Error("Stake has to be a number above 0");

  if (book === "football" || raw.every((l) => l && (l.source === "football" || l.sport === "fc"))) {
    const legs = [];
    for (const row of raw.slice(0, 12)) {
      const price = Number(row.price);
      if (!row.eventId || !row.home || !(price > 1) || !row.selection) {
        throw new Error("Football.com leg is missing a price or event");
      }
      legs.push({
        gameId: String(row.gameId || row.id || ""),
        eventId: String(row.eventId),
        home: row.home,
        away: row.away || "",
        league: row.league || "",
        kickoff: row.kickoff || null,
        sport: "fc",
        selection: String(row.selection),
        label: row.label || LABELS[String(row.selection)] || String(row.selection),
        price,
        marketId: row.marketId ? String(row.marketId) : null,
        outcomeId: row.outcomeId ? String(row.outcomeId) : null,
        probability: row.probability ? String(row.probability) : "",
        product: row.product ? String(row.product) : "3",
        sportId: row.sportId || null,
      });
    }
    await fillTTTags(legs);
    await fillTnTags(legs);

  const pay = opts.pay === "gift" ? "gift" : opts.pay === "money" ? "money" : "";
    let placed = null;
    let booked = legs;
    if (pay) {
      const session = await readSession();
      if (!session) throw new Error("Connect Football.com first. That login signs itself out after one day.");
      let gift = null;
      let current = session;
      if (pay === "gift") {
        const got = await loadGifts(session);
        current = got.session || session;
        if (got.session && got.session.cookie !== session.cookie) await writeSession(got.session);
        gift = (got.gifts || []).find((g) => g.id === String(opts.giftId || "")) || null;
        if (!gift) throw new Error("Pick a gift. This account has none that can cover a bet.");
      }
      placed = await placeOrder(current, legs, n, gift);
      if (placed.session && placed.session.cookie !== current.cookie) await writeSession(placed.session);
      booked = placed.legs;
    }
    const share = await tryShare(booked);
    const id = crypto.randomUUID();
    const combined = round2(booked.reduce((acc, l) => acc * l.price, 1));
    const potential = round2(n * combined);
    await sql`
      INSERT INTO slips (id, stake, combined_odds, potential, status, share_code, share_url, share_error, order_id, pay_with)
      VALUES (${id}, ${n}, ${combined}, ${potential}, 'open', ${share.shareCode}, ${share.shareUrl}, ${share.shareError}, ${placed ? placed.orderId : null}, ${pay || null})`;
    for (let i = 0; i < booked.length; i++) {
      const l = booked[i];
      await sql`
        INSERT INTO slip_legs (
          slip_id, pos, game_id, event_id, home, away, league, kickoff,
          selection, selection_label, price, sport, market_id, outcome_id, specifier)
        VALUES (
          ${id}, ${i}, ${l.gameId}, ${l.eventId}, ${l.home}, ${l.away}, ${l.league}, ${l.kickoff},
          ${l.selection}, ${l.label}, ${l.price}, ${"fc"}, ${l.marketId}, ${l.outcomeId}, ${l.specifier || null})`;
    }
    const all = await listSlips();
    return all.find((s) => s.id === id);
  }

  const ids = [...new Set(raw.map((l) => String(l.gameId || l.id || "")).filter(Boolean))];
  const eventIds = [...new Set(raw.map((l) => String(l.eventId || "")).filter(Boolean))];
  const rows = eventIds.length
    ? await sql`SELECT * FROM games WHERE event_id = ANY(${eventIds}) OR game_id = ANY(${ids})`
    : await sql`SELECT * FROM games WHERE game_id = ANY(${ids})`;
  const ttRows = eventIds.length
    ? await sql`SELECT * FROM tt_games WHERE event_id = ANY(${eventIds}) OR match_id = ANY(${ids})`
    : await sql`SELECT * FROM tt_games WHERE match_id = ANY(${ids})`;
  const byEvent = new Map(rows.map((r) => [String(r.event_id || ""), rowToGame(r)]));
  const byId = new Map(rows.map((r) => [String(r.game_id), rowToGame(r)]));
  for (const r of ttRows) {
    const g = ttRowToGame(r);
    if (g.eventId) byEvent.set(String(g.eventId), g);
    byId.set(String(g.id), g);
  }
  if (raw.length > 50) throw new Error(`SportyBet takes 50 games on one slip. This one has ${raw.length}.`);
  const legs = [];
  for (const row of raw) {
    const id = String(row.gameId || row.id || "");
    const eid = String(row.eventId || "");
    let g = row.sport === "tn" ? null : ((eid && byEvent.get(eid)) || byId.get(id));
    if (row.sport === "tn") {
      if (!row.eventId || !row.home || !(Number(row.price) > 1)) {
        throw new Error("Tennis leg is missing the match. Refresh Tennis and tap the green score.");
      }
      g = {
        id: id || eid, eventId: row.eventId, home: row.home, away: row.away || "",
        league: row.league || "Tennis", kickoff: row.kickoff || null, sport: "tn",
      };
    } else if (!g && row.home && row.eventId && row.price) {
      const league = row.league || "";
      const asked = row.sport === "tn" || row.sport === "tt" || row.sport === "eb" ? row.sport : "";
      g = {
        id, eventId: row.eventId, home: row.home, away: row.away,
        league: league || (asked === "tn" ? "Tennis" : asked === "eb" ? "eBasketball" : "Table tennis"),
        kickoff: row.kickoff || null,
        ft: { home: row.selection === "1" ? Number(row.price) : null, draw: null, away: row.selection === "2" ? Number(row.price) : null },
        sport: asked || (/setka|elite series|liga pro|tt cup|challenger|table tennis/i.test(String(league)) ? "tt" : "fb"),
      };
    }
    if (!g) throw new Error(`Game ${id} is not on the stored card`);
    const sport = row.sport === "tn" || row.sport === "tt" || row.sport === "eb" ? row.sport : (g.sport || "fb");
    if (sport !== "tt" && sport !== "tn" && sport !== "eb" && g.eventId) {
      const ev = await fetchEvent(g.eventId);
      if (ev && ev.homeTeamName) {
        g = { ...g, home: ev.homeTeamName, away: ev.awayTeamName || g.away };
      }
    }
    const pick = resolvePick(g, row.selection) || (
      isFinite(Number(row.price)) && Number(row.price) > 1
        ? { selection: String(row.selection), label: LABELS[String(row.selection)] || String(row.selection), price: Number(row.price) }
        : null
    );
    if (!pick) throw new Error(`${g.home} v ${g.away} has no price for that pick`);
    if (row.label) pick.label = String(row.label);
    legs.push({
      gameId: g.id,
      eventId: g.eventId,
      home: g.home,
      away: g.away,
      league: g.league,
      kickoff: g.kickoff,
      ...pick,
      sport,
      marketId: row.marketId ? String(row.marketId) : null,
      outcomeId: row.outcomeId ? String(row.outcomeId) : null,
      probability: row.probability ? String(row.probability) : "",
      specifier: row.specifier ? String(row.specifier) : "",
      tag: TAGS.has(String(row.tag || "")) ? String(row.tag) : null,
      chance: Number(row.chance) > 0 && Number(row.chance) < 1 ? Number(row.chance) : null,
    });
  }
  await fillTTTags(legs);
  await fillTnTags(legs);

  const pay = opts.pay === "gift" ? "gift" : opts.pay === "money" ? "money" : "";
  let placed = null;
  let booked = legs;
  if (pay) {
    const session = await readSession("sporty");
    if (!session) throw new Error("Connect SportyBet first. That login signs itself out after one day.");
    let gift = null;
    let current = session;
    if (pay === "gift") {
      const got = await loadGifts(session);
      current = got.session || session;
      if (got.session && got.session.cookie !== session.cookie) await writeSession(got.session);
      gift = (got.gifts || []).find((g) => g.id === String(opts.giftId || "")) || null;
      if (!gift) throw new Error("Pick a gift. This account has none that can cover a bet.");
    }
    placed = await placeOrder(current, legs, n, gift);
    if (placed.session && placed.session.cookie !== current.cookie) await writeSession(placed.session);
    booked = placed.legs;
  } else {
    const checked = [];
    for (const leg of legs) checked.push(await priceLeg(leg, "sporty"));
    booked = checked;
  }
  const share = await tryShare(booked);
  const combined = round2(booked.reduce((acc, l) => acc * l.price, 1));
  const potential = round2(n * combined);
  const id = crypto.randomUUID();

  await sql`
    INSERT INTO slips (id, stake, combined_odds, potential, status, share_code, share_url, share_error, order_id, pay_with)
    VALUES (${id}, ${n}, ${combined}, ${potential}, 'open', ${share.shareCode}, ${share.shareUrl}, ${share.shareError}, ${placed ? placed.orderId : null}, ${pay || null})`;
  for (let i = 0; i < booked.length; i++) {
    const l = booked[i];
    await sql`
      INSERT INTO slip_legs (
        slip_id, pos, game_id, event_id, home, away, league, kickoff,
        selection, selection_label, price, sport, market_id, outcome_id, specifier, tag, chance)
      VALUES (
        ${id}, ${i}, ${l.gameId}, ${l.eventId}, ${l.home}, ${l.away}, ${l.league}, ${l.kickoff},
        ${l.selection}, ${l.label}, ${l.price}, ${l.sport || "fb"}, ${l.marketId || null}, ${l.outcomeId || null}, ${l.specifier || null},
        ${l.tag || null}, ${l.chance ?? null})`;
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
    league: l.league,
    sport: l.sport || "fb",
    marketId: l.market_id || null,
    outcomeId: l.outcome_id || null,
    specifier: l.specifier || "",
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
  const snaps = await Promise.all(eventIds.map((id) => {
    const fc = legs.some((l) => l.event_id === id && l.sport === "fc");
    const tn = legs.some((l) => l.event_id === id && (l.sport === "tn" || l.sport === "tt"));
    const eb = legs.some((l) => l.event_id === id && l.sport === "eb");
    return fetchEvent(id, eb ? { marketId: "219" } : tn ? { marketId: "186,199" } : {}, fc ? FOOTBALL_BASE : undefined);
  }));
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
    // Only record a genuine in-play price — never the prematch echo of a game
    // that hasn't kicked off, so "Live odds" means what it says.
    const livePrice = snap.live && snap.prices && isFinite(snap.prices[leg.selection])
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
  try { await notifySets(freshLegs); } catch { /* scores still save */ }
  const grouped = new Map();
  for (const l of freshLegs) {
    if (!grouped.has(l.slip_id)) grouped.set(l.slip_id, []);
    grouped.get(l.slip_id).push(l);
  }

  for (const slip of open) {
    const ls = grouped.get(slip.id) || [];
    const anyLost = ls.some((l) => l.won === "no");
    const allWon = ls.length > 0 && ls.every((l) => l.won === "yes");
    const anyLive = ls.some((l) => l.match_status && /^(H1|H2|HT|1H|2H|LIVE|set\s*\d|Playing|1st set|2nd set|3rd set|Q[1-4]|OT|Overtime|Pause)/i.test(l.match_status));
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

export async function dropTennisLeg(slipId, eventId, selection) {
  await ensureSlips();
  await sql`
    DELETE FROM slip_legs
    WHERE slip_id = ${slipId} AND event_id = ${eventId} AND selection = ${selection} AND sport = 'tn'`;
  const left = await sql`SELECT count(*)::int AS n FROM slip_legs WHERE slip_id = ${slipId}`;
  if (!left[0] || !left[0].n) await sql`DELETE FROM slips WHERE id = ${slipId}`;
  return { id: slipId };
}

export async function dropTennisSlip(slipId) {
  await ensureSlips();
  await sql`DELETE FROM slip_legs WHERE slip_id = ${slipId} AND sport = 'tn'`;
  const left = await sql`SELECT count(*)::int AS n FROM slip_legs WHERE slip_id = ${slipId}`;
  if (!left[0] || !left[0].n) await sql`DELETE FROM slips WHERE id = ${slipId}`;
  return { id: slipId };
}

export async function dropAllTennisBooked() {
  await ensureSlips();
  const ids = await sql`SELECT DISTINCT slip_id FROM slip_legs WHERE sport = 'tn'`;
  await sql`DELETE FROM slip_legs WHERE sport = 'tn'`;
  for (const row of ids) {
    const left = await sql`SELECT count(*)::int AS n FROM slip_legs WHERE slip_id = ${row.slip_id}`;
    if (!left[0] || !left[0].n) await sql`DELETE FROM slips WHERE id = ${row.slip_id}`;
  }
  return { n: ids.length };
}

export async function clearSlip(id) {
  await ensureSlips();
  const rows = await sql`
    UPDATE slips SET status = 'removed', settled_at = now()
    WHERE id = ${id} AND status IN ('open', 'live')
    RETURNING id`;
  if (!rows.length) throw new Error("That slip is not on the list");
  return { id };
}
