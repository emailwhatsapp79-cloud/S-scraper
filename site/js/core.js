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

  function naturalPick(g, r) {
    r = r || screen(g);
    var price = r.fav === "home" ? r.dc.home_draw : r.dc.draw_away;
    return {
      id: g.id,
      eventId: g.eventId || null,
      home: g.home,
      away: g.away,
      league: g.league || "",
      kickoff: g.kickoff || null,
      selection: r.fav === "home" ? "1X" : "X2",
      label: r.fav === "home" ? "Home or Draw" : "Draw or Away",
      price: Number(price),
      fav: r.fav
    };
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
    return legs;
  }
  function inBook(id) {
    return loadBook().some(function (l) { return l.id === id; });
  }
  function toggleBook(pick) {
    var legs = loadBook();
    var kept = legs.filter(function (l) { return l.id !== pick.id; });
    if (kept.length === legs.length) kept.push(pick);
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

  function market(title, pairs, favKey) {
    var box = el("div", "mkt");
    box.appendChild(el("div", "mkt-t", title));
    var grid = el("div", "mkt-g");
    pairs.forEach(function (p) {
      var cell = el("div", "cell" + (p[2] === favKey ? " fav" : ""));
      cell.appendChild(el("b", null, p[1] == null ? "—" : Number(p[1]).toFixed(2)));
      cell.appendChild(el("span", null, p[0]));
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
      box.appendChild(market("Full time", [
        ["Home", g.ft.home, "home"], ["Draw", g.ft.draw, "draw"], ["Away", g.ft.away, "away"]
      ], r.fav));
      box.appendChild(market("Two chances" + (g.dc ? "" : " · worked out"), [
        ["Home or Draw", r.dc.home_draw, "home"],
        ["Home or Away", r.dc.home_away, ""],
        ["Draw or Away", r.dc.draw_away, "away"]
      ], r.fav));
      box.appendChild(market("Half time", [
        ["Home", g.ht ? g.ht.home : null, "home"],
        ["Draw", g.ht ? g.ht.draw : null, "draw"],
        ["Away", g.ht ? g.ht.away : null, "away"]
      ], r.fav));
      if (opts.checks) box.appendChild(checksBox(r));
    }
    if (opts.pickable) {
      var pick = naturalPick(g, r);
      var btn = el("button", "add" + (picked ? " on" : ""),
        picked ? pick.label + " · in slip" : "Add " + pick.label + "  " + pick.price.toFixed(2));
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var legs = toggleBook(pick);
        if (opts.onPick) opts.onPick(legs);
      });
      box.appendChild(btn);
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
    ], r.fav));
    extra.appendChild(market("Two chances" + (g.dc ? "" : " · worked out"), [
      ["Home or Draw", r.dc.home_draw, "home"],
      ["Home or Away", r.dc.home_away, ""],
      ["Draw or Away", r.dc.draw_away, "away"]
    ], r.fav));
    extra.appendChild(market("Half time", [
      ["Home", g.ht ? g.ht.home : null, "home"],
      ["Draw", g.ht ? g.ht.draw : null, "draw"],
      ["Away", g.ht ? g.ht.away : null, "away"]
    ], r.fav));
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

  function fetchGames() {
    return fetch("/api/games").then(function (r) { return r.json(); }).then(function (d) {
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

  function fetchSlips() {
    return fetch("/api/slips").then(function (r) { return r.json(); }).then(function (d) {
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
        '<a href="/book" data-nav="book">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12v12H6z"/><path d="M9 7V5h6v2"/><path d="M9 12h6"/></svg>' +
          "Book</a>" +
        '<a href="/ledger" data-nav="ledger">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h11a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2V6a2 2 0 0 1 2-2z"/></svg>' +
          "Ledger</a>" +
        '<a href="/rules" data-nav="rules">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>' +
          "Rules</a>";
      document.body.appendChild(nav);
    }
    document.querySelectorAll(".nav a").forEach(function (a) {
      if (a.getAttribute("data-nav") === active) a.classList.add("on");
    });
  }

  w.VFS = {
    cfg: cfg, defaults: DEFAULTS, labels: LABELS, save: save,
    screen: screen, naturalPick: naturalPick, acca: acca,
    loadBook: loadBook, saveBook: saveBook, toggleBook: toggleBook, inBook: inBook,
    card: card, compactRow: compactRow,
    until: until, clock: clock, dayLabel: dayLabel, leagueKey: leagueKey,
    fetchGames: fetchGames, fetchHistory: fetchHistory, fetchSlips: fetchSlips,
    paintKnobs: paintKnobs, el: el, tick: tick, copyBtn: copyBtn,
    injectChrome: injectChrome
  };
})(window);
