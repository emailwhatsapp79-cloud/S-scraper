(function (w) {
  "use strict";

  var DEFAULTS = {
    ft_fav_min: 1.50, ft_fav_max: 2.50, ft_dog_min: 3.70,
    ft_dc_fav_min: 1.17, ft_dc_fav_max: 1.30, ft_dc_dog_min: 1.89,
    ht_fav_min: 1.10, ht_fav_max: 3.00, ht_ratio_min: 1.70
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

  function save() {
    try { localStorage.setItem("vfs", JSON.stringify(cfg)); } catch (e) {}
  }

  function el(t, c, x) {
    var n = document.createElement(t);
    if (c) n.className = c;
    if (x != null) n.textContent = x;
    return n;
  }

  function combine(a, b) { return Math.round(100 / (1 / a + 1 / b)) / 100; }

  function band(name, v, lo, hi, what) {
    var ok = v >= lo && v <= hi;
    return { name: name, ok: ok, skip: false,
      text: what + " " + v.toFixed(2) + (ok ? " in " : " outside ") + lo.toFixed(2) + "–" + hi.toFixed(2) };
  }
  function floor(name, v, lo, what) {
    var ok = v >= lo;
    return { name: name, ok: ok, skip: false,
      text: what + " " + v.toFixed(2) + (ok ? " ≥ " : " < ") + lo.toFixed(2) };
  }

  function screen(g) {
    var dc = g.dc || {
      home_draw: combine(g.ft.home, g.ft.draw),
      home_away: combine(g.ft.home, g.ft.away),
      draw_away: combine(g.ft.draw, g.ft.away)
    };
    var fav = g.ft.home <= g.ft.away ? "home" : "away";
    var dog = fav === "home" ? "away" : "home";
    var favDC = fav === "home" ? dc.home_draw : dc.draw_away;
    var dogDC = dog === "home" ? dc.home_draw : dc.draw_away;
    var checks = [
      band("ft_fav", g.ft[fav], cfg.ft_fav_min, cfg.ft_fav_max, "FT " + fav),
      floor("ft_dog", g.ft[dog], cfg.ft_dog_min, "FT " + dog),
      band("ft_dc_fav", favDC, cfg.ft_dc_fav_min, cfg.ft_dc_fav_max, "FT " + (fav === "home" ? "1X" : "X2")),
      floor("ft_dc_dog", dogDC, cfg.ft_dc_dog_min, "FT " + (dog === "home" ? "1X" : "X2"))
    ];
    if (!g.ht) {
      checks.push({ name: "ht_fav", ok: false, skip: true, text: "half-time odds not loaded" });
      checks.push({ name: "ht_split", ok: false, skip: true, text: "half-time odds not loaded" });
    } else {
      var hf = g.ht[fav], hd = g.ht[dog], ratio = hd / hf;
      checks.push(band("ht_fav", hf, cfg.ht_fav_min, cfg.ht_fav_max, "HT " + fav));
      checks.push({
        name: "ht_split", ok: ratio >= cfg.ht_ratio_min, skip: false,
        text: "HT " + dog + " is " + ratio.toFixed(2) + "× HT " + fav
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
      price: Number(price)
    };
  }

  function bookLeg(id) {
    return loadBook().filter(function (l) { return l.id === id; })[0] || null;
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
    return legs;
  }
  function inBook(id) {
    return loadBook().some(function (l) { return l.id === id; });
  }
  function toggleBook(pick) {
    var legs = loadBook();
    var prev = legs.filter(function (l) { return l.id === pick.id; })[0];
    var kept = legs.filter(function (l) { return l.id !== pick.id; });
    if (!prev || prev.selection !== pick.selection) kept.push(pick);
    return saveBook(kept);
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

  function copyBtn(id) {
    var b = el("button", "copy", "Copy ID");
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var done = function () {
        b.textContent = "Copied";
        b.classList.add("done");
        setTimeout(function () { b.textContent = "Copy ID"; b.classList.remove("done"); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(done, function () { b.textContent = id; });
      } else { b.textContent = id; }
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
      cell.appendChild(el("b", null, p[1] == null ? "—" : Number(p[1]).toFixed(2)));
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
    row.appendChild(el("span", "gid", g.id));
    var who = el("div", "who");
    who.appendChild(el("b", null, g.home + " v " + g.away));
    var meta = el("div", "meta");
    var t = until(g.kickoff);
    var tm = el("time", t.cls, (clock(g.kickoff) + (t.text ? " · " + t.text : "")).trim());
    tm.setAttribute("data-kick", g.kickoff || "");
    meta.appendChild(tm);
    if (g.league) meta.appendChild(el("span", null, g.league));
    if (r.verdict === "hold") meta.appendChild(el("span", null, "no half-time"));
    who.appendChild(meta);
    row.appendChild(who);
    row.appendChild(copyBtn(g.id));
    box.appendChild(row);
    if (!opts.compact) {
      var picked = bookLeg(g.id);
      var tap = opts.pickable ? {
        game: g,
        picked: picked ? picked.selection : "",
        onPick: function (p) {
          toggleBook(p);
          if (opts.onPick) opts.onPick();
        }
      } : null;
      box.appendChild(market("Full time", [
        ["Home", g.ft.home, "home", "1"],
        ["Draw", g.ft.draw, "draw", "X"],
        ["Away", g.ft.away, "away", "2"]
      ], r.fav, tap));
      box.appendChild(market("Two chances" + (g.dc ? "" : " · worked out"), [
        ["Home or Draw", r.dc.home_draw, "home", "1X"],
        ["Home or Away", r.dc.home_away, "", "12"],
        ["Draw or Away", r.dc.draw_away, "away", "X2"]
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
    row.appendChild(el("div", "t", g.home + " v " + g.away));
    row.appendChild(el("div", "pr", g.ft[r.fav].toFixed(2)));
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
      ["Home or Draw", r.dc.home_draw, "home"],
      ["Home or Away", r.dc.home_away, ""],
      ["Draw or Away", r.dc.draw_away, "away"]
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
  }

  function fetchGames(force) {
    return fetch("/api/games" + (force ? "?force=1" : "")).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || "SportyBet did not answer");
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
    var n = loadBook().length;
    var badge = document.querySelector(".slip-tab .n");
    if (badge) badge.textContent = n ? String(n) : "";
    var tab = document.querySelector(".slip-tab");
    if (tab) tab.classList.toggle("full", n > 0);
  }

  function injectChrome(active, extra) {
    extra = extra || "";
    if (!document.querySelector(".top")) {
      var top = document.createElement("header");
      top.className = "top";
      top.innerHTML =
        '<div class="mark" aria-hidden="true">VF</div>' +
        '<div class="brand"><b>vFootball</b><span>SportyBet screener</span></div>' +
        extra;
      document.body.insertBefore(top, document.body.firstChild);
    }
    if (!document.querySelector(".nav")) {
      var nav = document.createElement("nav");
      nav.className = "nav";
      nav.setAttribute("aria-label", "Primary");
      nav.innerHTML =
        '<a href="/" data-nav="matches">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>' +
          "Matches</a>" +
        '<a href="/card" data-nav="card">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></svg>' +
          "Card</a>" +
        '<a href="/book" class="slip-tab" data-nav="book" aria-label="Betslip">' +
          '<span class="n"></span>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v16l-3.2-1.6-3.3 1.6-3.3-1.6L5.5 21V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M9 8h6M9 12h6M9 16h3.5"/></svg>' +
          "Betslip</a>" +
        '<a href="/ledger" data-nav="ledger">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>' +
          "History</a>" +
        '<a href="/rules" data-nav="rules">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>' +
          "Rules</a>";
      document.body.appendChild(nav);
    }
    document.querySelectorAll(".nav a").forEach(function (a) {
      if (a.getAttribute("data-nav") === active) a.classList.add("on");
    });
    paintSlip();
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

  // One saved-slip card, shared by Betslip and History.
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

    sp.legs.forEach(function (l) {
      var row = el("div", "leg");
      var left = el("div");
      left.appendChild(el("b", null, l.home + " v " + l.away));
      var sel = el("div", "sel");
      sel.appendChild(el("span", "pick", l.label));            // the favourable side picked
      sel.appendChild(document.createTextNode(" @ " + Number(l.price).toFixed(2)));
      left.appendChild(sel);
      // score line — only call it "FT" once the game has actually ended
      var ended = l.won === true || l.won === false || /^end/i.test(l.status || "");
      var ftLine = "";
      if (ended && l.ft) ftLine = "FT " + l.ft.home + ":" + l.ft.away;
      else if (/^(H1|H2|HT)/i.test(l.status || "") && l.setScore) {
        ftLine = l.status + " " + l.setScore + (l.played ? " " + l.played : "");
      } else if (l.kickoff) ftLine = clock(l.kickoff);
      if (ftLine) {
        var sc = el("div", "score");
        if (ended) sc.innerHTML = "FT <b>" + l.ft.home + ":" + l.ft.away + "</b>";
        else sc.textContent = ftLine;
        left.appendChild(sc);
      }
      row.appendChild(left);

      var mark;
      if (l.won === true) mark = el("div", "yes", "Yes");
      else if (l.won === false) mark = el("div", "no", "No");
      else if (/^(H1|H2|HT)/i.test(l.status || "")) mark = el("div", "sel", "live");
      else mark = el("div", "sel", "wait");
      row.appendChild(mark);
      card.appendChild(row);
    });
    return card;
  }

  w.VFS = {
    cfg: cfg, defaults: DEFAULTS, labels: LABELS, save: save,
    screen: screen, makePick: makePick, acca: acca,
    loadBook: loadBook, saveBook: saveBook, toggleBook: toggleBook, inBook: inBook,
    card: card, compactRow: compactRow,
    until: until, clock: clock, dayLabel: dayLabel, leagueKey: leagueKey,
    fetchGames: fetchGames, fetchHistory: fetchHistory, fetchSlips: fetchSlips,
    paintKnobs: paintKnobs, el: el, tick: tick, copyBtn: copyBtn,
    injectChrome: injectChrome, paintSlip: paintSlip,
    naira: naira, wilson: wilson, legStats: legStats, slipCard: slipCard
  };
})(window);
