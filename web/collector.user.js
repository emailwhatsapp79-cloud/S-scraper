// ==UserScript==
// @name         vFootball Collector
// @namespace    sportyfilter
// @version      1.0.0
// @description  Sends the full SportyBet vFootball card to your screener. Runs on sportybet.com, where the full list is actually available.
// @match        https://www.sportybet.com/*
// @match        https://sportybet.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  var SITE  = "https://vfootball-screener.vercel.app";
  var TOKEN = "3h-xIDBjwpaZ42mWOYdlOw_iCB2Jlm6k";

  var SPORT = "sr:sport:202120001";
  var LEAGUES = ["sv:league:1", "sv:league:2", "sv:league:3", "sv:league:4", "sv:league:5"];
  var MARKETS = "1,10,60";                       // 1X2, Double Chance, 1st Half - 1X2
  var WANTED  = { "1X2": "ft", "Double Chance": "dc", "1st Half - 1X2": "ht" };
  var EVERY_MS = 4 * 60 * 1000;

  // The full card is POST-only. That is fine here: this runs on sportybet.com,
  // so it is same-origin and the request is an ordinary one from your browser.
  function fetchPage(tournamentId, pageNum) {
    return fetch("/api/ng/factsCenter/wapEvents", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sportId: SPORT, tournamentId: tournamentId, marketId: MARKETS,
        pageSize: 100, pageNum: pageNum, option: 1,
        withTwoUpMarket: true, withOneUpMarket: true,
      }),
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function collect(node, out) {
    out = out || [];
    if (Array.isArray(node)) { node.forEach(function (n) { collect(n, out); }); return out; }
    if (!node || typeof node !== "object") return out;
    if (node.gameId && node.homeTeamName) out.push(node);
    Object.keys(node).forEach(function (k) { collect(node[k], out); });
    return out;
  }

  function legs(market) {
    var by = {};
    (market.outcomes || []).forEach(function (o) {
      var p = parseFloat(o.odds);
      if (isFinite(p)) by[o.desc] = p;
    });
    return by;
  }

  function normalise(ev) {
    if ((ev.sport || {}).id !== SPORT) return null;       // never send other sports
    var got = {};
    (ev.markets || []).forEach(function (m) {
      var slot = WANTED[m.desc];
      if (slot && !got[slot]) got[slot] = legs(m);
    });
    var ft = got.ft;
    if (!ft || ft.Home == null || ft.Draw == null || ft.Away == null) return null;
    var dc = got.dc, ht = got.ht;
    return {
      id: String(ev.gameId), eventId: ev.eventId || "",
      home: ev.homeTeamName || "?", away: ev.awayTeamName || "?",
      league: ev.tournamentName || ev.categoryName || "",
      kickoff: ev.estimateStartTime || null, status: ev.matchStatus || "",
      ft: { home: ft.Home, draw: ft.Draw, away: ft.Away },
      dc: dc && dc["Home or Draw"] != null
        ? { home_draw: dc["Home or Draw"], home_away: dc["Home or Away"], draw_away: dc["Draw or Away"] }
        : null,
      ht: ht && ht.Home != null ? { home: ht.Home, draw: ht.Draw, away: ht.Away } : null,
    };
  }

  function sweep(onProgress) {
    var found = {}, li = 0;
    function league() {
      if (li >= LEAGUES.length) return Promise.resolve(found);
      var tid = LEAGUES[li++], page = 1, lastIds = "";
      function next() {
        if (page > 20) return league();
        return fetchPage(tid, page++).then(function (json) {
          if (!json) return league();
          var evs = collect(json.data);
          if (!evs.length) return league();
          var ids = evs.map(function (e) { return e.gameId; }).sort().join(",");
          if (ids === lastIds) return league();       // endpoint ignored the page
          lastIds = ids;
          evs.forEach(function (e) {
            var g = normalise(e);
            if (g) found[g.id] = g;
          });
          onProgress(Object.keys(found).length, li);
          return next();
        });
      }
      return next();
    }
    return league();
  }

  function push(games) {
    return fetch(SITE + "/api/card", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-push-token": TOKEN },
      body: JSON.stringify({ games: games }),
    }).then(function (r) { return r.json(); });
  }

  // ---- the badge -------------------------------------------------------

  var badge = document.createElement("div");
  badge.style.cssText = "position:fixed;right:10px;bottom:74px;z-index:2147483000;" +
    "background:#10151c;color:#dfe5ee;border:1px solid #2b3440;border-radius:20px;" +
    "padding:8px 14px;font:600 13px -apple-system,Roboto,sans-serif;cursor:pointer;" +
    "box-shadow:0 3px 14px rgba(0,0,0,.45);max-width:76vw";
  function say(text, colour) {
    badge.textContent = text;
    badge.style.color = colour || "#dfe5ee";
  }
  say("Send card");

  var busy = false;
  function run(auto) {
    if (busy) return;
    busy = true;
    say("Reading…");
    sweep(function (n, league) { say("Reading… " + n + " games (" + league + "/5)"); })
      .then(function (found) {
        var games = Object.keys(found).map(function (k) { return found[k]; });
        if (!games.length) {
          say("Found 0 — open vFootball first", "#f0868f");
          return;
        }
        say("Sending " + games.length + "…");
        return push(games).then(function (r) {
          if (r && r.ok) say("Sent " + r.stored + " · " + r.total + " stored", "#54d48c");
          else say("Rejected: " + ((r && r.error) || "unknown"), "#f0868f");
        });
      })
      .catch(function (e) { say("Failed: " + e.message, "#f0868f"); })
      .then(function () {
        busy = false;
        if (auto) setTimeout(function () { run(true); }, EVERY_MS);
      });
  }

  badge.addEventListener("click", function () { run(false); });
  document.body.appendChild(badge);

  // Collect on its own too, so leaving the tab open keeps the card fresh.
  setTimeout(function () { run(true); }, 4000);
})();
