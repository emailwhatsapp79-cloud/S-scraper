(function (w) {
  "use strict";

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
    var failed = null, skipped = false, failedHt = null;
    checks.forEach(function (c) {
      if (c.skip) skipped = true;
      else if (!c.ok) {
        if (c.name.indexOf("ht_") === 0) { if (!failedHt) failedHt = c; }
        else if (!failed) failed = c;
      }
    });
    return {
      ev: g, dc: dc, fav: fav, dog: dog, checks: checks,
      failure: failed || failedHt || null,
      // Favourite shape (FT + DC) keeps the game on Matches. HT miss/fail is a hold, not a vanishing reject.
      verdict: failed ? "reject" : (skipped || failedHt ? "hold" : "show")
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
        extra +
        '<a class="gear-btn" href="/rules" data-nav="rules" aria-label="Rules" title="Rules">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
        '</a>' +
        '<button class="ghost lock-btn" type="button" id="vfs-lock" aria-label="Lock">Lock</button>';
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
        '<a href="/lab" data-nav="lab">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6l-5 8a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-8V3"/><path d="M8 3h8M8 13h8"/></svg>' +
          "Lab</a>";
      document.body.appendChild(nav);
    }
    document.querySelectorAll(".nav a, .gear-btn").forEach(function (a) {
      if (a.getAttribute("data-nav") === active) a.classList.add("on");
    });
    paintSlip();
    var lb = document.getElementById("vfs-lock");
    if (lb && !lb.getAttribute("data-bound")) {
      lb.setAttribute("data-bound", "1");
      lb.addEventListener("click", lockNow);
    }
    gateCheck();
  }

  function showLock() {
    if (document.getElementById("gate")) return;
    document.body.classList.add("locked");
    var gate = el("div", "gate");
    gate.id = "gate";
    gate.innerHTML =
      '<div class="gate-box">' +
        '<div class="mark" aria-hidden="true">VF</div>' +
        '<b>vFootball</b>' +
        '<p>Enter your code</p>' +
        '<div class="dots" id="gate-dots"></div>' +
        '<p class="err" id="gate-err" hidden></p>' +
        '<div class="pad" id="gate-pad"></div>' +
      "</div>";
    document.body.appendChild(gate);
    var pin = "";
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
        if (!d.open) {
          pin = "";
          paintDots();
          var e = document.getElementById("gate-err");
          e.hidden = false;
          e.textContent = "Wrong code";
          return;
        }
        document.body.classList.remove("locked");
        gate.remove();
        location.reload();
      }).catch(function () {
        pin = "";
        paintDots();
      });
    }
    var pad = document.getElementById("gate-pad");
    ["1","2","3","4","5","6","7","8","9","","0","⌫"].forEach(function (ch) {
      var b = el("button", "key" + (ch === "" ? " ghost" : ""), ch === "⌫" ? "⌫" : ch);
      b.type = "button";
      if (!ch) { b.disabled = true; b.textContent = ""; }
      else b.addEventListener("click", function () { press(ch); });
      pad.appendChild(b);
    });
    paintDots();
  }

  function gateCheck() {
    fetch("/api/gate").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.open) showLock();
      else hydrate();
    }).catch(function () { showLock(); });
  }

  function lockNow() {
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
    if (!slips || !slips.length) return;
    var seen = pingSeen();
    slips.forEach(function (sp) {
      (sp.legs || []).forEach(function (l) {
        if (l.won !== true && l.won !== false) return;
        var k = "leg-" + sp.id + "-" + l.gameId + "-" + (l.won ? "yes" : "no");
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

  function enablePings() {
    if (!("Notification" in window)) return Promise.reject(new Error("This browser will not ping"));
    return Notification.requestPermission().then(function (p) {
      if (p !== "granted") throw new Error("Notifications are off");
      var ready = navigator.serviceWorker
        ? navigator.serviceWorker.register("/sw.js").then(function () { return subscribePush(); })
        : Promise.resolve();
      return ready.then(function () {
        ping("Pings on", "Yes, No, and the full bet — even if the phone is locked.", "ping-test", "yes");
        return p;
      });
    });
  }

  if (navigator.serviceWorker && "Notification" in window && Notification.permission === "granted") {
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

  function matchState(l) {
    if (l.won === true || l.won === false || /^end/i.test(l.status || "")) return "ended";
    if (/^(H1|H2|HT|1H|2H|LIVE)/i.test(l.status || "")) return "live";
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

  function phaseLabel(l, st) {
    if (st === "ended") return "FT";
    var status = l.status || "LIVE";
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
    }
    row.appendChild(left);

    var mid = el("div", "leg-mid");
    var pair = scorePair(l);
    if (st === "wait") {
      mid.appendChild(el("div", "kick", clock(l.kickoff) || "—"));
      var t = until(l.kickoff);
      if (t.text && t.text !== "kicked off") mid.appendChild(el("div", "phase", t.text));
    } else {
      var a = pair ? pair[0] : 0, b = pair ? pair[1] : 0;
      mid.appendChild(el("div", "scoreboard", a + " – " + b));
      mid.appendChild(el("div", "phase", phaseLabel(l, st)));
    }
    row.appendChild(mid);

    var mark;
    if (l.won === true) mark = el("div", "yes", "Yes");
    else if (l.won === false) mark = el("div", "no", "No");
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

    if (sp.shareCode) {
      var code = el("div", "codebox");
      code.appendChild(el("div", "mkt-t", "SportyBet code"));
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
      if (sp.shareUrl) {
        var link = document.createElement("a");
        link.href = String(sp.shareUrl).replace(/^http:\/\//, "https://");
        link.textContent = "Open on SportyBet";
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
    return card;
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
    screen: screen, makePick: makePick, acca: acca,
    loadBook: loadBook, saveBook: saveBook, toggleBook: toggleBook, inBook: inBook,
    card: card, compactRow: compactRow,
    until: until, clock: clock, dayLabel: dayLabel, byKick: byKick,
    leagueKey: leagueKey, teamsBlock: teamsBlock, crest: crest,
    fetchGames: fetchGames, fetchHistory: fetchHistory, fetchSlips: fetchSlips, fetchPicks: fetchPicks,
    paintKnobs: paintKnobs, el: el, tick: tick, copyBtn: copyBtn,
    injectChrome: injectChrome, paintSlip: paintSlip,
    naira: naira, wilson: wilson, legStats: legStats, slipCard: slipCard,
    pickCard: pickCard, pickStats: pickStats,
    dcWon: dcWon, zFor: zFor, analyse: analyse, fetchAnalytics: fetchAnalytics
  };
})(window);
