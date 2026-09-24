const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";
const SPORT = "sr:sport:202120001";
const LEAGUES = ["sv:league:1","sv:league:2","sv:league:3","sv:league:4","sv:league:5"];
const BASES = [
  ["SportyBet","https://www.sportybet.com"],
  ["Football.com","https://www.football.com"],
];

const wanted = {
  "1X2": { home:"Home", draw:"Draw", away:"Away" },
  "Double Chance": { homeDraw:"Home or Draw", homeAway:"Home or Away", drawAway:"Draw or Away" },
};

async function getJson(url, headers={}) {
  const r = await fetch(url, {headers:{...headers,"User-Agent":UA,Accept:"application/json"}});
  const text = await r.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${r.status} ${url} ${text.slice(0,200)}`);
  if (body.bizCode !== 10000) throw new Error(`bizCode=${body.bizCode} ${body.message||body.innerMsg||""}`);
  return body.data;
}

function pickMarket(markets, desc) {
  const list = (markets || []).filter(m => String(m.desc||"") === desc);
  if (!list.length) return null;
  return list.slice().sort((a,b) => {
    const la = a.product === 1 ? 1 : 0, lb = b.product === 1 ? 1 : 0;
    if (la !== lb) return lb-la;
    return (Number(b.lastOddsChangeTime)||0) - (Number(a.lastOddsChangeTime)||0);
  })[0];
}

function refs(market) {
  if (!market) return {};
  const out = {};
  for (const o of market.outcomes || []) {
    const odds = Number(o.odds);
    const id = String(o.id || o.outcomeId || "");
    if (id && Number.isFinite(odds) && odds > 1) out[String(o.desc)] = {marketId:String(market.id||market.marketId||""),outcomeId:id,odds};
  }
  return out;
}

function findEvent(node) {
  if (Array.isArray(node)) for (const x of node) { const e=findEvent(x); if(e) return e; }
  if (!node || typeof node !== "object") return null;
  if (node.gameId && node.homeTeamName && Array.isArray(node.markets)) return node;
  for (const v of Object.values(node)) { const e=findEvent(v); if(e) return e; }
  return null;
}

async function findSelection(base) {
  for (const league of LEAGUES) {
    const url = new URL(base + "/api/ng/factsCenter/pcUpcomingEvents");
    url.search = new URLSearchParams({
      sportId:SPORT,tournamentId:league,marketId:"1,10,60",option:"2",
      timeline:"168",pageSize:"100",pageNum:"1"
    });
    try {
      const data = await getJson(url.toString());
      const events = [];
      const walk = n => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        if (n.gameId && n.homeTeamName && Array.isArray(n.markets)) events.push(n);
        for (const v of Object.values(n)) walk(v);
      };
      walk(data);
      for (const ev of events) {
        const ft = refs(pickMarket(ev.markets,"1X2"));
        if (ft.Home && ft.Draw && ft.Away && ev.eventId) {
          return {eventId:String(ev.eventId),home:ev.homeTeamName,away:ev.awayTeamName,
            marketId:ft.Home.marketId,outcomeId:ft.Home.outcomeId,odds:ft.Home.odds,
            all:{home:ft.Home,draw:ft.Draw,away:ft.Away}};
        }
      }
    } catch (e) {
      console.log(`[${base}] ${league}: ${e.message}`);
    }
  }
  throw new Error("No usable 1X2 event found");
}

async function share(base, selection, football) {
  const headers = {
    "User-Agent":UA,Accept:"application/json, text/plain, */*",
    "Content-Type":"application/json;charset=UTF-8",
    Origin:base,Referer:base+"/ng/",
    ...(football ? {Platform:"wap",ClientId:"wap",OperId:"8"} : {})
  };
  const payload = {selections:[{
    eventId:selection.eventId,marketId:selection.marketId,outcomeId:selection.outcomeId,
    odds:String(selection.odds)
  }]};
  const r = await fetch(base+"/api/ng/orders/share",{method:"POST",headers,body:JSON.stringify(payload)});
  const body = await r.json().catch(()=>({}));
  if (body.bizCode !== 10000 || !body.data?.shareCode) throw new Error(`share failed HTTP ${r.status}: ${JSON.stringify(body).slice(0,500)}`);
  const code = body.data.shareCode;
  const loaded = await fetch(base+"/api/ng/orders/share/"+encodeURIComponent(code),{headers}).then(x=>x.json()).catch(()=>({}));
  const outcomes = loaded?.data?.outcomes || [];
  const exact = outcomes.some(o =>
    String(o.eventId||"") === String(selection.eventId) &&
    String(o.marketId||"") === String(selection.marketId) &&
    String(o.outcomeId||"") === String(selection.outcomeId)
  );
  if (loaded.bizCode !== 10000 || !outcomes.length || !exact) {
    throw new Error(`share code did not round-trip exact selection: code=${code} loaded=${JSON.stringify(loaded).slice(0,1200)}`);
  }
  return {code, loadedOutcomes:outcomes.length};
}

for (const [name,base] of BASES) {
  console.log("\n== "+name+" ==");
  const s = await findSelection(base);
  console.log("Selected:", JSON.stringify(s));
  const result = await share(base,s,name==="Football.com");
  console.log("PASS share/load:", JSON.stringify(result));
}
console.log("\nALL BOOKING-CODE TESTS PASSED. No wager was placed.");
