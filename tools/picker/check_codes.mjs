// Live check of a booked code: every selection (even ones SportyBet drops from the
// share view once live), the match minute, and the current odds of the line.
process.env.DATABASE_URL ||= "postgres://u:p@localhost/db";
const { fetchEvent } = await import(process.cwd() + "/api/_card.js");
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const per = (gs) => (Array.isArray(gs) ? gs : String(gs || "").split(/\s+/)).map((x) => String(x).match(/^(\d+):(\d+)$/)).filter(Boolean).map((m) => [+m[1], +m[2]]);
for (const code of process.argv.slice(2)) {
  const d = (await fetch(`https://www.sportybet.com/api/ng/orders/share/${code}`, { headers: H }).then((r) => r.json())).data;
  console.log(`Lagos time ${new Date(Date.now() + 3600e3).toISOString().slice(11, 16)} | ${code}`);
  const rows = [];
  for (const s of d.ticket.selections) {
    const ev = await fetchEvent(s.eventId, { marketId: "1," + s.marketId }) || {};
    const m = (ev.markets || []).filter((x) => String(x.id) === String(s.marketId) && (!s.specifier || String(x.specifier || "") === String(s.specifier))).sort((a, b) => (b.product === 1) - (a.product === 1));
    const shared = d.outcomes.find((o) => o.eventId === s.eventId);
    const mk = m[0] || shared?.markets?.[0] || {};
    const oc = (mk.outcomes || []).find((o) => String(o.id) === String(s.outcomeId)) || shared?.markets?.[0]?.outcomes?.[0] || {};
    const spec = mk.specifier || s.specifier || shared?.markets?.[0]?.specifier || "";
    const id = String(s.marketId), line = +(/total=([\d.]+)/.exec(spec)?.[1]), over = /^Over/.test(oc.desc || "");
    const st = ev.matchStatus || "", ps = per(ev.gameScore), ft = (ev.setScore || "").split(":").map(Number);
    const ended = /ended|^AP$|^AET$/i.test(st);
    const minute = ev.playedSeconds ? `${String(ev.playedSeconds).split(":")[0]}'` : "";
    const reg = ps.length >= 3 ? [ps[0][0] + ps[1][0], ps[0][1] + ps[1][1]] : null;
    const which = /^(19|69|900300)$/.test(id) ? "H" : /^(20|70|900301)$/.test(id) ? "A" : "T";
    const pick = (h, a) => which === "H" ? h : which === "A" ? a : h + a;
    let v = null, final = false, res;
    if (/cancel|postpon/i.test(st)) res = "VOID?";
    else if (/^(18|19|20)$/.test(id) && ft.length === 2 && ev.setScore) { const sc = reg || ft; v = pick(sc[0], sc[1]); final = ended || !!reg; }
    else if (/^(68|69|70)$/.test(id) && ps[0] && !/not start/i.test(st)) { v = pick(ps[0][0], ps[0][1]); final = ps.length >= 2 || ended || /^HT$/i.test(st); }
    else if (id === "10" && ft.length === 2 && ev.setScore) { const sc = reg || ft; const ok = oc.desc === "Home or Draw" ? sc[0] >= sc[1] : oc.desc === "Draw or Away" ? sc[1] >= sc[0] : sc[0] !== sc[1]; res = ended ? (ok ? "WON" : "LOST") : (ok ? "on track" : "behind"); }
    if (!res) {
      if (v == null || !Number.isFinite(v)) res = /not start/i.test(st) || !st ? "not started" : "live";
      else if (v > line) res = over ? "WON" : "LOST";
      else if (final) res = over ? "LOST" : "WON";
      else res = `on track (${v} of ${line})`;
    }
    rows.push({ t: ev.estimateStartTime || shared?.estimateStartTime, txt: `${res} | ${new Date((ev.estimateStartTime || shared?.estimateStartTime) + 3600e3).toISOString().slice(11, 16)} ${ev.homeTeamName || shared?.homeTeamName} v ${ev.awayTeamName || shared?.awayTeamName} | ${mk.desc || ""} ${oc.desc || ""} | ${st} ${minute} ${ev.setScore || ""}${ps[0] ? " (HT " + ps[0].join(":") + ")" : ""} | odds now ${oc.odds || "-"}` });
  }
  rows.sort((a, b) => a.t - b.t).forEach((r) => console.log("  " + r.txt));
}
