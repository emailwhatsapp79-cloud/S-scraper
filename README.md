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

## Where the odds come from

Nothing in this repo fetches anything; the feed is deliberately a separate,
pluggable stage. Run `python3 -m unittest discover -s tests` to check the rules.
