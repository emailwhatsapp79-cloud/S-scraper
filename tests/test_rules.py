"""Checks pinned to the odds in the screenshots, so the rules cannot drift."""

import json
import pathlib
import unittest

from sportyfilter import Config, Match, evaluate

SAMPLES = pathlib.Path(__file__).resolve().parent.parent / "samples"


def load(name):
    with open(SAMPLES / name, encoding="utf-8") as fh:
        return {m["home"] + " vs " + m["away"]: Match.from_dict(m) for m in json.load(fh)}


class ScreenshotGames(unittest.TestCase):
    def setUp(self):
        self.games = load("screenshot_games.json")

    def test_cry_nfo_clears_every_full_time_check(self):
        r = evaluate(self.games["CRY vs NFO"])
        cleared = [c.name for c in r.checks if c.status == "pass"]
        self.assertEqual(cleared, ["ft_fav", "ft_dog", "ft_dc_fav", "ft_dc_dog", "ht_fav"])

    def test_cry_nfo_rejected_on_level_half_time(self):
        r = evaluate(self.games["CRY vs NFO"])
        self.assertEqual(r.verdict, "REJECT")
        self.assertEqual(r.failure.name, "ht_split")
        self.assertIn("1.08x", r.failure.detail)

    def test_other_three_die_at_full_time(self):
        for label in ("AST vs BRE", "BHA vs BOU", "FUL vs CHE"):
            with self.subTest(label):
                r = evaluate(self.games[label])
                self.assertEqual(r.verdict, "REJECT")
                self.assertIn(r.failure.name, ("ft_fav", "ft_dog"))

    def test_favourite_detected_on_either_side(self):
        self.assertEqual(self.games["CRY vs NFO"].fav_side, "home")
        self.assertEqual(self.games["AST vs BRE"].fav_side, "away")


class PassingGames(unittest.TestCase):
    def setUp(self):
        self.games = load("synthetic_pass.json")

    def test_both_directions_shown(self):
        for label in ("AAA vs BBB", "CCC vs DDD"):
            with self.subTest(label):
                self.assertEqual(evaluate(self.games[label]).verdict, "SHOW")

    def test_loosening_the_split_would_let_cry_nfo_through(self):
        cry = load("screenshot_games.json")["CRY vs NFO"]
        self.assertEqual(evaluate(cry, Config(ht_ratio_min=1.05)).verdict, "SHOW")


class PartialData(unittest.TestCase):
    def test_full_time_only_match_is_held_not_rejected(self):
        raw = {"home": "AAA", "away": "BBB", "ft": {"home": 1.80, "draw": 4.40, "away": 3.95},
               "ft_dc": {"home_draw": 1.28, "home_away": 1.24, "draw_away": 2.08}}
        r = evaluate(Match.from_dict(raw))
        self.assertEqual(r.verdict, "NEEDS-HT")
        self.assertTrue(r.incomplete)

    def test_double_chance_is_derived_when_absent(self):
        raw = {"home": "CRY", "away": "NFO", "ft": {"home": 1.84, "draw": 4.35, "away": 3.88}}
        dc = Match.from_dict(raw).ft_dc
        self.assertTrue(dc.estimated)
        self.assertEqual(dc.home_draw, 1.29)  # matches SportyBet exactly
        self.assertEqual(dc.home_away, 1.25)  # matches SportyBet exactly
        self.assertEqual(dc.draw_away, 2.05)  # SportyBet shades this one to 1.99


class ConfigValidation(unittest.TestCase):
    def test_typo_in_config_is_rejected_loudly(self):
        with self.assertRaises(ValueError):
            Config.from_dict({"ft_fav_mn": 1.5})


if __name__ == "__main__":
    unittest.main()
