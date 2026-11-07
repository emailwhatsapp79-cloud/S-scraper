// Football market grading from a final and half-time score, shared by the
// picker (tools/picker/fb_markets.mjs rates every market on the last 10) and
// Vantage (grades any booked leg once the match is over). One copy, so a
// market is judged the same way when it is picked and when it is settled.
// A game seen from the fixture: H/A = home/away side goals, hH/hA = half-time.
const res = (H, A) => (H > A ? "H" : H < A ? "A" : "D");
const side = { Home: "H", Draw: "D", Away: "A" };
const dc = { "Home or Draw": "HD", "Home/Draw": "HD", "Home or Away": "HA", "Home/Away": "HA", "Draw or Away": "DA", "Draw/Away": "DA" };
const inDc = (k, r) => k.includes(r);
const ou = (txt, v) => { const m = /^(Over|Under) ([\d.]+)$/.exec(txt.trim()); return m ? (m[1] === "Over" ? v > +m[2] : v < +m[2]) : null; };
const range = (txt, v) => {
  txt = txt.trim();
  if (/^no goal$/i.test(txt)) return v === 0;
  let m = /^(\d+)\+$/.exec(txt); if (m) return v >= +m[1];
  m = /^(\d+)-(\d+)\+$/.exec(txt); if (m) return v >= +m[1];
  m = /^(\d+)-(\d+)$/.exec(txt); if (m) return v >= +m[1] && v <= +m[2];
  m = /^(\d+)$/.exec(txt); if (m) return v === +m[1];
  return null;
};
const yes = (o) => o.desc === "Yes";

// Returns (game) => true/false/null for one outcome, or null if not judged.
export function judge(m, o) {
  const id = String(m.id), d = o.desc, tot = +((/total=([\d.]+)/.exec(m.specifier || "") || [])[1]);
  const h2 = (g) => (g.hH == null ? null : [g.H - g.hH, g.A - g.hA]);
  switch (id) {
    case "1": return side[d] ? (g) => res(g.H, g.A) === side[d] : null;
    case "10": return dc[d] ? (g) => inDc(dc[d], res(g.H, g.A)) : null;
    case "60100": case "60200": // 2UP / 1UP: judged as a straight win (it pays at least that often)
      return d === "Home" || d === "Away" ? (g) => res(g.H, g.A) === side[d] : null;
    case "18": return (g) => ou(d, g.H + g.A);
    case "19": return (g) => ou(d, g.H);
    case "20": return (g) => ou(d, g.A);
    case "68": return (g) => (g.hH == null ? null : ou(d, g.hH + g.hA));
    case "69": return (g) => (g.hH == null ? null : ou(d, g.hH));
    case "70": return (g) => (g.hH == null ? null : ou(d, g.hA));
    case "90": return (g) => { const s = h2(g); return s ? ou(d, s[0] + s[1]) : null; };
    case "91": return (g) => { const s = h2(g); return s ? ou(d, s[0]) : null; };
    case "92": return (g) => { const s = h2(g); return s ? ou(d, s[1]) : null; };
    case "29": return (g) => (g.H > 0 && g.A > 0) === yes(o);
    case "75": return (g) => (g.hH == null ? null : (g.hH > 0 && g.hA > 0) === yes(o));
    case "95": return (g) => { const s = h2(g); return s ? (s[0] > 0 && s[1] > 0) === yes(o) : null; };
    case "60": return side[d] ? (g) => (g.hH == null ? null : res(g.hH, g.hA) === side[d]) : null;
    case "63": return dc[d] ? (g) => (g.hH == null ? null : inDc(dc[d], res(g.hH, g.hA))) : null;
    case "83": return side[d] ? (g) => { const s = h2(g); return s ? res(s[0], s[1]) === side[d] : null; } : null;
    case "85": return dc[d] ? (g) => { const s = h2(g); return s ? inDc(dc[d], res(s[0], s[1])) : null; } : null;
    case "37": case "547": { // 1X2 / double chance & over/under
      const [a, b] = d.split(" & "); if (!b) return null;
      const r = id === "37" ? (side[a] ? (x) => x === side[a] : null) : dc[a] ? (x) => inDc(dc[a], x) : null;
      return r ? (g) => r(res(g.H, g.A)) && ou(b, g.H + g.A) : null;
    }
    case "35": case "546": { // 1X2 / double chance & GG/NG
      const [a, b] = d.split(" & "); if (!b) return null;
      const r = id === "35" ? (side[a] ? (x) => x === side[a] : null) : dc[a] ? (x) => inDc(dc[a], x) : null;
      const gg = /^yes$/i.test(b);
      return r ? (g) => r(res(g.H, g.A)) && (g.H > 0 && g.A > 0) === gg : null;
    }
    case "36": { const [a, b] = d.split(" & "); return b ? (g) => ou(a, g.H + g.A) && (g.H > 0 && g.A > 0) === /^yes$/i.test(b) : null; }
    case "854": case "855": case "856": case "857": case "858": case "859": {
      const who = { 854: "H", 855: "H", 856: "D", 857: "D", 858: "A", 859: "A" }[id], over = ["854", "856", "858"].includes(id);
      return (g) => (res(g.H, g.A) === who || (over ? g.H + g.A > tot : g.H + g.A < tot)) === yes(o);
    }
    case "860": case "861": case "862": { const who = { 860: "H", 861: "D", 862: "A" }[id]; return (g) => (res(g.H, g.A) === who || (g.H > 0 && g.A > 0)) === yes(o); }
    case "863": case "864": case "865": { const who = { 863: "H", 864: "D", 865: "A" }[id]; return (g) => (res(g.H, g.A) === who || g.H === 0 || g.A === 0) === yes(o); }
    case "548": case "25": case "450001": return (g) => range(d, g.H + g.A);
    case "549": case "450002": return (g) => range(d, g.H);
    case "550": case "450003": return (g) => range(d, g.A);
    case "552": case "810001": return (g) => (g.hH == null ? null : range(d, g.hH + g.hA));
    case "553": return (g) => { const s = h2(g); return s ? range(d, s[0] + s[1]) : null; };
    case "450004": case "450005": case "450006": { // "excluded number of goals": wins if the count is NOT that
      const v = (g) => (id === "450004" ? g.H + g.A : id === "450005" ? g.H : g.A);
      return (g) => { const r = range(d, v(g)); return r == null ? null : !r; };
    }
    case "31": return (g) => (g.A === 0) === yes(o);
    case "32": return (g) => (g.H === 0) === yes(o);
    case "33": return (g) => (g.H > g.A && g.A === 0) === yes(o);
    case "34": return (g) => (g.A > g.H && g.H === 0) === yes(o);
    case "30": return (g) => ({ None: g.H === 0 && g.A === 0, "Only Home": g.H > 0 && g.A === 0, "Only Away": g.A > 0 && g.H === 0, "Both teams": g.H > 0 && g.A > 0 })[d] ?? null;
    case "48": case "49": case "50": case "51": {
      const me = id === "48" || id === "50" ? 0 : 1, both = id === "48" || id === "49";
      return (g) => { const s = h2(g); if (!s) return null; const w1 = me ? g.hA > g.hH : g.hH > g.hA, w2 = me ? s[1] > s[0] : s[0] > s[1]; return (both ? w1 && w2 : w1 || w2) === yes(o); };
    }
    case "900984": return (g) => { const s = h2(g); return s ? (g.hH + g.hA > 0 && s[0] + s[1] > 0) === yes(o) : null; };
    case "56": return (g) => { const s = h2(g); return s ? (g.hH > 0 && s[0] > 0) === yes(o) : null; };
    case "57": return (g) => { const s = h2(g); return s ? (g.hA > 0 && s[1] > 0) === yes(o) : null; };
    case "14": { // European handicap "Home (0:1)"
      const mm = /^(Home|Draw|Away) \((\d+):(\d+)\)$/.exec(d); if (!mm) return null;
      return (g) => res(g.H + +mm[2], g.A + +mm[3]) === side[mm[1]];
    }
    case "16": { // Asian handicap, half lines only (no refunds)
      const mm = /^(Home|Away) \(([+-]?\d+\.5)\)$/.exec(d); if (!mm) return null;
      return (g) => (mm[1] === "Home" ? g.H + +mm[2] > g.A : g.A + +mm[2] > g.H);
    }
  }
  return null;
}


// A booked leg saved as "M|<market id>|<specifier>|<outcome>": true / false
// once the score settles it, null if it can't be judged (no half-time score).
export function gradeMarketSel(sel, score) {
  const p = String(sel || "").split("|");
  if (p[0] !== "M" || p.length < 4) return null;
  const f = judge({ id: p[1], specifier: p[2], desc: "" }, { desc: p.slice(3).join("|") });
  if (!f || score?.H == null || score?.A == null) return null;
  const v = f(score);
  return v == null ? null : !!v;
}
