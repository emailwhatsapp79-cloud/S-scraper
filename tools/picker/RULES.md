# Picking rules

The owner's rules for building slips, and why each one exists. The scripts in this folder apply them; this file is the record, so they survive a new session.

Run the scripts from `site/` with `DATABASE_URL` set (TT and tennis need the database; football, NBA and `tt_nodb.mjs` do not), e.g. `node ../tools/picker/fb_lines.mjs <eventId> ...`.

## Every slip
- Legs priced **1.20–1.39** (26–27 Oct; the 1 Nov 1.10–1.70 football trial was dropped the same day for the first-day window). On our own 427 graded legs, 1.40–1.49 won 56% and 1.50+ won 50%.
- **No player or team in two legs** of one slip (24 Oct, Rak lost both of his legs on WTCVHB).
- **Show every warning** on every leg, including pick-side notes like "lost earlier today", when giving a code (27 Oct: Loboda's loss as favourite was left out).
- State clearly at the top when a code has tennis legs ("⚠️ includes N tennis legs").
- Give the realistic chance of the whole slip winning.
- **The main slip is the best legs, not a size.** No cap on legs or odds (1 Nov, owner: a strong leg on a short main slip sank everything anyway).
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
- A line qualifies only if it **cleared 85%+** of both teams' **last 10 games each** (football: all competitions; NBA: the last 10 this season) at the right price (30 Oct: 20 games reach back about 5 months, with different players and sometimes a different coach).
- **Head-to-head: the last 8 meetings, in football and the NBA** (TT keeps 20: they meet that often in a week). Teams meet 2–4 times a year, so 10+ meetings would reach back 3–5 years.
- **Rate every game of the day, all leagues, men's and women's** (women are only excluded in TT and tennis), then screen (29 Oct).
- **Corners are off by default** (`NO_CORNERS=1`): the corner slip lost and the corner checks make a run take ~10 minutes instead of ~30 seconds (29 Oct).
- **Head-to-head too: drop a line the two teams broke in 2+ of their last 8 meetings** (29 Oct: Braga had scored 3+ against Famalicao in 2 of 8, and their under 2.5 was at risk). Football "never met" games are flagged, not dropped (lower-league cup ties often have no shared history). Built into `fb_lines.mjs`.
- On a long slip, **weigh a cash-out when the last games kick off**: once the early legs are in, the late games hold all the risk (29 Oct: TBRDT2 was 8 of 10 with Braga and Hoek left).
- Markets checked in football: total goals, team goals, first-half goals, corners (total and each team), **home win / away win** (31 Oct), double chance (home or draw, draw or away), both teams to score, draw no bet. Any of them goes on a slip when it passes the same checks.
- **Unders: no under where the favourite is strong and likes scoring** (owner, 1 Nov; replaces the 30 Oct-1 Nov under rules: total 4.5+ only, weak attack, cup favourite, mismatch).
  - **Strong v weak** (favourite at 1.70 or shorter, underdog at 4.00 or longer, or a high scorer against a leaky defence): no total or first-half total under, and no under on the **favourite's** goals. An under on the **weak team's** goals is fine. If the favourite keeps scoring, book its over / to score instead.
  - **A favourite that likes scoring** (2+ goals in 5 of its last 10): no total under and no under on its goals.
  - Every other under, in balanced games (total, one team, first half), is judged on the numbers alone.
  Losses behind it: Jerv 7-0, Cliftonville 7-1, Aluminij 5-0, Colo-Colo 6-1, Esenler, Flamengo, Leverkusen. Built into `fb_lines.mjs`.
- **The best legs go in**, whatever the market: win, double chance, under, over, first half (owner, 1 Nov: no market order and no cap on overs; first-half legs are fine when they are strong).
- **No legs without live coverage on a slip you may want to cash out** (3 Nov: Bracknell v Chertsey, English 7th tier, showed "not started" on SportyBet all game and kept PSN6WP's cash-out suspended until it settled; Jerv, 31 Oct, the same). The checker marks these "⚠️ no live coverage (blocks cash-out)" (Sportradar coverage level 1 or less). Fine on small tickets you will ride to the end.
- **Football: last 10 only** (owner, 3 Nov: 20 games gave false percentages, e.g. Lille at Bodø looked 17/20 but Bodø's home clean sheets made it a coin flip). The deep check (`deep_auto.mjs`) re-runs each line on both teams' last 10: 85%+ combined and **80%+ for each side**, so one team's record can't carry the other. The 11–20 "shaky before" warning is gone.
- **Head-to-head only drops a line, it never picks one** (owner, 3 Nov): a good record between the two teams is not a reason to book; the line still has to pass both teams' own last 10 against everyone else.
- **One line per game.** At the same hit rate, take the line with **more room**, not the higher price (28 Oct).
- **Head-to-head meetings older than 2 years count less** (30 Oct): two breaks in the last 2 years drop a line; older breaks only drop it when there are 3+ breaks in all; under 3 recent meetings is flagged "thin". Built into `fb_lines.mjs`.
- **One team's goals: each side must clear 80% on its own** (30 Oct: Colo-Colo under 3.5 lost 6-1; Colo-Colo's tight record hid that Concepcion had conceded 3+ in 4 of their last 20). The team's goals scored and the opponent's goals conceded are checked separately, not just added together. Built into `fb_lines.mjs`.
- **Drop a leg whose price drifts 25%+ before kickoff** (e.g. 1.30 → 1.63 or more): the bookmaker has news we don't (30 Oct: Coventry U21 over 2.5 went 1.30 → 1.86 and finished 1-0).
- **Total over 1.5: the weaker attack must not blank often** (no more than 2 of their last 10; was 4 of 20 until 3 Nov). The over then rests on one team (30 Oct: Seraing v Liege over 1.5 finished 1-0; Liege had failed to score in 7 of their last 20). Built into `fb_lines.mjs` for every total over.
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

## Cash out
- When reporting live slips: give the exact Lagos time, each match's minute and score, and each leg's odds now (29 Oct).
- Cash-out is a judgement call; auto cash-out stays paused. Compare the offer with the slip's real value (remaining legs' chance × payout). Take it when it's clearly above that.

## After a database outage
- Backfill the gap before rating (1 Nov, after Neon's data quota ran out 28 Oct - 1 Nov): TT results with `node ../tools/picker/backfill_tt.mjs <fromISO>` (unpriced rows: results only), tennis with `pullTnResults(6, 20, end)` in 6-hour windows, Setka history with `pullSetkaDays({ days: 1, offset })` per day.
