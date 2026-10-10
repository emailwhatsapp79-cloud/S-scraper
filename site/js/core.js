(function (w) {
  "use strict";

  // If we were unlocked recently, reveal the app at once so a normal refresh
  // doesn't blink dark; gateCheck still verifies with the server a moment later.
  // A locked (or expired) session leaves the app hidden until the gate confirms.
  try {
    var _openUntil = Number(localStorage.getItem("vfs_open_until") || 0);
    if (_openUntil && Date.now() < _openUntil) document.documentElement.classList.add("gate-ok");
  } catch (e) {}
  function markOpen(ms) {
    try { localStorage.setItem("vfs_open_until", String(Date.now() + (Number(ms) || 0))); } catch (e) {}
    document.documentElement.classList.add("gate-ok");
  }
  function markLocked() {
    try { localStorage.removeItem("vfs_open_until"); } catch (e) {}
    document.documentElement.classList.remove("gate-ok");
  }

  var DEFAULTS = {
    ft_fav_min: 1.50, ft_fav_max: 2.50, ft_dog_min: 3.70,
    ft_dc_fav_min: 1.17, ft_dc_fav_max: 1.30, ft_dc_dog_min: 1.89,
    ht_fav_min: 1.50, ht_fav_max: 3.50, ht_ratio_min: 1.70
  };
  var LABELS = {
    ft_fav_min: "FT favourite from", ft_fav_max: "FT favourite to", ft_dog_min: "FT other side min",
    ft_dc_fav_min: "FT fav DC from", ft_dc_fav_max: "FT fav DC to", ft_dc_dog_min: "FT other DC min",
    ht_fav_min: "HT favourite from", ht_fav_max: "HT favourite to", ht_ratio_min: "HT other side ×"
  };

  var cfg = Object.assign({}, DEFAULTS);
  try {
    var stored = JSON.parse(localStorage.getItem("vfs") || "null");
    if (stored) Object.keys(DEFAULTS).forEach(function (k) {
      if (typeof stored[k] === "number") cfg[k] = stored[k];
    });
  } catch (e) {}

  function saveLocal() {
    try { localStorage.setItem("vfs", JSON.stringify(cfg)); } catch (e) {}
  }

  function save() {
    saveLocal();
    fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shape: cfg })
    }).catch(function () {});
  }

  function el(t, c, x) {
    var n = document.createElement(t);
    if (c) n.className = c;
    if (x != null) n.textContent = x;
    return n;
  }

  function combine(a, b) { return Math.round(100 / (1 / a + 1 / b)) / 100; }

  function n(v) {
    var x = Number(v);
    return isFinite(x) ? x : null;
  }

  function band(name, v, lo, hi, what) {
    if (v == null) return { name: name, ok: false, skip: true, text: what + " not loaded" };
    var ok = v >= lo && v <= hi;
    return { name: name, ok: ok, skip: false,
      text: what + " " + v.toFixed(2) + (ok ? " in " : " outside ") + lo.toFixed(2) + "–" + hi.toFixed(2) };
  }
  function floor(name, v, lo, what) {
    if (v == null) return { name: name, ok: false, skip: true, text: what + " not loaded" };
    var ok = v >= lo;
    return { name: name, ok: ok, skip: false,
      text: what + " " + v.toFixed(2) + (ok ? " \u2265 " : " < ") + lo.toFixed(2) };
  }

  function screen(g) {
    var ft = g.ft || {};
    var fh = n(ft.home), fd = n(ft.draw), fa = n(ft.away);
    if (fh == null || fd == null || fa == null) {
      return {
        ev: g, dc: null, fav: "home", dog: "away",
        checks: [{ name: "ft", ok: false, skip: false, text: "full-time odds not loaded" }],
        failure: { text: "full-time odds not loaded" },
        verdict: "reject"
      };
    }
    var raw = g.dc || {
      home_draw: combine(fh, fd),
      home_away: combine(fh, fa),
      draw_away: combine(fd, fa)
    };
    var dc = {
      home_draw: n(raw.home_draw),
      home_away: n(raw.home_away),
      draw_away: n(raw.draw_away)
    };
    var fav = fh <= fa ? "home" : "away";
    var dog = fav === "home" ? "away" : "home";
    var ftMap = { home: fh, draw: fd, away: fa };
    var favDC = fav === "home" ? dc.home_draw : dc.draw_away;
    var dogDC = dog === "home" ? dc.home_draw : dc.draw_away;
    var checks = [
      band("ft_fav", ftMap[fav], cfg.ft_fav_min, cfg.ft_fav_max, "FT " + fav),
      floor("ft_dog", ftMap[dog], cfg.ft_dog_min, "FT " + dog),
      band("ft_dc_fav", favDC, cfg.ft_dc_fav_min, cfg.ft_dc_fav_max, "FT " + (fav === "home" ? "1X" : "X2")),
      floor("ft_dc_dog", dogDC, cfg.ft_dc_dog_min, "FT " + (dog === "home" ? "1X" : "X2"))
    ];
    if (!g.ht) {
      checks.push({ name: "ht_fav", ok: false, skip: true, text: "half-time odds not loaded" });
      checks.push({ name: "ht_split", ok: false, skip: true, text: "half-time odds not loaded" });
    } else {
      var hf = n(g.ht[fav]), hd = n(g.ht[dog]), ratio = (hf && hd) ? hd / hf : null;
      checks.push(band("ht_fav", hf, cfg.ht_fav_min, cfg.ht_fav_max, "HT " + fav));
      checks.push({
        name: "ht_split", ok: ratio != null && ratio >= cfg.ht_ratio_min, skip: ratio == null,
        text: ratio == null ? "half-time split not loaded" : ("HT " + dog + " is " + ratio.toFixed(2) + "\u00d7 HT " + fav)
      });
    }
    var failed = null, skipped = false;
    checks.forEach(function (c) {
      if (c.skip) skipped = true;
      else if (!c.ok && !failed) failed = c;
    });
    return {
      ev: g, dc: dc, fav: fav, dog: dog, checks: checks, failure: failed,
      verdict: failed ? "reject" : (skipped ? "hold" : "show")
    };
  }

  // Strong / Good: how firmly our number backs one side next to the book.
  // ours and book are the % on our side; n is the fewer games either player
  // has on record (null when the sport doesn't count them). It is the model's
  // confidence, not a promise of profit: each page shows its record beside it.
  // bar lifts both cut-offs for a sport whose favourites run shorter.
  function strength(ours, book, n, bar) {
    ours = Number(ours); book = Number(book);
    var s = (bar && bar.strong) || 65, g = (bar && bar.good) || 60;
    if (!isFinite(ours) || !isFinite(book) || book < 50) return null;
    if (ours >= s && ours - book >= 3 && (n == null || n >= 30)) return "strong";
    if (ours >= g && ours - book >= 0 && (n == null || n >= 15)) return "good";
    return null;
  }
  function strengthTag(level) {
    return el("span", "str " + level, level === "strong" ? "Strong" : level === "good" ? "Good" : "Lean");
  }

  function makePick(g, selection, price, label) {
    return {
      id: g.id,
      eventId: g.eventId || null,
      home: g.home,
      away: g.away,
      league: g.league || "",
      kickoff: g.kickoff || null,
      selection: selection,
      label: label,
      price: Number(price),
      source: g.source || "",
      sport: g.sport || "",
      marketId: g.selectionRefs && g.selectionRefs[selection] ? g.selectionRefs[selection].marketId : null,
      outcomeId: g.selectionRefs && g.selectionRefs[selection] ? g.selectionRefs[selection].outcomeId : null,
      specifier: g.selectionRefs && g.selectionRefs[selection] ? (g.selectionRefs[selection].specifier || "") : "",
      probability: g.selectionRefs && g.selectionRefs[selection] ? (g.selectionRefs[selection].probability || "") : ""
    };
  }

  function bookLeg(id) {
    return loadBook().filter(function (l) { return l.id === id; })[0] || null;
  }

  function favPick(g, r) {
    r = r || screen(g);
    if (!r || r.verdict !== "show" || !r.dc) return null;
    var sel = r.fav === "home" ? "1X" : "X2";
    var price = r.fav === "home" ? r.dc.home_draw : r.dc.draw_away;
    var label = r.fav === "home" ? "Home or Draw" : "Draw or Away";
    if (!(price > 1)) return null;
    var p = makePick(g, sel, price, label);
    return attachRate(p, g, r);
  }

  // Ready-to-book follows the slips you actually tap, not "shortest favourite
  // wins". Your VF books sit at 1.20–1.30 1X/X2 across England/Spain/Italy/
  // Germany/France. A Chelsea 1.60 vs a 5.00 is the trap those packs used to
  // dump on top — the 1.60 still loses the match often enough to kill an acca.
  var STYLE_DC_LO = 1.20;
  var STYLE_DC_HI = 1.30;
  var STYLE_DC_AIM = 1.25;
  var TRAP_FAV = 1.65;
  var TRAP_DOG = 5.00;

  function stylePick(g) {
    var ft = (g && g.ft) || {};
    var fh = n(ft.home), fd = n(ft.draw), fa = n(ft.away);
    if (fh == null || fd == null || fa == null) return null;
    var raw = g.dc || {
      home_draw: combine(fh, fd),
      draw_away: combine(fd, fa)
    };
    var hd = n(raw.home_draw), da = n(raw.draw_away);
    if (!(hd > 1) || !(da > 1)) return null;
    var favO = fh <= fa ? fh : fa;
    var dogO = fh <= fa ? fa : fh;
    if (favO <= TRAP_FAV && dogO >= TRAP_DOG) return null;
    var cands = [];
    if (hd >= STYLE_DC_LO && hd <= STYLE_DC_HI) {
      cands.push({ sel: "1X", price: hd, label: "Home or Draw" });
    }
    if (da >= STYLE_DC_LO && da <= STYLE_DC_HI) {
      cands.push({ sel: "X2", price: da, label: "Draw or Away" });
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) {
      return Math.abs(a.price - STYLE_DC_AIM) - Math.abs(b.price - STYLE_DC_AIM);
    });
    var c = cands[0];
    var p = makePick(g, c.sel, c.price, c.label);
    return attachRate(p, g);
  }

  var USED_KEY = "vfs_used_legs";

  function loadUsed() {
    try {
      var rows = JSON.parse(localStorage.getItem(USED_KEY) || "[]") || [];
      var now = Date.now();
      return rows.filter(function (r) {
        if (!r || !r.id) return false;
        var ko = Number(r.kickoff) || 0;
        return !ko || ko > now - 2 * 3600000;
      });
    } catch (e) { return []; }
  }

  function saveUsed(rows) {
    try { localStorage.setItem(USED_KEY, JSON.stringify(rows || [])); } catch (e) {}
    return rows;
  }

  function markUsed(legs) {
    var rows = loadUsed();
    (legs || []).forEach(function (l) {
      var id = l && (l.id || l.gameId);
      if (!id) return;
      if (rows.some(function (r) { return r.id === id; })) return;
      rows.push({
        id: id,
        eventId: l.eventId || null,
        kickoff: l.kickoff || 0
      });
    });
    saveUsed(rows);
    return usedMap(rows);
  }

  function usedMap(rows) {
    var t = {};
    (rows || loadUsed()).forEach(function (r) {
      if (r.id) t[r.id] = 1;
      if (r.eventId) t[r.eventId] = 1;
    });
    loadBook().forEach(function (l) {
      if (l.id) t[l.id] = 1;
      if (l.eventId) t[l.eventId] = 1;
    });
    return t;
  }

  function mergeUsedFromSlips(slips) {
    var extra = [];
    (slips || []).forEach(function (s) {
      if (s.status !== "open" && s.status !== "live") return;
      (s.legs || []).forEach(function (l) {
        extra.push({
          id: l.gameId || l.id,
          eventId: l.eventId || null,
          kickoff: l.kickoff || 0
        });
      });
    });
    if (extra.length) markUsed(extra);
    return usedMap();
  }

  function isUsed(g, taken) {
    taken = taken || usedMap();
    if (!g) return false;
    if (g.id && taken[g.id]) return true;
    if (g.eventId && taken[g.eventId]) return true;
    return false;
  }

  // Book-implied chances for the pick we actually book (1X / X2) and for the
  // favourite winning the match. Home 1.80 is ~50–55% to WIN — that is why
  // those cut if you treat them as locks. Double chance is the ~75–82% number.
  // History on this screen: 162/203 SHOW games, 79.8% DC hit, break-even 80%.
  var SCREEN_HIT = 0.798;

  function rateGame(g, r) {
    r = r || (g ? screen(g) : null);
    var ft = (g && g.ft) || {};
    var fh = n(ft.home), fd = n(ft.draw), fa = n(ft.away);
    if (fh == null || fd == null || fa == null) return null;
    var fav = (r && r.fav) || (fh <= fa ? "home" : "away");
    var favOdds = fav === "home" ? fh : fa;
    var dogOdds = fav === "home" ? fa : fh;
    var ih = 1 / fh, idd = 1 / fd, ia = 1 / fa;
    var sum = ih + idd + ia;
    var pH = ih / sum, pD = idd / sum, pA = ia / sum;
    var pWin = fav === "home" ? pH : pA;
    var pDog = fav === "home" ? pA : pH;
    var pDC = pWin + pD;
    var dcPrice = r && r.dc ? (fav === "home" ? n(r.dc.home_draw) : n(r.dc.draw_away)) : null;
    var implied = dcPrice > 1 ? 1 / dcPrice : pDC;
    // Grade the double-chance, not the 1.80-vs-5 gap. On 203 graded SHOWs,
    // pDC ≥ 0.79 landed 87%; the mid band was the one that cut.
    var grade = "low";
    if (pDC >= 0.79) grade = "high";
    else if (pDC >= 0.77) grade = "mid";
    var juice = implied - pDC;
    var score = pDC * 100 - (juice > 0 ? juice * 40 : 0);
    return {
      fav: fav,
      favOdds: favOdds,
      dogOdds: dogOdds,
      drawOdds: fd,
      pWin: pWin,
      pDog: pDog,
      pDraw: pD,
      pDC: pDC,
      implied: implied,
      juice: juice,
      grade: grade,
      score: score,
      pct: Math.round(pDC * 100),
      winPct: Math.round(pWin * 100),
      dogPct: Math.round(pDog * 100)
    };
  }

  function attachRate(p, g, r) {
    var rt = rateGame(g, r);
    if (!rt) {
      p.ftFav = g && g.ft && r ? g.ft[r.fav] : null;
      return p;
    }
    p.ftFav = rt.favOdds;
    p.ftDog = rt.dogOdds;
    p.ftDraw = rt.drawOdds;
    p.pDC = rt.pDC;
    p.pWin = rt.pWin;
    p.pDog = rt.pDog;
    p.grade = rt.grade;
    p.score = rt.score;
    p.pct = rt.pct;
    p.winPct = rt.winPct;
    p.dogPct = rt.dogPct;
    return p;
  }

  function packHit(legs) {
    var book = 1, i;
    for (i = 0; i < (legs || []).length; i++) {
      var p = legs[i].pDC;
      if (!(p > 0 && p < 1)) p = legs[i].price > 1 ? 1 / legs[i].price : 0;
      book *= p;
    }
    var n = (legs || []).length;
    return {
      book: book,
      screen: Math.pow(SCREEN_HIT, n),
      n: n,
      pct: Math.round(book * 100)
    };
  }

  function teamKey(s) { return String(s || "").toUpperCase().trim(); }

  var SLOT_MS = 120000;

  function stakeOf() {
    try {
      var s = parseFloat(localStorage.getItem("vfs_stake"));
      if (isFinite(s) && s > 0) return s;
    } catch (e) {}
    return 100;
  }

  // Packs mix leagues and 1X/X2 the way the booked slips do. Kick-off order,
  // not shortest favourite. One slot, no team twice, at least `gapMin` apart.
  function spreadPack(games, n, opts) {
    opts = opts || {};
    n = Number(n) || 0;
    var gapMin = opts.gapMin != null ? opts.gapMin : 6;
    var soonMin = opts.soonMin != null ? opts.soonMin : 3;
    var taken = opts.taken || usedMap();
    var now = Date.now();
    var pool = [];
    (games || []).forEach(function (g) {
      var ko = Number(g.kickoff) || 0;
      if (!ko || ko < now + soonMin * 60000) return;
      if (isUsed(g, taken)) return;
      var p = favPick(g);
      if (p) pool.push(p);
    });

    function clash(out, p, gap) {
      var ko = Number(p.kickoff);
      return out.some(function (x) {
        return Math.abs(Number(x.kickoff) - ko) < Math.max(SLOT_MS, gap * 60000);
      });
    }

    function fill(gap, reuseTeam) {
      var out = [];
      var teams = {};
      var leagues = {};
      var sides = { "1X": 0, "X2": 0 };
      var left = pool.slice();
      while (out.length < n && left.length) {
        left.sort(function (a, b) {
          var la = leagues[leagueKey(a)] || 0;
          var lb = leagues[leagueKey(b)] || 0;
          if (la !== lb) return la - lb;
          var sa = sides[a.selection] || 0;
          var sb = sides[b.selection] || 0;
          if (sa !== sb) return sa - sb;
          return byKick(a, b);
        });
        var hit = -1;
        for (var i = 0; i < left.length; i++) {
          var p = left[i];
          if (clash(out, p, gap)) continue;
          var h = teamKey(p.home), aw = teamKey(p.away);
          if (!reuseTeam && (teams[h] || teams[aw])) continue;
          hit = i;
          break;
        }
        if (hit < 0) break;
        var pick = left.splice(hit, 1)[0];
        out.push(pick);
        teams[teamKey(pick.home)] = 1;
        teams[teamKey(pick.away)] = 1;
        var lk = leagueKey(pick);
        leagues[lk] = (leagues[lk] || 0) + 1;
        sides[pick.selection] = (sides[pick.selection] || 0) + 1;
      }
      out.sort(byKick);
      return out;
    }

    var got = fill(gapMin, false);
    if (got.length < n) got = fill(4, false);
    if (got.length < n) got = fill(2, false);
    if (got.length < n) got = fill(2, true);
    return got.slice(0, n);
  }

  // Style-band games that kick off within two minutes of each other.
  // Packs take one from a cluster and skip the rest — this is what not to stack.
  function sameSlotClusters(games, opts) {
    opts = opts || {};
    var soonMin = opts.soonMin != null ? opts.soonMin : 4;
    var taken = opts.taken || usedMap();
    var now = Date.now();
    var pool = [];
    (games || []).forEach(function (g) {
      var ko = Number(g.kickoff) || 0;
      if (!ko || ko < now + soonMin * 60000) return;
      if (isUsed(g, taken)) return;
      var p = favPick(g);
      if (p) pool.push(p);
    });
    pool.sort(byKick);
    var out = [];
    var i = 0;
    while (i < pool.length) {
      var ko = Number(pool[i].kickoff);
      var cluster = [pool[i]];
      var j = i + 1;
      while (j < pool.length && Math.abs(Number(pool[j].kickoff) - ko) < SLOT_MS) {
        cluster.push(pool[j]); j++;
      }
      i = j;
      if (cluster.length >= 2) out.push(cluster);
    }
    return out;
  }

  function bookLegs(legs, stake, extra) {
    extra = extra || {};
    var n = Number(stake);
    if (!(n > 0)) n = stakeOf();
    return fetch("/api/slips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stake: n,
        book: (legs || []).some(function (l) { return l.source === "football"; }) ? "football" : "",
        pay: extra.pay || "",
        giftId: extra.giftId || "",
        legs: (legs || []).map(function (l) {
          return {
            gameId: l.id || l.gameId,
            eventId: l.eventId,
            selection: l.selection,
            home: l.home, away: l.away, league: l.league,
            price: l.price, kickoff: l.kickoff,
            label: l.label || "",
            source: l.source || "",
            sport: l.sport || "",
            marketId: l.marketId || null,
            outcomeId: l.outcomeId || null,
            specifier: l.specifier || "",
            probability: l.probability || ""
          };
        })
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || "Could not book");
      markUsed(legs);
      return d.slip;
    });
  }

  function acca(prices) {
    var n = 1;
    prices.forEach(function (p) { n *= Number(p); });
    return Math.round(n * 100) / 100;
  }

  var BOOK_KEY = "vfs_book";
  function loadBook() {
    try { return JSON.parse(localStorage.getItem(BOOK_KEY) || "[]") || []; }
    catch (e) { return []; }
  }
  function saveBook(legs) {
    try { localStorage.setItem(BOOK_KEY, JSON.stringify(legs)); } catch (e) {}
    paintSlip();
    try { window.dispatchEvent(new Event("vfs-book")); } catch (e) {}
    return legs;
  }
  function legKey(l) {
    return String((l && (l.eventId || l.id)) || "");
  }
  function inBook(id) {
    return loadBook().some(function (l) { return l.id === id || l.eventId === id; });
  }
  function toggleBook(pick) {
    var legs = loadBook();
    var key = legKey(pick);
    var prev = legs.filter(function (l) { return legKey(l) === key; })[0];
    var kept = legs.filter(function (l) { return legKey(l) !== key; });
    if (!prev || prev.selection !== pick.selection) kept.push(pick);
    return saveBook(kept);
  }

  var BOOK_FC = "vfs_book_fc";
  function loadBookFc() {
    try { return JSON.parse(localStorage.getItem(BOOK_FC) || "[]") || []; }
    catch (e) { return []; }
  }
  function saveBookFc(legs) {
    try { localStorage.setItem(BOOK_FC, JSON.stringify(legs)); } catch (e) {}
    paintSlip();
    try { window.dispatchEvent(new Event("vfs-book")); } catch (e) {}
    return legs;
  }
  function inBookFc(id) {
    return loadBookFc().some(function (l) { return l.id === id; });
  }
  function toggleBookFc(pick) {
    var legs = loadBookFc();
    var prev = legs.filter(function (l) { return l.id === pick.id; })[0];
    var kept = legs.filter(function (l) { return l.id !== pick.id; });
    if (!prev || prev.selection !== pick.selection) kept.push(pick);
    return saveBookFc(kept);
  }

  function byKick(a, b) {
    var ka = Number(a && a.kickoff) || Infinity;
    var kb = Number(b && b.kickoff) || Infinity;
    return ka - kb;
  }

  function until(ms) {
    if (!ms) return { text: "", cls: "" };
    var d = Number(ms) - Date.now();
    if (d <= 0) return { text: "kicked off", cls: "now" };
    var m = Math.round(d / 60000);
    if (m < 3) return { text: "in " + m + "m", cls: "now" };
    if (m < 60) return { text: "in " + m + "m", cls: m < 15 ? "soon" : "" };
    var h = Math.floor(m / 60), mm = m % 60;
    return { text: "in " + h + "h " + String(mm).padStart(2, "0") + "m", cls: "" };
  }

  function clock(ms) {
    if (!ms) return "";
    var d = new Date(Number(ms));
    if (isNaN(d)) return "";
    return d.toTimeString().slice(0, 5);
  }

  function dayLabel(ms) {
    if (!ms) return "";
    var d = new Date(Number(ms));
    if (isNaN(d)) return "";
    var now = new Date();
    var a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((b - a) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }

  function leagueKey(g) {
    var s = String(g.league || "");
    if (/england/i.test(s)) return "England";
    if (/spain/i.test(s)) return "Spain";
    if (/italy/i.test(s)) return "Italy";
    if (/germany/i.test(s)) return "Germany";
    if (/france/i.test(s)) return "France";
    return s.split("·")[0].trim() || "Other";
  }

  // football-data.org crest ids — the same club badges SportyBet sits next to the codes.
  var CRESTS = {
    ACM:98, ALA:263, AMO:530, ANG:532, ARS:57, AST:58, ATA:102, ATM:78, AUX:519,
    AVL:58, BET:90, BFC:103, BHA:397, BIL:77, BMG:18, BMU:5, BOC:36, BOU:389,
    BRE:402, BUR:328, BVB:4, CAG:104, CEL:558, CHE:61, COM:1107, COV:1076,
    CRY:354, ELC:285, EMP:445, ESP:80, EVE:62, FCA:16, FCB:81, FIO:99, FRO:470,
    FUL:63, GEN:107, GET:82, GIR:298, HDH:44, HSV:7, HUL:322, INT:108, IPS:349,
    JUV:109, KOE:1, LAZ:110, LEC:455, LEE:341, LEH:533, LEI:338, LEN:546, LEV:3,
    LIL:521, LIV:64, LOR:525, LYO:523, MAI:15, MAL:89, MAN:66, MCF:65, MCI:65,
    MON:584, MUN:66, NAP:113, NCE:522, NEW:67, NFO:351, OLM:516, OSA:79, OVI:267,
    PAD:29, PAR:112, PFC:543, PSG:524, RAC:461, RAY:87, RBB:90, RBL:721, RCD:80,
    REN:529, RMA:86, ROM:100, RSO:92, SAS:471, SCF:17, SCH:6, SEV:559, SGE:19,
    SOU:340, STP:20, STR:576, SUN:71, SVE:1920, SVW:12, TOR:586, TOT:73, TOU:511,
    TRO:531, TSG:2, UDI:115, UNI:28, VAL:95, VCF:95, VEN:454, VER:450, VFB:10,
    VIL:94, WHU:563, WOB:11, WOL:76
  };

  function crest(code) {
    var name = String(code || "").toUpperCase();
    var wrap = el("span", "crest");
    wrap.title = name;
    var id = CRESTS[name];
    if (!id) {
      wrap.className += " fb";
      wrap.textContent = name.slice(0, 3) || "?";
      return wrap;
    }
    var img = document.createElement("img");
    img.src = "https://crests.football-data.org/" + id + ".png";
    img.alt = name;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", function () {
      wrap.classList.add("fb");
      wrap.textContent = name.slice(0, 3);
    });
    wrap.appendChild(img);
    return wrap;
  }

  function teamsBlock(home, away) {
    var box = el("div", "teams");
    [home, away].forEach(function (code) {
      var row = el("div", "tm");
      row.appendChild(crest(code));
      row.appendChild(el("b", null, code));
      box.appendChild(row);
    });
    return box;
  }

  function copyBtn(id, label) {
    var word = label || "Copy ID";
    var b = el("button", "copy", word);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var done = function () {
        b.textContent = "Copied";
        b.classList.add("done");
        setTimeout(function () { b.textContent = word; b.classList.remove("done"); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(id)).then(done, function () { b.textContent = String(id); });
      } else { b.textContent = String(id); }
    });
    return b;
  }

  function market(title, pairs, favKey, pick) {
    var box = el("div", "mkt");
    box.appendChild(el("div", "mkt-t", title));
    var grid = el("div", "mkt-g");
    pairs.forEach(function (p) {
      var sel = p[3];
      var on = pick && pick.picked === sel;
      var can = pick && sel && p[1] != null;
      var cell = el("div", "cell" + (p[2] === favKey ? " fav" : "") + (can ? " tap" : "") + (on ? " on" : ""));
      var price = el("b", null, p[1] == null ? "—" : Number(p[1]).toFixed(2));
      if (p[4]) price.appendChild(el("em", "pct", p[4]));
      cell.appendChild(price);
      cell.appendChild(el("span", null, p[0]));
      if (can) {
        cell.setAttribute("role", "button");
        cell.tabIndex = 0;
        var go = function (e) {
          e.stopPropagation();
          pick.onPick(makePick(pick.game, sel, p[1], p[0]));
        };
        cell.addEventListener("click", go);
        cell.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); }
        });
      }
      grid.appendChild(cell);
    });
    box.appendChild(grid);
    return box;
  }

  function checksBox(r) {
    var box = el("div", "checks");
    r.checks.forEach(function (c) {
      var row = el("div", "check " + (c.skip ? "" : (c.ok ? "ok" : "no")));
      row.appendChild(el("i", "dot"));
      row.appendChild(el("span", null, c.text));
      box.appendChild(row);
    });
    return box;
  }

  function card(g, r, opts) {
    opts = opts || {};
    var picked = opts.picked || inBook(g.id);
    var box = el("div", "game" + (r.verdict === "show" ? " match" : r.verdict === "hold" ? " hold" : "") + (picked ? " picked" : ""));
    var row = el("div", "row1");
    if (opts.n) row.appendChild(el("span", "idx", String(opts.n)));
    row.appendChild(el("span", "gid", g.id));
    var who = el("div", "who");
    who.appendChild(teamsBlock(g.home, g.away));
    var meta = el("div", "meta");
    var t = until(g.kickoff);
    var tm = el("time", t.cls, (clock(g.kickoff) + (t.text ? " · " + t.text : "")).trim());
    tm.setAttribute("data-kick", g.kickoff || "");
    meta.appendChild(tm);
    if (g.league) meta.appendChild(el("span", null, g.league));
    if (r.verdict === "hold") {
      var htHold = (r.checks || []).filter(function (c) { return c.name.indexOf("ht_") === 0; });
      var htFailed = htHold.some(function (c) { return !c.ok && !c.skip; });
      meta.appendChild(el("span", null, htFailed ? "half-time missed" : "no half-time"));
    }
    who.appendChild(meta);
    row.appendChild(who);
    row.appendChild(copyBtn(g.id));
    box.appendChild(row);
    if (!opts.compact) {
      var leg = g.source === "football"
        ? loadBookFc().filter(function (l) { return l.id === g.id; })[0]
        : bookLeg(g.id);
      var tap = opts.pickable ? {
        game: g,
        picked: leg ? leg.selection : "",
        onPick: function (p) {
          if (g.source === "football") toggleBookFc(p);
          else toggleBook(p);
          if (opts.onPick) opts.onPick(p);
        }
      } : null;
      box.appendChild(market("Full time", [
        ["Home", g.ft.home, "home", "1"],
        ["Draw", g.ft.draw, "draw", "X"],
        ["Away", g.ft.away, "away", "2"]
      ], r.fav, tap));
      box.appendChild(market("Two chances" + (g.dc ? "" : " · worked out"), [
        ["Home or Draw", r.dc && r.dc.home_draw, "home", "1X"],
        ["Home or Away", r.dc && r.dc.home_away, "", "12"],
        ["Draw or Away", r.dc && r.dc.draw_away, "away", "X2"]
      ], r.fav, tap));
      box.appendChild(market("Half time", [
        ["Home", g.ht ? g.ht.home : null, "home"],
        ["Draw", g.ht ? g.ht.draw : null, "draw"],
        ["Away", g.ht ? g.ht.away : null, "away"]
      ], r.fav, null));
      if (opts.checks) box.appendChild(checksBox(r));
    }
    return box;
  }

  function compactRow(g, r) {
    var box = el("div", "game");
    var row = el("div", "compact");
    var t = until(g.kickoff);
    var tm = el("div", "when " + t.cls, t.text || clock(g.kickoff));
    tm.setAttribute("data-kick", g.kickoff || "");
    row.appendChild(tm);
    row.appendChild(teamsBlock(g.home, g.away));
    row.appendChild(el("div", "pr", g.ft && g.ft[r.fav] != null ? Number(g.ft[r.fav]).toFixed(2) : "—"));
    box.appendChild(row);

    var extra = el("div");
    extra.hidden = true;
    extra.style.padding = "0 14px 14px";
    var actions = el("div", "row1");
    actions.appendChild(el("span", "gid", g.id));
    actions.appendChild(el("div", "who"));
    actions.appendChild(copyBtn(g.id));
    extra.appendChild(actions);
    extra.appendChild(market("Full time", [
      ["Home", g.ft.home, "home"], ["Draw", g.ft.draw, "draw"], ["Away", g.ft.away, "away"]
    ], r.fav, null));
    extra.appendChild(market("Two chances" + (g.dc ? "" : " · worked out"), [
      ["Home or Draw", r.dc && r.dc.home_draw, "home"],
      ["Home or Away", r.dc && r.dc.home_away, ""],
      ["Draw or Away", r.dc && r.dc.draw_away, "away"]
    ], r.fav, null));
    extra.appendChild(market("Half time", [
      ["Home", g.ht ? g.ht.home : null, "home"],
      ["Draw", g.ht ? g.ht.draw : null, "draw"],
      ["Away", g.ht ? g.ht.away : null, "away"]
    ], r.fav, null));
    extra.appendChild(checksBox(r));
    box.appendChild(extra);
    row.addEventListener("click", function () { extra.hidden = !extra.hidden; });
    return box;
  }

  function tick() {
    document.querySelectorAll("[data-kick]").forEach(function (n) {
      var t = until(n.getAttribute("data-kick"));
      var clockBit = n.tagName === "TIME" ? clock(n.getAttribute("data-kick")) : "";
      n.textContent = n.tagName === "TIME"
        ? (clockBit + (t.text ? " · " + t.text : "")).trim()
        : (t.text || clockBit);
      n.classList.remove("soon", "now");
      if (t.cls) n.classList.add(t.cls);
    });
    watchPings();
  }

  function dropClashes(games) {
    var list = games || [];
    var slot = {};
    function recency(g) {
      var t = Date.parse(g.lastSeen || g.last_seen || 0);
      return isFinite(t) ? t : 0;
    }
    function minute(g) { return Math.floor(Number(g.kickoff) / 60000); }
    function k(team, g) { return leagueKey(g) + "|" + minute(g) + "|" + String(team || "").toUpperCase(); }
    function take(team, g) {
      if (!team || !g.kickoff) return;
      var key = k(team, g);
      var prev = slot[key];
      if (!prev) { slot[key] = g; return; }
      if (recency(g) > recency(prev)) { slot[key] = g; return; }
      if (recency(g) === recency(prev) && g.eventId && !prev.eventId) slot[key] = g;
    }
    list.forEach(function (g) { take(g.home, g); take(g.away, g); });
    return list.filter(function (g) {
      if (!g.kickoff) return true;
      return slot[k(g.home, g)] === g && slot[k(g.away, g)] === g;
    });
  }

  function fetchGames(force, book) {
    var q = [];
    if (force) q.push("force=1");
    if (book === "football") q.push("book=football");
    return fetch("/api/games" + (q.length ? "?" + q.join("&") : "")).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || (book === "football" ? "Football.com did not answer" : "SportyBet did not answer"));
      d.games = dropClashes(d.games || []);
      return d;
    });
  }

  function fetchHistory(scope) {
    return fetch("/api/history?scope=" + encodeURIComponent(scope || "past"))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "Could not read the record");
        return d;
      });
  }

  function fetchAnalytics() {
    return fetch("/api/analytics").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || "Could not read analytics");
      return d;
    });
  }

  function fetchPicks(settle) {
    return fetch("/api/picks?scope=settled" + (settle ? "&settle=1" : ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "Could not read picks");
        return d;
      });
  }

  function fetchSlips(live) {
    return fetch("/api/slips" + (live ? "?live=1" : ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "Could not read slips");
        return d;
      });
  }

  function paintKnobs(root, onChange) {
    root.textContent = "";
    Object.keys(DEFAULTS).forEach(function (k) {
      var lab = el("label", null, LABELS[k]);
      lab.htmlFor = "k_" + k;
      var inp = document.createElement("input");
      inp.type = "number"; inp.step = "0.01"; inp.id = "k_" + k;
      inp.value = cfg[k].toFixed(2);
      inp.addEventListener("change", function () {
        var v = parseFloat(inp.value);
        if (isFinite(v) && v > 0) { cfg[k] = v; save(); }
        inp.value = cfg[k].toFixed(2);
        if (onChange) onChange();
      });
      root.appendChild(lab); root.appendChild(inp);
    });
  }

  setInterval(tick, 30000);

  function paintSlip() {
    var n = loadBook().length + loadBookFc().length;
    var badge = document.querySelector(".slip-tab .n");
    if (badge) badge.textContent = n ? String(n) : "";
    var tab = document.querySelector(".slip-tab");
    if (tab) tab.classList.toggle("full", n > 0);
  }

  // Header: menu, brand, the page's own buttons. Every page lives in the side
  // drawer (Bet / Records / More); the bottom bar keeps the five used most.
  function injectChrome(active, extra) {
    extra = extra || "";
    if (!document.querySelector(".top")) {
      var top = document.createElement("header");
      top.className = "top";
      top.innerHTML =
        '<button class="gear-btn menu-btn" type="button" id="vfs-menu" aria-label="Menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>' +
        '<div class="brand"><b>Vantage</b><span>SportyBet screener</span></div>' +
        extra;
      document.body.insertBefore(top, document.body.firstChild);
    }
    if (!document.querySelector(".drawer")) {
      var bg = document.createElement("div");
      bg.className = "drawer-bg";
      var dr = document.createElement("aside");
      dr.className = "drawer";
      dr.setAttribute("aria-label", "Menu");
      dr.innerHTML = '<div class="drawer-head"><div class="mark" aria-hidden="true"><svg viewBox="0 0 100 100" width="20" height="20" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"><path d="M27 43 L45 67 L75 23"/></svg></div><div class="brand"><b>Vantage</b><span>Menu</span></div></div><div class="drawer-sec">Bet</div><a href="/" data-nav="matches"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg><span>vFootball matches</span></a><a href="/tt" data-nav="tt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="9" r="6"/><path d="M6 13.2 3.4 19.6"/><circle cx="17.6" cy="15.4" r="1.3" fill="currentColor" stroke="none"/></svg><span>Table tennis</span></a><a href="/tennis" data-nav="tennis"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6c3.2 3.2 3.2 9.6 0 12.8M18.4 5.6c-3.2 3.2-3.2 9.6 0 12.8"/></svg><span>Tennis</span></a><a href="/eb" data-nav="eb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c2.4 2 3.4 4 3.4 6.4s-1 4.4-3.4 6.4M18.4 5.6c-2.4 2-3.4 4-3.4 6.4s1 4.4 3.4 6.4"/></svg><span>eBasketball</span></a><a href="/book" data-nav="book"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v16l-3.2-1.6-3.3 1.6-3.3-1.6L5.5 21V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M9 8h6M9 12h6M9 16h3.5"/></svg><span>Betslip</span></a><div class="drawer-sec">Records</div><a href="/ledger" data-nav="ledger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><span>History</span></a><div class="drawer-sec">More</div><a href="/card" data-nav="card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></svg><span>Card · every vFootball game</span></a><a href="/lab" data-nav="lab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6l-5 8a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-8V3"/><path d="M8 3h8M8 13h8"/></svg><span>Lab · backtest the screen</span></a><a href="/rules" data-nav="rules"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/></svg><span>Rules & settings</span></a><button type="button" class="drawer-lock" id="vfs-lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span>Lock</span></button>';
      document.body.appendChild(bg);
      document.body.appendChild(dr);
      var setOpen = function (on) {
        document.body.classList.toggle("drawer-open", on);
        var mb = document.getElementById("vfs-menu");
        if (mb) mb.setAttribute("aria-expanded", on ? "true" : "false");
      };
      document.getElementById("vfs-menu").addEventListener("click", function () {
        setOpen(!document.body.classList.contains("drawer-open"));
      });
      bg.addEventListener("click", function () { setOpen(false); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
    }
    if (!document.querySelector(".nav")) {
      var nav = document.createElement("nav");
      nav.className = "nav";
      nav.setAttribute("aria-label", "Primary");
      nav.innerHTML = '<a href="/" data-nav="matches"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>Matches</a><a href="/tt" data-nav="tt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="9" r="6"/><path d="M6 13.2 3.4 19.6"/><circle cx="17.6" cy="15.4" r="1.3" fill="currentColor" stroke="none"/></svg>Table tennis</a><a href="/book" class="slip-tab" data-nav="book" aria-label="Betslip"><span class="n"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v16l-3.2-1.6-3.3 1.6-3.3-1.6L5.5 21V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M9 8h6M9 12h6M9 16h3.5"/></svg>Betslip</a><a href="/tennis" data-nav="tennis"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6c3.2 3.2 3.2 9.6 0 12.8M18.4 5.6c-3.2 3.2-3.2 9.6 0 12.8"/></svg>Tennis</a><a href="/eb" data-nav="eb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c2.4 2 3.4 4 3.4 6.4s-1 4.4-3.4 6.4M18.4 5.6c-2.4 2-3.4 4-3.4 6.4s1 4.4 3.4 6.4"/></svg>eBasket</a>';
      document.body.appendChild(nav);
    }
    document.querySelectorAll(".nav a, .gear-btn, .drawer a").forEach(function (a) {
      if (a.getAttribute("data-nav") === active) a.classList.add("on");
    });
    paintSlip();
    var lb = document.getElementById("vfs-lock");
    if (lb && !lb.getAttribute("data-bound")) {
      lb.setAttribute("data-bound", "1");
      lb.addEventListener("click", lockNow);
    }
    if (!document.documentElement.getAttribute("data-gate")) {
      document.documentElement.setAttribute("data-gate", "1");
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") gateCheck();
      });
    }
    gateCheck();
  }

  function b64urlToBuf(s) {
    s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64url(buf) {
    var u = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function credJSON(cred) {
    var r = cred.response;
    var out = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(r.clientDataJSON)
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
    if (r.attestationObject) out.response.attestationObject = bufToB64url(r.attestationObject);
    if (r.authenticatorData) out.response.authenticatorData = bufToB64url(r.authenticatorData);
    if (r.signature) out.response.signature = bufToB64url(r.signature);
    if (r.userHandle) out.response.userHandle = bufToB64url(r.userHandle);
    if (r.getTransports) out.response.transports = r.getTransports();
    return out;
  }
  function creationOpts(o) {
    var pk = {
      rp: o.rp,
      user: { id: b64urlToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      challenge: b64urlToBuf(o.challenge),
      pubKeyCredParams: o.pubKeyCredParams,
      timeout: o.timeout,
      attestation: o.attestation,
      authenticatorSelection: o.authenticatorSelection
    };
    if (o.excludeCredentials) {
      pk.excludeCredentials = o.excludeCredentials.map(function (c) {
        return { type: c.type || "public-key", id: b64urlToBuf(c.id), transports: c.transports };
      });
    }
    return pk;
  }
  function requestOpts(o) {
    var pk = {
      challenge: b64urlToBuf(o.challenge),
      timeout: o.timeout,
      rpId: o.rpId,
      userVerification: o.userVerification || "required"
    };
    if (o.allowCredentials) {
      pk.allowCredentials = o.allowCredentials.map(function (c) {
        return { type: c.type || "public-key", id: b64urlToBuf(c.id), transports: c.transports };
      });
    }
    return pk;
  }

  var lockTimer = 0;
  function scheduleLock(ms) {
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = 0;
    if (!ms || ms <= 0) return;
    lockTimer = setTimeout(function () { lockNow(); }, ms);
  }

  function enrollBio() {
    if (!window.PublicKeyCredential) {
      return Promise.reject(new Error("This browser cannot save a fingerprint"));
    }
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(function (ok) {
      if (!ok) throw new Error("This phone has no fingerprint / Face ID for the browser");
      return fetch("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio: "register-options" })
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok || !d.options) throw new Error(d.error || "Could not start fingerprint");
      return navigator.credentials.create({ publicKey: creationOpts(d.options) });
    }).then(function (cred) {
      if (!cred) throw new Error("Cancelled");
      return fetch("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio: "register", cred: credJSON(cred) })
      }).then(function (r) { return r.json(); });
    }).then(function (d) {
      if (!d || !d.bio) throw new Error((d && d.error) || "Fingerprint was not saved");
      try { localStorage.setItem("vfs-bio", "1"); } catch (e) {}
      return d;
    });
  }

  function unlockBio() {
    return fetch("/api/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: "options" })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok || !d.options) throw new Error(d.error || "Fingerprint not set");
      return navigator.credentials.get({ publicKey: requestOpts(d.options) });
    }).then(function (cred) {
      if (!cred) throw new Error("Cancelled");
      return fetch("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio: "assert", cred: credJSON(cred) })
      }).then(function (r) { return r.json(); });
    }).then(function (d) {
      if (!d.open) throw new Error(d.error || "Fingerprint did not match");
      return d;
    });
  }

  function opened(d) {
    markOpen(d && d.remainingMs);
    scheduleLock(d && d.remainingMs);
    var g = document.getElementById("gate");
    if (g) {
      g.innerHTML =
        '<div class="gate-box"><div class="verified" aria-hidden="true">' +
          '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"><path d="M26 51 L44 69 L76 30"/></svg>' +
        '</div><b>Verified</b></div>';
    }
    setTimeout(function () {
      document.body.classList.remove("locked");
      if (g) g.remove();
      location.reload();
    }, 700);
  }

  function showLock() {
    if (document.getElementById("gate")) return;
    document.body.classList.add("locked");
    var gate = el("div", "gate");
    gate.id = "gate";
    gate.innerHTML =
      '<div class="gate-box">' +
        '<div class="mark" aria-hidden="true"><svg viewBox="0 0 100 100" width="26" height="26" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"><path d="M27 43 L45 67 L75 23"/></svg></div>' +
        '<b>Vantage</b>' +
        '<p>Enter your code</p>' +
        '<div class="dots" id="gate-dots"></div>' +
        '<p class="err" id="gate-err" hidden></p>' +
        '<div class="pad" id="gate-pad"></div>' +
      "</div>";
    document.body.appendChild(gate);
    var pin = "";
    function fail(msg) {
      pin = "";
      paintDots();
      var e = document.getElementById("gate-err");
      e.hidden = false;
      e.textContent = msg || "Wrong code";
    }
    function paintDots() {
      var d = document.getElementById("gate-dots");
      d.textContent = "";
      for (var i = 0; i < 6; i++) d.appendChild(el("i", i < pin.length ? "on" : ""));
    }
    function press(ch) {
      document.getElementById("gate-err").hidden = true;
      if (ch === "⌫") pin = pin.slice(0, -1);
      else if (pin.length < 6) pin += ch;
      paintDots();
      if (pin.length === 6) submit();
    }
    function submit() {
      fetch("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: pin })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.open) return fail("Wrong code");
        opened(d);
      }).catch(function () { fail("Could not reach the lock"); });
    }
    var pad = document.getElementById("gate-pad");
    var FP =
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/>' +
        '<path d="M14 13.12c0 2.38 0 6.38-1 8.88"/>' +
        '<path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/>' +
        '<path d="M2 12a10 10 0 0 1 18-6"/>' +
        '<path d="M2 16h.01"/>' +
        '<path d="M21.8 16c.2-2 .131-5.354 0-6"/>' +
        '<path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/>' +
        '<path d="M8.65 22c.21-.66.45-1.32.57-2"/>' +
        '<path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>' +
      "</svg>";
    function runBio() {
      document.getElementById("gate-err").hidden = true;
      unlockBio().then(opened).catch(function (err) {
        if (!err || err.name === "NotAllowedError") return;
        var msg = String(err.message || "");
        if (/cancel|not set|expired|abort/i.test(msg)) return;
        fail("Try the code");
      });
    }
    ["1","2","3","4","5","6","7","8","9","fp","0","⌫"].forEach(function (ch) {
      var b = el("button", "key" + (ch === "fp" ? " fp" : ch === "" ? " ghost" : ""));
      b.type = "button";
      if (ch === "fp") {
        b.innerHTML = FP;
        b.setAttribute("aria-label", "Fingerprint");
        b.disabled = true;
        b.addEventListener("click", runBio);
      } else if (ch === "⌫") {
        b.textContent = "⌫";
        b.addEventListener("click", function () { press(ch); });
      } else {
        b.textContent = ch;
        b.addEventListener("click", function () { press(ch); });
      }
      pad.appendChild(b);
    });
    paintDots();
    fetch("/api/gate").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.bio) return;
      var fp = pad.querySelector(".key.fp");
      if (fp) fp.disabled = false;
      var hint = document.querySelector("#gate .gate-box p");
      if (hint) hint.textContent = "Fingerprint or code";
      // Best-effort: raise the fingerprint sheet without a tap. Browsers that
      // require a user gesture just no-op here, and the fingerprint key still works.
      runBio();
    }).catch(function () {});
  }

  function gateCheck() {
    fetch("/api/gate").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.open) { markLocked(); showLock(); }
      else {
        markOpen(d.remainingMs);
        scheduleLock(d.remainingMs);
        hydrate();
        bankEB();
      }
    }).catch(function () { markLocked(); showLock(); });
  }

  // eBasketball prices only show shortly before tip-off, so while any page is
  // open and unlocked, bank the card every 5 minutes in the background. The
  // last run time is shared across tabs so two open pages don't double up.
  var ebTimer = null;
  function bankEB() {
    if (ebTimer) return;
    function tick() {
      if (document.visibilityState !== "visible") return;
      var last = 0;
      try { last = Number(localStorage.getItem("vfs_eb_bank")) || 0; } catch (e) { last = 0; }
      if (Date.now() - last < 5 * 60 * 1000) return;
      try { localStorage.setItem("vfs_eb_bank", String(Date.now())); } catch (e) { /* still bank */ }
      fetch("/api/tt?card=eb&bank=1").catch(function () {});
    }
    tick();
    ebTimer = setInterval(tick, 60 * 1000);
  }

  function lockNow() {
    markLocked();
    fetch("/api/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lock: true })
    }).then(function () { showLock(); });
  }

  function hydrate() {
    return fetch("/api/settings").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return d;
      if (d.shape) {
        Object.keys(DEFAULTS).forEach(function (k) {
          if (typeof d.shape[k] === "number") cfg[k] = d.shape[k];
        });
        saveLocal();
      } else {
        save();
      }
      device.pings = d.pings !== false;
      if (d.bio === false) device.bio = false;
      if (d.lockMin) device.lockMin = Number(d.lockMin) || 30;
      try {
        localStorage.setItem("vfs_pings", device.pings ? "1" : "0");
        localStorage.setItem("vfs_bio", device.bio ? "1" : "0");
        localStorage.setItem("vfs_lock_min", String(device.lockMin));
      } catch (e) {}
      w.dispatchEvent(new Event("vfs-ready"));
      return d;
    });
  }

  function pingSeen() {
    try { return JSON.parse(localStorage.getItem("vfs_pinged") || "{}") || {}; }
    catch (e) { return {}; }
  }
  function pingMark(k) {
    var s = pingSeen();
    s[k] = Date.now();
    var keys = Object.keys(s);
    if (keys.length > 80) keys.sort(function (a, b) { return s[a] - s[b]; }).slice(0, keys.length - 80).forEach(function (x) { delete s[x]; });
    try { localStorage.setItem("vfs_pinged", JSON.stringify(s)); } catch (e) {}
  }

  function ping(title, body, tag, kind) {
    if (device.pings === false) return;
    playKind(kind);
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var sound = kind === "yes" ? "/sounds/yes.wav" : kind === "no" ? "/sounds/no.wav" : kind === "kick" ? "/sounds/kick.wav" : "";
    var opts = {
      body: body || "",
      tag: tag || title,
      icon: "/favicon.svg",
      renotify: true,
      vibrate: kind === "yes" ? [80, 40, 80, 40, 160] : kind === "no" ? [240, 80, 240] : [100, 50, 100]
    };
    if (sound) opts.sound = sound;
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (reg) {
        try { reg.showNotification(title, opts); } catch (e) { try { new Notification(title, opts); } catch (e2) {} }
      });
    } else {
      try { new Notification(title, opts); } catch (e) {}
    }
  }

  function playKind(kind) {
    var src = kind === "yes" ? "/sounds/yes.wav" : kind === "no" ? "/sounds/no.wav" : kind === "kick" ? "/sounds/kick.wav" : "";
    if (!src) return;
    try {
      var a = new Audio(src);
      a.play().catch(function () {});
    } catch (e) {}
  }

  function watchPings() {
    if (device.pings === false) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var seen = pingSeen();
    var now = Date.now();
    loadBook().forEach(function (l) {
      if (!l.kickoff) return;
      var d = Number(l.kickoff) - now;
      var k = "kick-" + l.id;
      if (d > 0 && d <= 5 * 60 * 1000 && !seen[k]) {
        pingMark(k);
        ping("Kicks soon", l.home + " v " + l.away, k, "kick");
      }
    });
  }

  function noticeSlips(slips) {
    if (device.pings === false) return;
    if (!slips || !slips.length) return;
    var seen = pingSeen();
    slips.forEach(function (sp) {
      (sp.legs || []).forEach(function (l) {
        if (l.won !== true && l.won !== false) return;
        var k = "leg-" + l.gameId + "-" + (l.won ? "yes" : "no");
        if (seen[k]) return;
        pingMark(k);
        ping(l.won ? "Yes" : "No",
          (l.home || "") + " v " + (l.away || "") + " · " + (l.label || ""),
          k, l.won ? "yes" : "no");
      });
      if (sp.status !== "won" && sp.status !== "lost") return;
      var sk = "slip-" + sp.id + "-" + sp.status;
      if (seen[sk]) return;
      pingMark(sk);
      ping(sp.status === "won" ? "Bet landed" : "Bet missed",
        (sp.shareCode ? sp.shareCode + " · " : "") + sp.legs.length + " legs",
        sk, sp.status === "won" ? "yes" : "no");
    });
  }

  function b64ToBytes(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function subscribePush() {
    return fetch("/api/push").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.publicKey || !navigator.serviceWorker) return;
      return navigator.serviceWorker.ready.then(function (reg) {
        if (!reg.pushManager) return;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(d.publicKey)
        });
      }).then(function (sub) {
        if (!sub) return;
        return fetch("/api/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sub.toJSON())
        });
      });
    });
  }

  var device = { pings: true, bio: true, lockMin: 30 };
  try {
    if (localStorage.getItem("vfs_pings") === "0") device.pings = false;
    if (localStorage.getItem("vfs_bio") === "0") device.bio = false;
    var lm = Number(localStorage.getItem("vfs_lock_min"));
    if (lm >= 30) device.lockMin = lm;
  } catch (e) {}

  function killPush() {
    if (!navigator.serviceWorker) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) {
      if (!reg.pushManager) return;
      return reg.pushManager.getSubscription().then(function (sub) {
        var endpoint = sub && sub.endpoint;
        var gone = sub ? sub.unsubscribe() : Promise.resolve();
        return gone.then(function () {
          return fetch("/api/push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ off: true, endpoint: endpoint || "" })
          });
        });
      });
    }).catch(function () {});
  }

  function saveDevice(patch) {
    if (!patch) return Promise.resolve(device);
    if (typeof patch.pings === "boolean") device.pings = patch.pings;
    if (typeof patch.bio === "boolean") device.bio = patch.bio;
    if (patch.lockMin != null) device.lockMin = Number(patch.lockMin) || 30;
    try {
      localStorage.setItem("vfs_pings", device.pings ? "1" : "0");
      localStorage.setItem("vfs_bio", device.bio ? "1" : "0");
      localStorage.setItem("vfs_lock_min", String(device.lockMin));
    } catch (e) {}
    var extra = patch.pings === false ? killPush() : Promise.resolve();
    return extra.then(function () {
      return fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.remainingMs) scheduleLock(d.remainingMs);
      return d;
    });
  }

  function enablePings() {
    if (!("Notification" in window)) return Promise.reject(new Error("This browser will not ping"));
    return Notification.requestPermission().then(function (p) {
      if (p !== "granted") throw new Error("Notifications are off");
      var ready = navigator.serviceWorker
        ? navigator.serviceWorker.register("/sw.js").then(function () { return subscribePush(); })
        : Promise.resolve();
      return ready.then(function () {
        saveDevice({ pings: true });
        ping("Pings on", "Yes, No, and the full bet — even if the phone is locked.", "ping-test", "yes");
        return p;
      });
    });
  }

  if (navigator.serviceWorker && "Notification" in window && Notification.permission === "granted" && device.pings !== false) {
    navigator.serviceWorker.register("/sw.js").then(function () { subscribePush(); }).catch(function () {});
  }
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", function (e) {
      if (e.data && e.data.type === "vfs-sound") playKind(e.data.kind);
    });
  }

  function naira(n) {
    return "\u20a6" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // Wilson score interval — honest band on a hit rate, wide at small n.
  function wilson(wins, n, z) {
    z = z || 1.96;
    if (!n) return [0, 1];
    var p = wins / n, d = 1 + z * z / n;
    var c = (p + z * z / (2 * n)) / d;
    var h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }

  // Stats over settled legs (each screened pick is one leg).
  function legStats(slips) {
    var n = 0, wins = 0, implied = 0, staked = 0, ret = 0, sw = 0, sl = 0;
    slips.forEach(function (sp) {
      if (sp.status === "won") { sw++; staked += sp.stake; ret += sp.returned || 0; }
      else if (sp.status === "lost") { sl++; staked += sp.stake; }
      sp.legs.forEach(function (l) {
        if (l.won === true || l.won === false) {
          n++; if (l.won) wins++; if (l.price > 1) implied += 1 / l.price;
        }
      });
    });
    var band = wilson(wins, n);
    return {
      legs: n, wins: wins, hit: n ? wins / n : 0,
      breakeven: n ? implied / n : 0, lo: band[0], hi: band[1],
      slipsWon: sw, slipsLost: sl, staked: staked, returned: ret,
      pnl: ret - staked, roi: staked ? (ret - staked) / staked : 0
    };
  }

  function isTT(l) {
    if (l.sport === "tt") return true;
    return /^(set\s*\d|Playing)/i.test(l.status || "") ||
      /setka|elite series|liga pro|tt cup|challenger series|table tennis/i.test(l.league || "");
  }

  function isHeld(l) {
    return /interrupt|suspend|delay|postpon/i.test(String(l.status || ""));
  }

  function matchState(l) {
    if (isHeld(l) && l.won !== true && l.won !== false) return "held";
    if (l.won === true || l.won === false || /^(end|finish|retir|walkover|abandon|closed)/i.test(l.status || "")) return "ended";
    if (isTT(l) && /^(set\s*\d|Playing|LIVE)/i.test(l.status || "")) return "live";
    if (!isTT(l) && /^(H1|H2|HT|1H|2H|LIVE)/i.test(l.status || "")) return "live";
    if (l.kickoff && Number(l.kickoff) <= Date.now() - 15000) return "live";
    return "wait";
  }

  function scorePair(l) {
    if (l.ft && l.ft.home != null && l.ft.away != null) return [l.ft.home, l.ft.away];
    var raw = l.setScore || "";
    var m = String(raw).trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
    if (m) return [Number(m[1]), Number(m[2])];
    return null;
  }

  function pointsPair(l) {
    if (!isTT(l)) return null;
    var m = String(l.played || "").trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  function phaseLabel(l, st) {
    if (st === "held") return l.status || "Interrupted";
    if (st === "ended") return isTT(l) ? "FT" : "FT";
    var status = l.status || "LIVE";
    if (isTT(l)) return status;
    var played = String(l.played || "");
    var min = played.match(/^(\d+)/);
    if (min) return status + " · " + min[1] + "'";
    return status;
  }

  function legRow(l) {
    var st = matchState(l);
    var row = el("div", "leg " + st);
    var left = el("div", "leg-teams");
    left.appendChild(teamsBlock(l.home, l.away));
    if (l.label) {
      var sel = el("div", "sel");
      sel.appendChild(el("span", "pick", l.label));
      sel.appendChild(document.createTextNode(" @ " + Number(l.price).toFixed(2)));
      left.appendChild(sel);
      if (st === "live" && l.livePrice != null && isFinite(l.livePrice)) {
        var live = el("div", "live-odds");
        live.appendChild(el("span", "lo-l", "Live odds"));
        var px = Number(l.livePrice);
        var booked = Number(l.price);
        var dir = px < booked - 0.005 ? "dn" : px > booked + 0.005 ? "up" : "";
        var num = el("span", "lo-n " + dir, px.toFixed(2));
        live.appendChild(num);
        if (dir) live.appendChild(el("span", "lo-a " + dir, dir === "dn" ? "\u2193" : "\u2191"));
        left.appendChild(live);
      }
    }
    row.appendChild(left);

    var mid = el("div", "leg-mid");
    var pair = scorePair(l);
    if (st === "wait") {
      mid.appendChild(el("div", "kick", clock(l.kickoff) || "—"));
      var t = until(l.kickoff);
      if (t.text && t.text !== "kicked off") mid.appendChild(el("div", "phase", t.text));
    } else if (st === "held") {
      mid.appendChild(el("div", "scoreboard", pair ? (pair[0] + " – " + pair[1]) : "–"));
      mid.appendChild(el("div", "phase", phaseLabel(l, st)));
    } else {
      var pts = isTT(l) && st === "live" ? pointsPair(l) : null;
      var a, b;
      if (pts) {
        a = pts[0]; b = pts[1];
        mid.appendChild(el("div", "scoreboard points", a + " – " + b));
        var sets = pair ? (pair[0] + "–" + pair[1]) : "";
        mid.appendChild(el("div", "phase", (sets ? sets + " · " : "") + phaseLabel(l, st)));
      } else {
        a = pair ? pair[0] : 0; b = pair ? pair[1] : 0;
        mid.appendChild(el("div", "scoreboard", a + " – " + b));
        mid.appendChild(el("div", "phase", phaseLabel(l, st)));
      }
    }
    row.appendChild(mid);

    var mark;
    if (l.won === true) mark = el("div", "yes", "Yes");
    else if (l.won === false) mark = el("div", "no", "No");
    else if (st === "held") mark = el("div", "held-pill", "Held");
    else if (st === "live") mark = el("div", "live-pill", "LIVE");
    else mark = el("div", "wait-pill", "Wait");
    row.appendChild(mark);
    return row;
  }
  function slipCard(sp) {
    var card = el("div", "slip " + sp.status);
    var h = el("div", "slip-h");
    var b = el("span", "badge " + sp.status, sp.status);
    h.appendChild(b);
    h.appendChild(el("span", "sel", sp.legs.length + " legs \u00b7 " + naira(sp.stake)));
    var tot = el("span", "tot");
    if (sp.status === "won") tot.textContent = "won " + naira(sp.returned);
    else if (sp.status === "lost") tot.textContent = "lost";
    else tot.textContent = Number(sp.combinedOdds).toFixed(2) + " \u2192 " + naira(sp.potential);
    h.appendChild(tot);
    card.appendChild(h);

    if (sp.orderId) {
      var placed = el("div", "codebox");
      var placedName = (sp.legs || []).some(function (l) { return l.sport === "fc"; }) ? "Football.com" : "SportyBet";
      placed.appendChild(el("div", "mkt-t", "Placed on " + placedName + " · " + (sp.payWith === "gift" ? "gift" : "money")));
      var prow = el("div", "row1");
      prow.appendChild(el("span", "gid ord", sp.orderId));
      prow.appendChild(copyBtn(sp.orderId, "Copy"));
      placed.appendChild(prow);
      card.appendChild(placed);
    }

    if (sp.shareCode) {
      var football = /football\.com/i.test(String(sp.shareUrl || "")) ||
        (sp.legs || []).some(function (l) { return l.sport === "fc"; });
      var bookName = football ? "Football.com" : "SportyBet";
      var code = el("div", "codebox");
      code.appendChild(el("div", "mkt-t", bookName + " code"));
      var crow = el("div", "row1");
      crow.appendChild(el("span", "gid", sp.shareCode));
      var copy = el("button", "copy", "Copy");
      copy.addEventListener("click", function (e) {
        e.stopPropagation();
        var done = function () {
          copy.textContent = "Copied";
          copy.classList.add("done");
          setTimeout(function () { copy.textContent = "Copy"; copy.classList.remove("done"); }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(sp.shareCode).then(done, function () { copy.textContent = sp.shareCode; });
        } else copy.textContent = sp.shareCode;
      });
      crow.appendChild(copy);
      code.appendChild(crow);
      if (sp.shareUrl || sp.shareCode) {
        var link = document.createElement("a");
        var host = football ? "https://www.football.com" : "https://www.sportybet.com";
        link.href = football
          ? host + "/ng/m?shareCode=" + encodeURIComponent(sp.shareCode)
          : (sp.shareUrl
            ? String(sp.shareUrl).replace(/^http:\/\//, "https://")
            : host + "/ng/?shareCode=" + encodeURIComponent(sp.shareCode));
        link.textContent = "Open on " + bookName;
        link.target = "_blank";
        link.rel = "noopener";
        code.appendChild(link);
      }
      card.appendChild(code);
    } else if (sp.shareError) {
      var fail = el("p", "err", "No code: " + sp.shareError);
      card.appendChild(fail);
    }

    // Show the leg that's playing first, then the ones still to come, then finished.
    var rank = { live: 0, wait: 1, ended: 2 };
    sp.legs.slice()
      .sort(function (a, b) { return rank[matchState(a)] - rank[matchState(b)]; })
      .forEach(function (l) { card.appendChild(legRow(l)); });

    var leftover = (sp.legs || []).filter(function (l) { return matchState(l) !== "ended"; });
    if (!sp.quiet && leftover.length) {
      var re = el("button", "rebet", "Rebet · " + leftover.length + " left");
      re.type = "button";
      re.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        rebetSlip(sp);
      });
      card.appendChild(re);
    }
    if (!sp.quiet && (sp.status === "open" || sp.status === "live")) {
      var drop = el("button", "rebet", "Remove");
      drop.type = "button";
      drop.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        drop.disabled = true;
        drop.textContent = "Removing…";
        fetch("/api/slips?id=" + encodeURIComponent(sp.id), { method: "DELETE" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || "Could not remove");
            try { window.dispatchEvent(new Event("vfs-slips")); } catch (err) {}
          })
          .catch(function (err) {
            drop.disabled = false;
            drop.textContent = err.message || "Could not remove";
          });
      });
      card.appendChild(drop);
    }
    if (typeof sp.onDrop === "function") {
      var gone = el("button", "rebet", "Delete slip");
      gone.type = "button";
      gone.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        gone.disabled = true;
        gone.textContent = "Deleting…";
        sp.onDrop();
      });
      card.appendChild(gone);
    }
    return card;
  }

  function rebetSlip(sp) {
    var add = (sp.legs || []).filter(function (l) { return matchState(l) !== "ended"; }).map(function (l) {
      return {
        id: l.gameId || l.id,
        eventId: l.eventId || null,
        home: l.home,
        away: l.away,
        league: l.league || "",
        kickoff: l.kickoff || null,
        selection: l.selection,
        label: l.label,
        price: Number(l.price),
        source: l.sport === "fc" ? "football" : ""
      };
    }).filter(function (l) { return l.id && l.selection; });
    if (!add.length) return [];
    var football = /football\.com/i.test(String(sp.shareUrl || "")) ||
      (sp.legs || []).some(function (l) { return l.sport === "fc"; });
    var legs = (football ? loadBookFc() : loadBook()).slice();
    add.forEach(function (p) {
      var hit = -1;
      legs.forEach(function (x, n) { if (x.id === p.id) hit = n; });
      if (hit >= 0) legs[hit] = p;
      else legs.push(p);
    });
    if (football) saveBookFc(legs);
    else saveBook(legs);
    if (!/\/book(?:\.html)?$/.test(location.pathname)) location.href = "/book";
    return legs;
  }

  function pickCard(pk) {
    var card = el("div", "slip " + (pk.won === true ? "won" : pk.won === false ? "lost" : ""));
    card.appendChild(legRow(pk));
    return card;
  }

  // Flat-stake stats over settled auto-picks (one unit each).
  function pickStats(picks) {
    var n = 0, wins = 0, implied = 0, ret = 0;
    picks.forEach(function (pk) {
      if (pk.won === true || pk.won === false) {
        n++; if (pk.won) { wins++; ret += pk.price; }
        if (pk.price > 1) implied += 1 / pk.price;
      }
    });
    var band = wilson(wins, n);
    return {
      legs: n, wins: wins, hit: n ? wins / n : 0,
      breakeven: n ? implied / n : 0, lo: band[0], hi: band[1],
      staked: n, returned: ret, pnl: ret - n, roi: n ? (ret - n) / n : 0
    };
  }

  // Did the favourite double chance land, given the final score.
  function dcWon(selection, hg, ag) {
    if (hg == null || ag == null) return null;
    if (selection === "1X") return hg >= ag;
    if (selection === "X2") return ag >= hg;
    if (selection === "1") return hg > ag;
    if (selection === "2") return ag > hg;
    if (selection === "X") return hg === ag;
    if (selection === "12") return hg !== ag;
    return null;
  }

  // Bonferroni-widened z: honest band when several buckets are compared at once.
  var ZTAB = { 1: 1.960, 2: 2.241, 3: 2.394, 4: 2.498, 6: 2.638, 8: 2.734, 12: 2.859, 24: 3.023 };
  function zFor(k) {
    var keys = Object.keys(ZTAB).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) if (k <= keys[i]) return ZTAB[keys[i]];
    return 3.2;
  }

  // Run the current bands over one settled game; return the pick + whether it won.
  function analyse(g) {
    var r = screen(g);                       // uses live cfg thresholds
    if (r.verdict !== "show") return null;
    var selection = r.fav === "home" ? "1X" : "X2";
    var price = r.fav === "home" ? r.dc.home_draw : r.dc.draw_away;
    var res = g.res || {};
    var won = dcWon(selection, res.hg, res.ag);
    if (won == null) return null;
    return { league: leagueKey(g), kickoff: g.kickoff, price: price, won: won };
  }

  w.VFS = {
    cfg: cfg, defaults: DEFAULTS, labels: LABELS, save: save,
    hydrate: hydrate, enablePings: enablePings, noticeSlips: noticeSlips,
    screen: screen, makePick: makePick, favPick: favPick, stylePick: stylePick, spreadPack: spreadPack, sameSlotClusters: sameSlotClusters, acca: acca,
    rateGame: rateGame, packHit: packHit, stakeOf: stakeOf, bookLegs: bookLegs,
    loadBook: loadBook, saveBook: saveBook, toggleBook: toggleBook, inBook: inBook,
    loadBookFc: loadBookFc, saveBookFc: saveBookFc, toggleBookFc: toggleBookFc, inBookFc: inBookFc,
    usedMap: usedMap, markUsed: markUsed, mergeUsedFromSlips: mergeUsedFromSlips, isUsed: isUsed,
    rebetSlip: rebetSlip,
    card: card, compactRow: compactRow,
    strength: strength, strengthTag: strengthTag,
    until: until, clock: clock, dayLabel: dayLabel, byKick: byKick,
    leagueKey: leagueKey, teamsBlock: teamsBlock, crest: crest,
    fetchGames: fetchGames, fetchHistory: fetchHistory, fetchSlips: fetchSlips, fetchPicks: fetchPicks,
    paintKnobs: paintKnobs, el: el, tick: tick, copyBtn: copyBtn,
    injectChrome: injectChrome, paintSlip: paintSlip, enrollBio: enrollBio,
    enablePings: enablePings, saveDevice: saveDevice, device: device, scheduleLock: scheduleLock,
    naira: naira, wilson: wilson, legStats: legStats, slipCard: slipCard,
    pickCard: pickCard, pickStats: pickStats,
    dcWon: dcWon, zFor: zFor, analyse: analyse, fetchAnalytics: fetchAnalytics
  };
})(window);
