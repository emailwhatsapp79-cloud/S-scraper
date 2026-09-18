# sportyfilter

A screener for SportyBet **vFootball**. It does not place bets and it does not
browse. You hand it match odds as JSON, it hands back the short list of games
whose odds sit inside the bands you set.

```
python3 -m sportyfilter samples/screenshot_games.json --all
python3 -m sportyfilter samples/synthetic_pass.json -c config.json --json
```

## The screen

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

`web/sportybet-screener.user.js` is a userscript. Installed through Tampermonkey
it runs inside sportybet.com, which makes it same-origin: it can call their
endpoints directly, so nothing has to be pasted anywhere.

It hardcodes no URLs. It watches the requests the site makes, takes whichever
one yielded the most games as the list endpoint, and walks its pages until one
comes back empty or repeats the page before it. Markets are matched on their
printed names ("1X2", "Double Chance", "1st Half - 1X2") and outcomes on theirs,
falling back to position. Half-time odds are fetched only for games that already
cleared the four full-time checks, which keeps a 1000-game sweep to a few dozen
detail calls.

`web/install.html` is the install page: the script with a copy button and the
Tampermonkey steps.

```
python3 -m unittest discover -s tests   # the rules, the ledger, the statistics
node tests/js/run.js                    # the userscript, against a mock feed
```

The JS tests boot the userscript in a fake DOM and drive it end to end — the
sweep, the pagination, the screen and what it renders.
