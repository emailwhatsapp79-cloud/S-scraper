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
- **A leg may sit on every code only if it is a banker**: it passes every check with no warning at all (no favourite under, no thin head-to-head, no "shaky before", no price drift). Everything else varies between codes, so one doubtful leg can't sink every ticket (30 Oct, owner: shared legs are what make the odds; the mistake was sharing a doubtful one. Esenler, an under on a 1.87 favourite, sat on all four codes and sank them all).

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
- A line qualifies only if it **cleared 85%+** of both teams' **last 10 games each** (football: all competitions; NBA: the last 10 this season) and pays 1.20–1.39 (30 Oct: 20 games reach back about 5 months, with different players and sometimes a different coach).
- **Football games 11–20 are a warning, not a drop**: a line that cleared under 75% of them is shown "⚠️ shaky before", so pick the cleaner leg (30 Oct: BK Olympic looked 17/20 on 10 games, but scored 3+ in 6 of their last 20).
- **Head-to-head: the last 8 meetings, in football and the NBA** (TT keeps 20: they meet that often in a week). Teams meet 2–4 times a year, so 10+ meetings would reach back 3–5 years.
- **Rate every game of the day, all leagues, men's and women's** (women are only excluded in TT and tennis), then screen (29 Oct).
- **Corners are off by default** (`NO_CORNERS=1`): the corner slip lost and the corner checks make a run take ~10 minutes instead of ~30 seconds (29 Oct).
- Watch for **big mismatches outside cups too** (Al Nassr, Gangwon): skip unders on a team that can run up the score.
- **Head-to-head too: drop a line the two teams broke in 2+ of their last 8 meetings** (29 Oct: Braga had scored 3+ against Famalicao in 2 of 8, and their under 2.5 was at risk). Football "never met" games are flagged, not dropped (lower-league cup ties often have no shared history). Built into `fb_lines.mjs`.
- On a long slip, **weigh a cash-out when the last games kick off**: once the early legs are in, the late games hold all the risk (29 Oct: TBRDT2 was 8 of 10 with Braga and Hoek left).
- Markets checked in football: total goals, team goals, first-half goals, corners (total and each team), **home win / away win** (31 Oct), double chance (home or draw, draw or away), both teams to score, draw no bet. Any of them goes on a slip when it passes the same checks.
- **One line per game.** At the same hit rate, take the line with **more room**, not the higher price (28 Oct).
- **No under on the favourite's own goals when the favourite is priced under 2.00**, in any game, league or cup (30 Oct). Esenler at 1.87 went from 0-1 down to 3-1, Flamengo scored 4, Leverkusen 5: a favourite that falls behind keeps attacking. Use the total line or the underdog's goals instead. Built into `fb_lines.mjs`.
- **Head-to-head meetings older than 2 years count less** (30 Oct): two breaks in the last 2 years drop a line; older breaks only drop it when there are 3+ breaks in all; under 3 recent meetings is flagged "thin". Built into `fb_lines.mjs`.
- **One team's goals: each side must clear 80% on its own** (30 Oct: Colo-Colo under 3.5 lost 6-1; Colo-Colo's tight record hid that Concepcion had conceded 3+ in 4 of their last 20). The team's goals scored and the opponent's goals conceded are checked separately, not just added together. Built into `fb_lines.mjs`.
- **Drop a leg whose price drifts 25%+ before kickoff** (e.g. 1.30 → 1.63 or more): the bookmaker has news we don't (30 Oct: Coventry U21 over 2.5 went 1.30 → 1.86 and finished 1-0).
- **Total over 1.5: the weaker attack must not blank often** (no more than 4 of their last 20). The over then rests on one team (30 Oct: Seraing v Liege over 1.5 finished 1-0; Liege had failed to score in 7 of their last 20).
- **Cup ties with a big favourite (1.40 or shorter): no total-goals under and no under on the favourite's goals** (28 Oct; Leverkusen won 5-2 against Nuremberg, and their last 10 were against equals). Built into `fb_lines.mjs`.
- Football settles on **90 minutes**; extra time and penalties don't count (Vantage grades it that way since PR #68).
- **Before a leg goes on a slip, a deep check** (29 Oct, owner: "rating something alone doesn't mean that just because it played under 16/17"):
  - **Both sides of the line**: look at how often the other side landed and where the main line sits (`nba_both.mjs` prints every line, over and under). An alternative line far from the bookmaker's main line is not "free"; say how far it is.
  - **Head-to-head in the NBA too**, with the same 2-year weighting as football (built into `nba_lines.mjs`): drop a line the two teams broke in 2+ of their last 8 meetings (Pelicans v Kings under 248.5 cleared 16/17 this season but went over in 2 of 8 meetings, 256 and 273).
  - **Missing players**: list injuries and suspensions (ESPN summary) and say which way they push the line.
  - **Team strength**: league position and goal difference; a leader against a mid-table side is a "can run up the score" case for unders on the leader (Flamengo 1st v Vasco 13th).
  - TT: `tt_deep.mjs` prints the last 10 meetings and both players' last 12 with set points. Drop a pick whose recent results alternate win/loss (Petrea, 29 Oct: about half of his last 12).
  - Football: `fb_deep.mjs` prints both teams' last 20 with half-times and the last 8 meetings.
- **NBA overs are riskier than unders**: one cold shooting night sinks an over (29 Oct, Pistons v Hornets 186 against over 201.5, after 14/16 cleared it). Prefer unders; take an over only with a big cushion.
- **NBA stays on ₦100 test slips** until teams have about 15+ regular-season games; early samples include preseason.
- First-half legs are fine on test slips. On a main slip, flag them: they can swing the slip on a coin flip (28 Oct, Bayern).

## Cash out
- When reporting live slips: give the exact Lagos time, each match's minute and score, and each leg's odds now (29 Oct).
- Cash-out is a judgement call; auto cash-out stays paused. Compare the offer with the slip's real value (remaining legs' chance × payout). Take it when it's clearly above that.
