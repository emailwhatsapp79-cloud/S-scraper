// The collector running in your browser on sportybet.com pushes the card here.
// Nothing else can write: a push without the shared token is rejected.

import { sql, cors } from "./_db.js";

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) && n > 0 ? n : null;
};

/** Accept only what we can screen, and never trust the shape of what arrives. */
function clean(g) {
  if (!g || typeof g !== "object") return null;
  const id = String(g.id ?? g.gameId ?? "").trim();
  const ft = g.ft || {};
  const home = num(ft.home), draw = num(ft.draw), away = num(ft.away);
  if (!id || id.length > 32 || !home || !draw || !away) return null;

  const dc = g.dc || {}, ht = g.ht || {};
  return [
    id,
    String(g.eventId ?? "").slice(0, 64) || null,
    String(g.home ?? "?").slice(0, 64),
    String(g.away ?? "?").slice(0, 64),
    String(g.league ?? "").slice(0, 64),
    Number.isFinite(Number(g.kickoff)) ? Number(g.kickoff) : null,
    String(g.status ?? "").slice(0, 32),
    home, draw, away,
    num(dc.home_draw), num(dc.home_away), num(dc.draw_away),
    num(ht.home), num(ht.draw), num(ht.away),
  ];
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only" }); return; }

  const token = req.headers["x-push-token"];
  if (!process.env.PUSH_TOKEN || token !== process.env.PUSH_TOKEN) {
    res.status(401).json({ ok: false, error: "bad or missing push token" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const incoming = Array.isArray(body?.games) ? body.games : null;
  if (!incoming) { res.status(400).json({ ok: false, error: "expected { games: [...] }" }); return; }
  if (incoming.length > 2000) { res.status(413).json({ ok: false, error: "too many games in one push" }); return; }

  const rows = incoming.map(clean).filter(Boolean);
  if (!rows.length) { res.status(200).json({ ok: true, stored: 0, skipped: incoming.length }); return; }

  // Odds move, so a game seen again overwrites its prices and keeps first_seen.
  let stored = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const values = chunk.map((_, j) => {
      const b = i + j * 16;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},` +
             `$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16})`;
    }).join(",");
    await sql.query(
      `INSERT INTO games (game_id, event_id, home, away, league, kickoff, status,
         ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2, ht_home, ht_draw, ht_away)
       VALUES ${values}
       ON CONFLICT (game_id) DO UPDATE SET
         status = EXCLUDED.status, kickoff = COALESCE(EXCLUDED.kickoff, games.kickoff),
         league = COALESCE(NULLIF(EXCLUDED.league,''), games.league),
         ft_home = EXCLUDED.ft_home, ft_draw = EXCLUDED.ft_draw, ft_away = EXCLUDED.ft_away,
         dc_1x = COALESCE(EXCLUDED.dc_1x, games.dc_1x),
         dc_12 = COALESCE(EXCLUDED.dc_12, games.dc_12),
         dc_x2 = COALESCE(EXCLUDED.dc_x2, games.dc_x2),
         ht_home = COALESCE(EXCLUDED.ht_home, games.ht_home),
         ht_draw = COALESCE(EXCLUDED.ht_draw, games.ht_draw),
         ht_away = COALESCE(EXCLUDED.ht_away, games.ht_away),
         last_seen = now()`,
      chunk.flat(),
    );
    stored += chunk.length;
  }

  const [{ total }] = await sql`SELECT count(*)::int AS total FROM games`;
  res.status(200).json({ ok: true, stored, skipped: incoming.length - rows.length, total });
}
