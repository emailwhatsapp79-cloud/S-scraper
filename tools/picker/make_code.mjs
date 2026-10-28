const { listUpcomingTT } = await import(process.cwd() + "/api/_tt.js");
const { priceLeg } = await import(process.cwd() + "/api/_fc.js");
const { shareSelections } = await import(process.cwd() + "/api/_share.js");
const picks = (process.argv[2] || "").split(";");
const games = await listUpcomingTT(400);
const { annotateWatch } = await import(process.cwd() + "/api/_tt_watch.js");
await annotateWatch(games);
const { fetchTennisCard } = await import(process.cwd() + "/api/_tennis.js");
for (const t of await fetchTennisCard()) games.push({ ...t, tourn: t.tourn || t.league, sport: "tn" });
const TNW = (await import("node:fs")).readFileSync(new URL("./tn_watch.txt", import.meta.url), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const legs = [];
const used = new Set(); // rule (24 Oct, WTCVHB): never the same player in two legs
for (const p of picks) {
  const [me, opp] = p.split("|");
  const g = games.find((x) => (x.home === me && x.away.startsWith(opp)) || (x.away === me && x.home.startsWith(opp)));
  if (!g) { console.log("MISSING", p); continue; }
  if ((g.warn || []).some((w) => !w.pick && !w.hot)) { console.log("REFUSED (watch list / warning)", me, "v", opp, "-", g.warn.map((w) => w.name + ": " + w.text).join("; ")); continue; }
  if (g.sport === "tn" && TNW.some((n) => g.home === n || g.away === n)) { console.log("REFUSED (tennis watch list)", g.home, "v", g.away); continue; }
  if (!process.env.ALLOW_SAME && (used.has(g.home) || used.has(g.away))) { console.log("REFUSED (player already on this slip)", g.home, "v", g.away); continue; }
  used.add(g.home); used.add(g.away);
  const sel = g.home === me ? "1" : "2";
  if (!process.env.ALLOW_LOW && Number(sel === "1" ? g.win.home : g.win.away) < 1.2) { console.log("REFUSED (under 1.20)", me); continue; }
  if (!process.env.ALLOW_HIGH && Number(sel === "1" ? g.win.home : g.win.away) >= 1.4) { console.log("REFUSED (1.40 or more)", me); continue; }
  const leg = { id: g.id, eventId: g.eventId, home: g.home, away: g.away, league: g.tourn, sport: g.sport || "tt", selection: sel, price: Number(sel === "1" ? g.win.home : g.win.away) };
  try { legs.push(await priceLeg(leg, "sporty", { keep: true })); console.log("OK", me, "@", legs.at(-1).price, new Date(g.start + 3600e3).toISOString().slice(11, 16), "Lagos"); }
  catch (e) { console.log("FAIL", me, e.message); }
}
const total = legs.reduce((a, l) => a * Number(l.price), 1);
const r = await shareSelections(legs, "sporty");
console.log({ legs: legs.length, totalOdds: total.toFixed(2), payoutOn900: Math.round(900 * total), ...r });
