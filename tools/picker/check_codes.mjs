// Live check of booked SportyBet codes without our database.
process.env.DATABASE_URL ||= "postgres://u:p@localhost/db";
const { fetchEvent } = await import(process.cwd() + "/api/_card.js");
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const per = (gs) => String(gs || "").split(/\s+/).map((x) => x.match(/^(\d+):(\d+)$/)).filter(Boolean).map((m) => [+m[1], +m[2]]);
const corners = async (eid) => { try { const v = (await fetch(`https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo/match_details/${eid.replace("sr:match:", "")}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data?.values?.["124"]?.value; return v ? [+v.home, +v.away] : null; } catch { return null; } };
const evCache = new Map();
for (const code of process.argv.slice(2)) {
  const d = (await fetch(`https://www.sportybet.com/api/ng/orders/share/${code}`, { headers: H }).then((r) => r.json())).data;
  const lines = []; let won = 0, lost = 0, voided = 0, open = 0;
  for (const o of d.outcomes) {
    const m = o.markets[0], oc = m.outcomes[0], id = String(m.id);
    if (!evCache.has(o.eventId)) evCache.set(o.eventId, await fetchEvent(o.eventId, { marketId: "1" }));
    const ev = evCache.get(o.eventId) || {};
    const st = ev.matchStatus || o.matchStatus || "", ps = per(Array.isArray(ev.gameScore) ? ev.gameScore.join(" ") : ev.gameScore);
    const ended = /ended|^AP$|^AET$|after/i.test(st) || ev.status === 4 || ev.status === 3 && /ended/i.test(st);
    const line = +(/total=([\d.]+)/.exec(m.specifier || "")?.[1]), over = /^Over/.test(oc.desc);
    const reg = ps.length >= 3 ? [ps[0][0] + ps[1][0], ps[0][1] + ps[1][1]] : null;
    const ft = (ev.setScore || "").split(":").map(Number);
    let label = `${o.homeTeamName} v ${o.awayTeamName}: ${m.desc.replace(/ \[.*\]/, "")} ${oc.desc}`, res = "…", score = ev.setScore || "-";
    if (o.status === 5 || /cancel/i.test(st)) { res = "VOID"; voided++; }
    else {
      let v = null, final = false;
      const pick = (h, a, which) => which === "H" ? h : which === "A" ? a : h + a;
      const which = /^(19|69|900300)$/.test(id) ? "H" : /^(20|70|900301)$/.test(id) ? "A" : "T";
      if (/^(18|19|20)$/.test(id)) { const sc = reg || ft; v = pick(sc[0], sc[1], which); final = ended || !!reg; }
      else if (/^(68|69|70)$/.test(id)) { if (ps[0]) { v = pick(ps[0][0], ps[0][1], which); final = ps.length >= 2 || ended; score += ` (HT ${ps[0].join(":")})`; } }
      else if (/^(166|900300|900301)$/.test(id)) { const c = await corners(o.eventId); if (c) { v = pick(c[0], c[1], which); final = ended; score += ` (corners ${c.join(":")})`; } }
      if (v != null && Number.isFinite(v)) {
        const passed = v > line;
        if (passed) { res = over ? "WON" : "LOST"; }
        else if (final) { res = over ? "LOST" : "WON"; }
        else res = `live (${v} so far, line ${line})`;
      } else if (/not start/i.test(st)) res = "not started";
      if (res === "WON") won++; else if (res === "LOST") lost++; else open++;
    }
    lines.push(`  ${res.padEnd(8)} ${new Date(o.estimateStartTime + 3600e3).toISOString().slice(11, 16)} ${label} | ${st} ${score}`);
  }
  console.log(`== ${code}: ${won} won, ${lost} lost, ${voided} void, ${open} to go`);
  lines.forEach((l) => console.log(l));
}
