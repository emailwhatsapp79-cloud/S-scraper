// Backfill SportyBet table-tennis results for a stretch the poller missed
// (e.g. 28 Oct - 1 Nov, when Neon's data quota ran out). SportyBet's result
// list has the final set score but no prices, so the rows are stored unpriced:
// enough for form, head-to-head, "lost today" flags and rating training.
// Run from site/ with DATABASE_URL set: node ../tools/picker/backfill_tt.mjs <fromISO> [toISO]
const { sql } = await import(process.cwd() + "/api/_db.js");
const from = Date.parse(process.argv[2]), to = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
if (!from) { console.log("usage: backfill_tt.mjs <fromISO> [toISO]"); process.exit(1); }
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const STEP = 3 * 3600e3;
let found = 0, stored = 0;
for (let t = from; t < to; t += STEP) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const u = `https://www.sportybet.com/api/ng/factsCenter/eventResultList?sportId=sr:sport:20&startTime=${t}&endTime=${Math.min(t + STEP, to)}&pageSize=100&pageNum=${page}`;
    let d = null;
    for (let i = 0; i < 3 && !d; i++) { try { d = (await fetch(u, { headers: H }).then((r) => r.json())).data; } catch { await new Promise((r) => setTimeout(r, 1500)); } }
    const evs = (d?.tournaments || []).flatMap((x) => x.events || []);
    for (const ev of evs) {
      const m = String(ev.setScore || "").match(/^(\d+):(\d+)$/);
      if (!/^end/i.test(ev.matchStatus || "") || !m || m[1] === m[2]) continue;
      const id = (String(ev.eventId).match(/^sr:match:(\d+)$/) || [])[1] || String(ev.eventId);
      rows.push({ id, ev: ev.eventId, home: ev.homeTeamName, away: ev.awayTeamName, tourn: ev.sport?.category?.tournament?.name || "", start: Number(ev.estimateStartTime), h: +m[1], a: +m[2] });
    }
    if (!evs.length || page * 100 >= Number(d?.totalNum || 0)) break;
  }
  found += rows.length;
  for (let i = 0; i < rows.length; i += 300) {
    const p = rows.slice(i, i + 300);
    const r = await sql`
      INSERT INTO tt_games (match_id, event_id, home, away, tourn, start_at, status, r_home, r_away, r_status, settled_at)
      SELECT * , 'ended', now() FROM unnest(${p.map((x) => x.id)}::text[], ${p.map((x) => x.ev)}::text[], ${p.map((x) => x.home)}::text[],
        ${p.map((x) => x.away)}::text[], ${p.map((x) => x.tourn)}::text[], ${p.map((x) => x.start)}::bigint[], ${p.map(() => "Ended")}::text[],
        ${p.map((x) => x.h)}::int[], ${p.map((x) => x.a)}::int[])
      ON CONFLICT (match_id) DO UPDATE SET
        r_home = COALESCE(tt_games.r_home, EXCLUDED.r_home), r_away = COALESCE(tt_games.r_away, EXCLUDED.r_away),
        r_status = 'ended', status = 'Ended', settled_at = COALESCE(tt_games.settled_at, now())
      RETURNING match_id`;
    stored += r.length;
  }
  console.log(new Date(t + 3600e3).toISOString().slice(5, 16), "found", rows.length);
}
console.log({ found, stored });
