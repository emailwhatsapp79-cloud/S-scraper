# sportyfilter

Started as a screener for SportyBet **vFootball**; it is now a personal betting
workstation covering vFootball, table tennis, tennis and eBasketball.

The live site — [vfootball-screener.vercel.app](https://vfootball-screener.vercel.app) —
reads the cards itself. Behind the PIN it can also **place real slips** on
SportyBet or Football.com with your own login (`site/api/_fc.js`), and issue
booking codes. The Python package below is the original offline screener and
never touches an account.

```
python3 -m sportyfilter samples/screenshot_games.json --all
python3 -m sportyfilter samples/synthetic_pass.json -c config.json --json
```

## How the models are graded

Every model is judged the same way before it is allowed to switch picks on:

- **Walk-forward only.** A game is scored with what was known before it
  started. Table tennis and eBasketball write the % down on the game row before
  its result is trained in, and the record reads only that number.
- **Profit at the posted price, not hit rate.** A 60% favourite that hits 58%
  still loses money once the margin is in. "Proven" needs a positive return and
  a Wilson lower bound on the hit rate above the rate those prices need to break
  even.

## eBasketball (paper only)

`/eb`. SportyBet's eBasketball (`sr:sport:153`) — 4×5-minute NBA 2K games
between named gamers, ~250 a day. The gamer is the name in brackets; the team
changes game to game. Each gamer carries a number that moves on *result minus
the book's %*, so it measures who keeps beating the book, not who is good (the
book already knows that). Picks show as "watching" until 100+ graded paper
picks have made money. Prices only appear an hour or so before tip-off, so point
an outside pinger at `/api/poll?eb=1` every 10–15 minutes or most games are
never priced.

## The vFootball screen

Sides are never hardcoded. For each match the **favourite** is whichever of the
full-time home/away legs is the shorter price, and the **dog** is the other one.
Every rule is written against fav/dog, so a game with the short price on the
away side is screened by exactly the same rules, mirrored, with no extra config.

| # | Check | Market | Default |
|---|-------|--------|---------|
| 1 | `ft_fav` | FT 1X2, favourite leg | 1.50 – 2.50 |
| 2 | `ft_dog` | FT 1X2, other leg | ≥ 3.70, no ceiling |
| 3 | `ft_dc_fav` | FT double chance, favourite + draw | 1.17 – 1.30 |
| 4 | `ft_dc_dog` | FT double chance, dog + draw | ≥ 1.89 |
| 5 | `ht_fav` | 1st half 1X2, favourite leg | 1.10 – 3.00 |
| 6 | `ht_split` | 1st half dog ÷ fav | ≥ 1.70× |

Check 6 is the one that throws out the level games: if the two half-time legs
are near each other the match is dropped however good the full-time picture is.
The half-time **draw** leg is read but never filtered on.

Every number above lives in `config.json`. Pass it with `-c` and change what you
like; an unrecognised key is rejected rather than silently ignored.

## Verdicts

- `SHOW` — cleared all six.
- `REJECT` — failed at least one. `--all` prints which, and by how much.
- `NEEDS-HT` — cleared the full-time checks but half-time odds were not in the
  input. This lets you run the four full-time checks against a whole list page
  first and only pull details for the handful that survive.

## Input

One JSON array. `ft_dc` and `ht` are optional; when `ft_dc` is absent it is
derived from the 1X2 prices and flagged `(dc estimated)` — the derivation
reproduced SportyBet's 1X and 12 exactly on the sample game but came out 0.06
high on X2, so prefer real values when you have them.

```json
{
  "game_id": "52355", "league": "England - Virtual", "kickoff": "18/09 21:54",
  "home": "CRY", "away": "NFO",
  "ft":    {"home": 1.84, "draw": 4.35, "away": 3.88},
  "ft_dc": {"home_draw": 1.29, "home_away": 1.25, "draw_away": 1.99},
  "ht":    {"home": 2.80, "draw": 2.92, "away": 3.02}
}
```

`samples/screenshot_games.json` holds the four real games off the 18/09 21:54
England-Virtual card. `samples/synthetic_pass.json` holds two invented games
that clear the screen — one with the home side favourite, one mirrored.

## Paper ledger

`store.py` keeps every match, every odds snapshot (not overwritten, so drift is
visible), every result and every pick in SQLite. `ledger.py` records the natural
bet for a passing screen — full-time double chance on the favourite — at the
price that was showing when it fired, and settles it against the published
result. Nothing touches a real account; a pick is a recorded prediction.

`report.py` scores the strategy against its own prices. It reports a Wilson
interval rather than a bare percentage, and widens the interval by Bonferroni
whenever picks are sliced into groups, because slicing 24 ways and keeping the
best slice finds an "edge" in data that has none:

```
python3 tools/noise_demo.py        # 2,250 picks from a generator with no pattern
```

That demo routinely shows a 13–21 point gap between the best and worst hour of
the day, and on some seeds the best hour clears break-even outright when judged
on its own. The correction is what stops you backing the 3am pattern.

## Where the odds come from

The website reads SportyBet over GET. `pcUpcomingEvents` with `option=2` on
each of the five virtual leagues returns the remaining day — this morning,
442 upcoming games, each with 1X2, Double Chance and 1st Half 1X2. `option=1`
and the WAP highlight feed are a 10-game strip; that was the earlier wall.
POST `wapEvents` is still WAF-blocked from any server. We do not use it.
Notes: `site/API_NOTES.md`.

```
python3 -m unittest discover -s tests   # the rules, the ledger, the statistics
```

