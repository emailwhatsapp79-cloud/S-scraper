// Proves where the fetching actually happens, and what SportyBet says to it.
// Open this from your phone: the result is about the SERVER's connection,
// not yours, which is the whole point of the page.

import { cors } from "./_db.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

async function attempt(label, url, init) {
  const started = Date.now();
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let biz = null;
    try { biz = JSON.parse(text).bizCode ?? null; } catch {}
    return {
      label, http: r.status, bizCode: biz,
      verdict: biz === 10000 ? "WORKED" : (biz === 19003 ? "REFUSED (Forbidden)" : "other"),
      body: text.slice(0, 140), ms: Date.now() - started,
    };
  } catch (e) {
    return { label, error: String(e.message || e), ms: Date.now() - started };
  }
}

export default async function handler(req, res) {
  cors(res);

  const headers = { "User-Agent": UA, Accept: "application/json" };
  const body = JSON.stringify({
    sportId: SPORT, tournamentId: "sv:league:1", marketId: "1,10,60",
    pageSize: 100, pageNum: 1, option: 1,
  });

  const tests = await Promise.all([
    attempt("GET  upcoming feed (what the site uses)",
      `${BASE}/wapConfigurableUpcomingEvents?sportId=${encodeURIComponent(SPORT)}`, { headers }),
    attempt("POST wapEvents (the full card)", `${BASE}/wapEvents`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body }),
    attempt("POST sportList (works fine over GET)", `${BASE}/sportList`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }),
  ]);

  // Where this code is actually running, versus where you are reading it from.
  let outboundIp = null;
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    outboundIp = (await r.json()).ip;
  } catch {}

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    explanation:
      "These requests were made by the server that hosts this site, not by your phone. " +
      "Your phone only asked this page for its result. That is why being in Nigeria does " +
      "not change the outcome: the request to SportyBet never leaves your device.",
    serverRegion: process.env.VERCEL_REGION || "unknown",
    serverOutboundIp: outboundIp,
    yourIp: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
    yourCountry: req.headers["x-vercel-ip-country"] || null,
    tests,
  });
}
