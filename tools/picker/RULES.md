# Picking rules

The owner's rules for building slips, and why each one exists. The scripts in this folder apply them; this file is the record, so they survive a new session.

Run the scripts from `site/` with `DATABASE_URL` set (TT and tennis need the database; football, NBA and `tt_nodb.mjs` do not), e.g. `node ../tools/picker/fb_lines.mjs <eventId> ...`.

## Every slip
- No leg under **1.20** (26 Oct) and none at **1.40 or more** (27 Oct). On our own 427 graded legs, 1.40–1.49 won 56% and 1.50+ won 50%.
- **No player or team in two legs** of one slip (24 Oct, Rak lost both of his legs on WTCVHB).
- **Show every warning** on every leg, including pick-side notes like "lost earlier today", when giving a code (27 Oct: Loboda's loss as favourite was left out).
- State clearly at the top when a code has tennis legs ("⚠️ includes N tennis legs").
- Give the realistic chance of the whole slip winning.
- Keep main slips to about 4–6 legs; long slips are for ₦100 tests only.

## Table tennis (`best_now.mjs`, `tt_nodb.mjs` while the database is down)
- Tags: Strong ≥75% (30+ games each), Good ≥70%, Lean ≥65%. Prefer Strong, then Good, Leans only if needed.
- Never a watch-list player (`site/api/_tt_watch.js`); no women's games.
- Skip when our % is more than 5 above SportyBet's (gap rule).
- No Good/Lean game where either player won as the underdog today; Strong passes.
- **Players must have met before** (27 Oct, Lobas lost 0-3 to Naida on a first meeting).
- **No Lean whose picked player has a warning note** (lost today as favourite / 0-3, under 10 priced games) (27 Oct).
- Leave out a Setka pick whose **last match was a swing**: every set won or lost by 4+ points, back and forth (24 Oct; those picks won 62% v 70%).
- Drop a **Strong** Setka pick who **lost from 2-1 up in the last 3 days** (26 Oct; 15/27 = 56% v 82%). `tt_nodb.mjs` applies it to every tag.
- No **Czech Liga Pro or TT Cup** (27 Oct; 58% v 72%).

## Tennis (`tn_best.mjs`)
- Men's ATP / Challenger only; no ITF, UTR, SRL or women's.
- **Good or Strong only** (27 Oct; tennis Leans won 53%).
- Players must have met before. No pick who won under 60% as our favourite (4+ games). Tennis watch list in `tn_watch.txt`.

## Football (`fb_lines.mjs`) and NBA (`nba_lines.mjs`)
- A line qualifies only if it **cleared 85%+** of both teams' recent games (last 10 each in football, this season's games in the NBA) and pays 1.20–1.39.
- Markets checked in football: total goals, team goals, first-half goals, corners (total and each team), double chance, both teams to score, draw no bet.
- **One line per game.** At the same hit rate, take the line with **more room**, not the higher price (28 Oct).
- **Cup ties with a big favourite (1.40 or shorter): no total-goals under and no under on the favourite's goals** (28 Oct; Leverkusen won 5-2 against Nuremberg, and their last 10 were against equals). Built into `fb_lines.mjs`.
- Football settles on **90 minutes**; extra time and penalties don't count (Vantage grades it that way since PR #68).
- First-half legs are fine on test slips. On a main slip, flag them: they can swing the slip on a coin flip (28 Oct, Bayern).

## Cash out
- Cash-out is a judgement call; auto cash-out stays paused. Compare the offer with the slip's real value (remaining legs' chance × payout). Take it when it's clearly above that.
