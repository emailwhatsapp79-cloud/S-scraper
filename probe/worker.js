// Probe v2: does the POST refusal depend on browser context (cookies +
// headers the site sends), or is it flat-out blocked for any POST?
// Attempt A: bare POST. Attempt B: first collect cookies from the site,
// then POST with a full browser header set + those cookies.

const HOST = "https://www.sportybet.com";
const BASE = HOST + "/api/ng/factsCenter";
const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const BODY = JSON.stringify({
  sportId: SPORT, tournamentId: "sv:league:1", marketId: "1,10,60",
  pageSize: 100, pageNum: 1, option: 1,
});

async function post(label, headers) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/wapEvents`, { method: "POST", headers, body: BODY });
    const text = await r.text();
    let biz = null;
    try { biz = JSON.parse(text).bizCode ?? null; } catch {}
    return { label, http: r.status, bizCode: biz,
      verdict: biz === 10000 ? "WORKED" : (biz === 19003 ? "REFUSED" : "other"),
      body: text.slice(0, 90), ms: Date.now() - t0 };
  } catch (e) { return { label, error: String(e), ms: Date.now() - t0 }; }
}

export default {
  async fetch(request) {
    const cf = request.cf || {};
    const base = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" };

    // Collect cookies the way a browser would, by loading the page first.
    let cookie = "";
    try {
      const home = await fetch(`${HOST}/ng/m/sport/vfootball`, { headers: { "User-Agent": UA } });
      const sc = home.headers.getSetCookie ? home.headers.getSetCookie() : [];
      cookie = sc.map((c) => c.split(";")[0]).join("; ");
    } catch {}

    const browserHeaders = {
      ...base,
      Origin: HOST,
      Referer: `${HOST}/ng/m/sport/vfootball`,
      "clientid": "wap", "operid": "2", "platform": "wap",
      "x-requested-with": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
    };

    const tests = [
      await post("A: bare POST", base),
      await post("B: POST + cookies + browser headers", browserHeaders),
    ];

    return new Response(JSON.stringify({
      ranInCity: cf.colo || "?", ranInCountry: cf.country || "?",
      gotCookies: cookie ? cookie.slice(0, 60) + "..." : "none",
      tests,
    }, null, 2), { headers: { "content-type": "application/json" } });
  },
};
