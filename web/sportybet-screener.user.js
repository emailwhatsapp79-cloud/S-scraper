// ==UserScript==
// @name         vFootball Screener
// @namespace    sportyfilter
// @version      0.1.0
// @description  Screens the SportyBet vFootball card for the odds shape you want and lists the survivors with their game IDs.
// @match        https://www.sportybet.com/*
// @match        https://sportybet.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------- config

  var DEFAULTS = {
    ft_fav_min: 1.50, ft_fav_max: 2.50, ft_dog_min: 3.70,
    ft_dc_fav_min: 1.17, ft_dc_fav_max: 1.30, ft_dc_dog_min: 1.89,
    ht_fav_min: 1.10, ht_fav_max: 3.00, ht_ratio_min: 1.70
  };
  var KNOBS = [
    ["ft_fav_min", "FT favourite from"], ["ft_fav_max", "FT favourite to"],
    ["ft_dog_min", "FT other side min"], ["ft_dc_fav_min", "FT fav DC from"],
    ["ft_dc_fav_max", "FT fav DC to"], ["ft_dc_dog_min", "FT other DC min"],
    ["ht_fav_min", "HT favourite from"], ["ht_fav_max", "HT favourite to"],
    ["ht_ratio_min", "HT other side ×"]
  ];
  var cfg = Object.assign({}, DEFAULTS);
  try {
    var stored = JSON.parse(localStorage.getItem("vfs.cfg") || "null");
    if (stored) Object.keys(DEFAULTS).forEach(function (k) {
      if (typeof stored[k] === "number") cfg[k] = stored[k];
    });
  } catch (e) { /* storage blocked; defaults stand */ }
  function saveCfg() { try { localStorage.setItem("vfs.cfg", JSON.stringify(cfg)); } catch (e) {} }

  // ------------------------------------------------ watch the page's traffic
  // The site's own requests teach us its endpoints, so nothing is hardcoded.

  var traffic = [];
  function note(url, text) {
    if (!text || text.length > 4e6) return;
    var head = text.slice(0, 40).trim();
    if (head[0] !== "{" && head[0] !== "[") return;
    try { traffic.push({ url: String(url), json: JSON.parse(text) }); } catch (e) {}
    if (traffic.length > 250) traffic.shift();
  }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function () {
      var args = arguments;
      var url = (args[0] && args[0].url) || String(args[0]);
      return nativeFetch.apply(this, args).then(function (res) {
        try { res.clone().text().then(function (t) { note(url, t); }, function () {}); } catch (e) {}
        return res;
      });
    };
  }
  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__vfsUrl = u; return xhrOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener("load", function () {
      try { if (typeof x.responseText === "string") note(x.__vfsUrl, x.responseText); } catch (e) {}
    });
    return xhrSend.apply(this, arguments);
  };

  // ------------------------------------------------------- reading the JSON
  // Markets are identified by their printed names, which is the one thing
  // these feeds keep stable. Everything else is found by shape.

  function walk(node, fn, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i], fn, depth + 1); return; }
    fn(node);
    for (var k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], fn, depth + 1); }
  }

  function classify(name) {
    var s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!s) return null;
    var half = /\b(1st half|first half|half time|halftime|ht)\b/.test(s);
    if (/\bdouble chance\b/.test(s)) return half ? "HT_DC" : "FT_DC";
    if (/\b(1x2|match result|three way|full time result|1 x 2)\b/.test(s)) return half ? "HT_1X2" : "FT_1X2";
    return null;
  }

  var SLOTS = {
    FT_1X2: ["home", "draw", "away"], HT_1X2: ["home", "draw", "away"],
    FT_DC: ["home_draw", "home_away", "draw_away"], HT_DC: ["home_draw", "home_away", "draw_away"]
  };

  function priceOf(o) {
    var v = o.odds != null ? o.odds : (o.price != null ? o.price : o.oddsValue);
    var n = parseFloat(v);
    return isFinite(n) && n >= 1.001 && n < 5000 ? n : null;
  }

  function readMarket(market, kind) {
    var outs = market.outcomes || market.selections || market.odds;
    if (!Array.isArray(outs) || outs.length < 3) return null;
    var slots = SLOTS[kind], got = {};
    for (var i = 0; i < outs.length; i++) {
      var price = priceOf(outs[i]);
      if (price == null) continue;
      var d = String(outs[i].desc || outs[i].description || outs[i].name || "").toLowerCase().trim();
      var key = null;
      if (kind.indexOf("1X2") > 0) {
        if (/^(home|1)$/.test(d)) key = "home";
        else if (/^(draw|x)$/.test(d)) key = "draw";
        else if (/^(away|2)$/.test(d)) key = "away";
      } else {
        if (/(home.*draw|^1x$)/.test(d)) key = "home_draw";
        else if (/(home.*away|^12$)/.test(d)) key = "home_away";
        else if (/(draw.*away|^x2$)/.test(d)) key = "draw_away";
      }
      if (!key) key = slots[i];          // fall back to the printed order
      if (key) got[key] = price;
    }
    for (var s = 0; s < slots.length; s++) { if (got[slots[s]] == null) return null; }
    return got;
  }

  function readEvent(node) {
    var markets = node.markets || node.marketList || node.market;
    if (!Array.isArray(markets) || !markets.length) return null;
    var home = node.homeTeamName || node.home ||
      (node.homeTeam && (node.homeTeam.name || node.homeTeam.teamName));
    var away = node.awayTeamName || node.away ||
      (node.awayTeam && (node.awayTeam.name || node.awayTeam.teamName));
    if (typeof home !== "string" || typeof away !== "string") return null;
    var id = node.gameId || node.eventId || node.matchId || node.id;
    if (id == null) return null;

    var ev = { id: String(id), home: home, away: away,
      league: String(node.sport && node.sport.category &&
        (node.sport.category.tournament && node.sport.category.tournament.name) ||
        node.tournamentName || node.categoryName || ""),
      kickoff: node.estimateStartTime || node.startTime || node.kickOffTime || null,
      ft: null, dc: null, ht: null };

    for (var i = 0; i < markets.length; i++) {
      var m = markets[i];
      var kind = classify(m.desc || m.description || m.name || m.marketName);
      if (!kind) continue;
      var got = readMarket(m, kind);
      if (!got) continue;
      if (kind === "FT_1X2" && !ev.ft) ev.ft = got;
      else if (kind === "FT_DC" && !ev.dc) ev.dc = got;
      else if (kind === "HT_1X2" && !ev.ht) ev.ht = got;
    }
    return ev.ft ? ev : null;
  }

  function absorb(into, ev) {
    var prev = into[ev.id];
    if (!prev) { into[ev.id] = ev; return; }
    prev.ft = prev.ft || ev.ft;            // another page may carry other markets
    prev.dc = prev.dc || ev.dc;
    prev.ht = prev.ht || ev.ht;
    prev.league = prev.league || ev.league;
    prev.kickoff = prev.kickoff || ev.kickoff;
  }

  function harvest(json, into) {
    walk(json, function (node) {
      var ev = readEvent(node);
      if (ev) absorb(into, ev);
    });
    return into;
  }

  // ------------------------------------------------------------ the screen

  function combine(a, b) { return Math.round(100 / (1 / a + 1 / b)) / 100; }

  function evaluate(ev) {
    var dc = ev.dc || { home_draw: combine(ev.ft.home, ev.ft.draw),
      home_away: combine(ev.ft.home, ev.ft.away), draw_away: combine(ev.ft.draw, ev.ft.away) };
    var fav = ev.ft.home <= ev.ft.away ? "home" : "away";
    var dog = fav === "home" ? "away" : "home";
    var favDC = fav === "home" ? dc.home_draw : dc.draw_away;
    var dogDC = dog === "home" ? dc.home_draw : dc.draw_away;
    var checks = [];

    function band(name, v, lo, hi, what) {
      var ok = v >= lo && v <= hi;
      checks.push({ name: name, ok: ok, skip: false,
        text: what + " " + v.toFixed(2) + (ok ? " in " : " outside ") + lo.toFixed(2) + "–" + hi.toFixed(2) });
    }
    function floor(name, v, lo, what) {
      var ok = v >= lo;
      checks.push({ name: name, ok: ok, skip: false,
        text: what + " " + v.toFixed(2) + (ok ? " ≥ " : " < ") + lo.toFixed(2) });
    }

    band("ft_fav", ev.ft[fav], cfg.ft_fav_min, cfg.ft_fav_max, "FT " + fav);
    floor("ft_dog", ev.ft[dog], cfg.ft_dog_min, "FT " + dog);
    band("ft_dc_fav", favDC, cfg.ft_dc_fav_min, cfg.ft_dc_fav_max, "FT " + (fav === "home" ? "1X" : "X2"));
    floor("ft_dc_dog", dogDC, cfg.ft_dc_dog_min, "FT " + (dog === "home" ? "1X" : "X2"));

    if (!ev.ht) {
      checks.push({ name: "ht_fav", ok: false, skip: true, text: "half-time odds not loaded" });
      checks.push({ name: "ht_split", ok: false, skip: true, text: "half-time odds not loaded" });
    } else {
      var hf = ev.ht[fav], hd = ev.ht[dog], ratio = hd / hf;
      band("ht_fav", hf, cfg.ht_fav_min, cfg.ht_fav_max, "HT " + fav);
      checks.push({ name: "ht_split", ok: ratio >= cfg.ht_ratio_min, skip: false,
        text: "HT " + dog + " " + hd.toFixed(2) + " is " + ratio.toFixed(2) + "× HT " + fav + " " + hf.toFixed(2) });
    }

    var failed = null, skipped = false;
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].skip) skipped = true;
      else if (!checks[i].ok && !failed) failed = checks[i];
    }
    return { ev: ev, dc: dc, fav: fav, dog: dog, checks: checks,
      verdict: failed ? "reject" : (skipped ? "needs-ht" : "show"), failure: failed };
  }

  function clearedFullTime(r) {
    for (var i = 0; i < 4; i++) { if (!r.checks[i].ok) return false; }
    return true;
  }

  // ------------------------------------------------------------- the sweep

  function sameOrigin(u) {
    try { return new URL(u, location.href).origin === location.origin; } catch (e) { return false; }
  }

  function getJSON(url) {
    return nativeFetch.call(window, url, { credentials: "include", headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /** The recorded request that yielded the most events is our list endpoint. */
  function bestListRequest() {
    var best = null;
    traffic.forEach(function (t) {
      if (!sameOrigin(t.url)) return;
      var n = Object.keys(harvest(t.json, {})).length;
      if (n && (!best || n > best.n)) best = { url: t.url, n: n };
    });
    return best;
  }

  function withParam(url, key, value) {
    try {
      var u = new URL(url, location.href);
      u.searchParams.set(key, value);
      return u.toString();
    } catch (e) { return null; }
  }

  var PAGE_KEYS = ["pageNum", "pageNo", "page", "pageIndex", "currentPage"];

  /** Walk the list endpoint's pages until it stops yielding anything new. */
  function sweep(onProgress) {
    var found = {};
    traffic.forEach(function (t) { if (sameOrigin(t.url)) harvest(t.json, found); });

    var list = bestListRequest();
    if (!list) return Promise.resolve({ events: found, endpoint: null, pages: 0 });

    var pageKey = null;
    try {
      var params = new URL(list.url, location.href).searchParams;
      for (var i = 0; i < PAGE_KEYS.length; i++) { if (params.has(PAGE_KEYS[i])) { pageKey = PAGE_KEYS[i]; break; } }
    } catch (e) {}
    if (!pageKey) pageKey = "pageNum";

    // Page 1 usually repeats what the site already fetched, so "nothing new"
    // cannot be the stop signal. Stop when a page carries no games at all, or
    // when it carries exactly the same ones as the page before it - which is
    // what an endpoint that ignores the page parameter looks like.
    var pages = 0, lastSignature = null;
    function nextPage(n) {
      if (n > 40) return Promise.resolve();
      var url = withParam(list.url, pageKey, n);
      if (!url) return Promise.resolve();
      return getJSON(url).then(function (json) {
        if (!json) return;
        var page = harvest(json, {});
        var ids = Object.keys(page);
        if (!ids.length) return;
        var signature = ids.slice().sort().join(",");
        if (signature === lastSignature) return;
        lastSignature = signature;
        pages++;
        ids.forEach(function (id) { absorb(found, page[id]); });
        onProgress(Object.keys(found).length);
        return nextPage(n + 1);
      });
    }

    return nextPage(1).then(function () {
      return { events: found, endpoint: list.url, pages: pages };
    });
  }

  /** Only games that already cleared the full-time checks are worth a detail call. */
  function fillHalfTime(candidates, onProgress) {
    var detail = null;
    traffic.forEach(function (t) {
      if (!sameOrigin(t.url)) return;
      var ids = Object.keys(harvest(t.json, {}));
      if (ids.length === 1 && /event|match|game|detail/i.test(t.url)) detail = t.url;
    });
    if (!detail) return Promise.resolve(0);

    var known = null;
    traffic.some(function (t) {
      var ids = Object.keys(harvest(t.json, {}));
      if (ids.length === 1 && t.url === detail) { known = ids[0]; return true; }
      return false;
    });
    if (!known) return Promise.resolve(0);

    var filled = 0, queue = candidates.slice(), running = 0;
    return new Promise(function (resolve) {
      function pump() {
        if (!queue.length && running === 0) return resolve(filled);
        while (running < 4 && queue.length) {
          var ev = queue.shift();
          running++;
          getJSON(detail.split(known).join(ev.id)).then(function (json) {
            if (json) {
              var one = harvest(json, {});
              var got = one[ev.id];
              if (got) { ev.ht = ev.ht || got.ht; ev.dc = ev.dc || got.dc; if (got.ht) filled++; }
            }
            running--; onProgress(); pump();
          });
        }
      }
      pump();
    });
  }

  // ------------------------------------------------------------------- UI

  var CSS = [
    "#vfs,#vfs *{box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,sans-serif}",
    "#vfs-open{position:fixed;right:14px;bottom:88px;z-index:2147483000;background:#111;color:#fff;",
    "border:1px solid #333;border-radius:24px;padding:11px 18px;font-size:15px;font-weight:600;cursor:pointer;",
    "box-shadow:0 4px 16px rgba(0,0,0,.4)}",
    "#vfs{position:fixed;inset:0;z-index:2147483001;background:#0d0f13;color:#e9edf3;display:flex;",
    "flex-direction:column;font-size:15px}",
    "#vfs header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #232a33;flex:0 0 auto}",
    "#vfs header b{font-size:17px;font-weight:600;flex:1}",
    "#vfs button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #2c343f;background:#1a1f27;color:#e9edf3;padding:9px 14px}",
    "#vfs button.go{background:#1f9d57;border-color:#1f9d57;color:#fff;font-weight:600;font-size:16px;padding:13px}",
    "#vfs button.go[disabled]{opacity:.55;cursor:default}",
    "#vfs .body{flex:1 1 auto;overflow-y:auto;padding:14px 16px 40px}",
    "#vfs .count{font-size:15px;color:#96a1b0;margin:0 0 12px;font-variant-numeric:tabular-nums}",
    "#vfs .count b{color:#e9edf3}",
    "#vfs .track{height:6px;background:#1a1f27;border-radius:3px;overflow:hidden;margin:0 0 14px}",
    "#vfs .track i{display:block;height:100%;background:#1f9d57;width:0;transition:width .25s}",
    "#vfs .hit{border:1px solid #232a33;border-left:3px solid #1f9d57;border-radius:10px;background:#141920;margin-bottom:8px}",
    "#vfs .hit.partial{border-left-color:#4b7fc4}",
    "#vfs .hit .top{display:flex;align-items:center;gap:12px;padding:12px 13px}",
    "#vfs .gid{font-family:ui-monospace,Menlo,monospace;font-size:19px;font-weight:600;letter-spacing:.02em}",
    "#vfs .who{flex:1;min-width:0}",
    "#vfs .who .t{font-size:16px;font-weight:600}",
    "#vfs .who .m{font-size:12.5px;color:#8b95a3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#vfs .copy{padding:8px 13px;font-size:13.5px}",
    "#vfs .odds{display:flex;gap:16px;flex-wrap:wrap;padding:0 13px 11px;font-size:13px;color:#96a1b0;",
    "font-variant-numeric:tabular-nums}",
    "#vfs .odds b{color:#e9edf3;font-weight:600}",
    "#vfs .msg{color:#8b95a3;font-size:14px;line-height:1.55;padding:18px 0}",
    "#vfs .msg code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#c3cbd6}",
    "#vfs .knobs{display:none;grid-template-columns:1fr auto;gap:7px 12px;align-items:center;",
    "padding:13px;border:1px solid #232a33;border-radius:10px;margin-bottom:14px;background:#141920}",
    "#vfs .knobs.on{display:grid}",
    "#vfs .knobs label{font-size:13.5px;color:#96a1b0}",
    "#vfs .knobs input{width:80px;text-align:right;font:inherit;font-family:ui-monospace,Menlo,monospace;",
    "font-size:13.5px;background:#0d0f13;color:#e9edf3;border:1px solid #2c343f;border-radius:6px;padding:5px 8px}"
  ].join("");

  var ui = null;

  function esc(s) { return String(s).replace(/[<>&"]/g, function (c) {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]; }); }

  function timeOf(ev) {
    if (!ev.kickoff) return "";
    var n = Number(ev.kickoff);
    var d = new Date(isFinite(n) && n > 1e11 ? n : ev.kickoff);
    return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 5);
  }

  function build() {
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var panel = document.createElement("div");
    panel.id = "vfs";
    panel.hidden = true;
    panel.innerHTML =
      '<header><b>vFootball Screener</b>' +
      '<button id="vfs-knobs">Odds</button><button id="vfs-close">Close</button></header>' +
      '<div class="body">' +
      '<div class="knobs" id="vfs-knobbox"></div>' +
      '<button class="go" id="vfs-find" style="width:100%;margin-bottom:16px">FIND GAMES</button>' +
      '<p class="count" id="vfs-count">Tap FIND to sweep the card.</p>' +
      '<div class="track"><i id="vfs-bar"></i></div>' +
      '<div id="vfs-out"></div></div>';
    document.body.appendChild(panel);

    var opener = document.createElement("button");
    opener.id = "vfs-open";
    opener.textContent = "SCREEN";
    document.body.appendChild(opener);

    var box = panel.querySelector("#vfs-knobbox");
    KNOBS.forEach(function (k) {
      var label = document.createElement("label");
      label.textContent = k[1];
      label.htmlFor = "vfs_" + k[0];
      var input = document.createElement("input");
      input.type = "number"; input.step = "0.01"; input.id = "vfs_" + k[0];
      input.value = cfg[k[0]].toFixed(2);
      input.addEventListener("change", function () {
        var v = parseFloat(input.value);
        if (isFinite(v) && v > 0) { cfg[k[0]] = v; saveCfg(); }
        input.value = cfg[k[0]].toFixed(2);
      });
      box.appendChild(label); box.appendChild(input);
    });

    opener.addEventListener("click", function () { panel.hidden = false; });
    panel.querySelector("#vfs-close").addEventListener("click", function () { panel.hidden = true; });
    panel.querySelector("#vfs-knobs").addEventListener("click", function () {
      box.classList.toggle("on");
    });
    panel.querySelector("#vfs-find").addEventListener("click", run);

    ui = {
      panel: panel, find: panel.querySelector("#vfs-find"),
      count: panel.querySelector("#vfs-count"), bar: panel.querySelector("#vfs-bar"),
      out: panel.querySelector("#vfs-out")
    };
  }

  function say(text, pct) {
    ui.count.innerHTML = text;
    if (pct != null) ui.bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }

  function render(results, scanned) {
    var keep = results.filter(function (r) { return r.verdict !== "reject"; });
    keep.sort(function (a, b) { return (a.verdict === "show" ? 0 : 1) - (b.verdict === "show" ? 0 : 1); });

    ui.out.textContent = "";
    if (!keep.length) {
      var p = document.createElement("p");
      p.className = "msg";
      p.textContent = "Went through " + scanned + " games. None matched. Loosen the numbers under Odds, or try again when the card refreshes.";
      ui.out.appendChild(p);
      return;
    }
    keep.forEach(function (r) {
      var ev = r.ev, when = timeOf(ev);
      var card = document.createElement("div");
      card.className = "hit" + (r.verdict === "show" ? "" : " partial");
      card.innerHTML =
        '<div class="top"><span class="gid">' + esc(ev.id) + '</span>' +
        '<span class="who"><span class="t">' + esc(ev.home) + " v " + esc(ev.away) + '</span>' +
        '<span class="m">' + esc([when, ev.league, r.verdict === "show" ? "" : "no half-time odds"]
          .filter(Boolean).join(" · ")) + '</span></span>' +
        '<button class="copy">Copy ID</button></div>' +
        '<div class="odds"><span>FT <b>' + ev.ft.home.toFixed(2) + "</b> / <b>" + ev.ft.draw.toFixed(2) +
        "</b> / <b>" + ev.ft.away.toFixed(2) + '</b></span>' +
        '<span>DC <b>' + r.dc.home_draw.toFixed(2) + "</b> / <b>" + r.dc.draw_away.toFixed(2) + '</b></span>' +
        (ev.ht ? '<span>HT <b>' + ev.ht.home.toFixed(2) + "</b> / <b>" + ev.ht.draw.toFixed(2) +
          "</b> / <b>" + ev.ht.away.toFixed(2) + '</b></span>' : "") + "</div>";
      card.querySelector(".copy").addEventListener("click", function () {
        var b = this;
        navigator.clipboard.writeText(ev.id).then(function () {
          b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy ID"; }, 1500);
        }, function () { b.textContent = ev.id; });
      });
      ui.out.appendChild(card);
    });
  }

  function nothingFound() {
    var p = document.createElement("p");
    p.className = "msg";
    p.innerHTML = "Could not see the card yet. Go to the <b>vFootball</b> list, let the games appear, " +
      "then tap FIND again.<br><br>If it still finds nothing, tap <code>Odds</code> → " +
      "hold this button to copy what it did see, and send it over.";
    var dump = document.createElement("button");
    dump.textContent = "Copy diagnostics";
    dump.style.marginTop = "10px";
    dump.addEventListener("click", function () {
      var report = traffic.filter(function (t) { return sameOrigin(t.url); }).slice(-12).map(function (t) {
        return { url: t.url, sample: JSON.stringify(t.json).slice(0, 3000) };
      });
      navigator.clipboard.writeText(JSON.stringify(report, null, 1));
      dump.textContent = "Copied — paste it to Claude";
    });
    ui.out.appendChild(p);
    ui.out.appendChild(dump);
  }

  function run() {
    ui.find.disabled = true;
    ui.out.textContent = "";
    say("Sweeping the card…", 4);

    sweep(function (n) { say("Reading the card… <b>" + n + "</b> games so far", Math.min(55, 6 + n / 18)); })
      .then(function (res) {
        var all = Object.keys(res.events).map(function (k) { return res.events[k]; });
        if (!all.length) { say("Nothing found."); nothingFound(); return null; }

        var first = all.map(evaluate);
        var need = first.filter(function (r) { return r.verdict === "needs-ht" && clearedFullTime(r); })
                        .map(function (r) { return r.ev; });
        say("Went through <b>" + all.length + "</b> games. " + need.length +
            " passed the full-time checks — fetching half-time odds…", 60);
        if (!need.length) return { all: all, scanned: all.length };

        var done = 0;
        return fillHalfTime(need, function () {
          done++;
          say("Went through <b>" + all.length + "</b> games. Half-time odds " + done + " of " + need.length + "…",
              60 + (done / need.length) * 38);
        }).then(function () { return { all: all, scanned: all.length }; });
      })
      .then(function (out) {
        if (!out) return;
        var results = out.all.map(evaluate);
        var hits = results.filter(function (r) { return r.verdict === "show"; }).length;
        say("Went through <b>" + out.scanned + "</b> games — <b>" + hits + "</b> matched.", 100);
        render(results, out.scanned);
      })
      .catch(function (err) {
        say("Something went wrong: " + err.message);
        nothingFound();
      })
      .then(function () { ui.find.disabled = false; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
