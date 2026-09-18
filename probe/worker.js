// Cloudflare Worker: the same POST test, but from Cloudflare's own network
// instead of AWS. It reports which Cloudflare city it ran in (request.cf.colo)
// so the result cannot be faked or mistaken -- LOS means it ran in Lagos.
//
// This exists to answer one question: is SportyBet's POST refusal about AWS
// IP ranges, or about the request itself? If a Lagos, non-AWS IP is ALSO
// refused, then no server anywhere will work and the browser is the only way.

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

async function attempt(label, url, init) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let biz = null;
    try { biz = JSON.parse(text).bizCode ?? null; } catch {}
    return {
      label, http: r.status, bizCode: biz,
      verdict: biz === 10000 ? "WORKED" : (biz === 19003 ? "REFUSED (Forbidden)" : "other"),
      body: text.slice(0, 120), ms: Date.now() - t0,
    };
  } catch (e) {
    return { label, error: String(e), ms: Date.now() - t0 };
  }
}

export default {
  async fetch(request) {
    const cf = request.cf || {};
    const headers = { "User-Agent": UA, Accept: "application/json" };
    const body = JSON.stringify({
      sportId: SPORT, tournamentId: "sv:league:1", marketId: "1,10,60",
      pageSize: 100, pageNum: 1, option: 1,
    });

    const tests = await Promise.all([
      attempt("GET  upcoming feed",
        `${BASE}/wapConfigurableUpcomingEvents?sportId=${encodeURIComponent(SPORT)}`, { headers }),
      attempt("POST wapEvents (full card)", `${BASE}/wapEvents`,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body }),
    ]);

    const out = {
      ranInCity: cf.colo || "unknown",          // LOS = Lagos, Nigeria
      ranInCountry: cf.country || "unknown",
      note: "This ran on Cloudflare's network, at the edge nearest whoever opened " +
            "this link. Open it from your phone in Nigeria to make it run in Lagos.",
      tests,
    };
    return new Response(JSON.stringify(out, null, 2), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  },
};
