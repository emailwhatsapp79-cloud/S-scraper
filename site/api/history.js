// Stored card, no SportyBet round-trip. The clock still decides upcoming vs past.
import { sql, rowToGame, cors } from "./_db.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, "http://x");
  const scope = url.searchParams.get("scope") || "past";
  const started = Date.now();

  let rows = [];
  try {
    rows = await sql`SELECT * FROM games ORDER BY kickoff DESC NULLS LAST LIMIT 800`;
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: false, error: String(e?.message || e), games: [], count: 0, stored: 0,
    });
  }

  const now = Date.now();
  let games = rows.map(rowToGame);
  if (scope === "past") games = games.filter((g) => g.kickoff && Number(g.kickoff) <= now);
  else if (scope === "upcoming") games = games.filter((g) => g.upcoming);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    tookMs: Date.now() - started,
    stored: rows.length,
    count: games.length,
    games,
  });
}
