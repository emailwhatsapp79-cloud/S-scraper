"""End-to-end: screen -> pick -> result -> settle -> report."""

import json
import os
import pathlib
import tempfile
import unittest

from sportyfilter import Config, Match, evaluate
from sportyfilter.ledger import outcome, place, settle
from sportyfilter.report import picks_needed, summarise, wilson
from sportyfilter.store import Store

SAMPLES = pathlib.Path(__file__).resolve().parent.parent / "samples"


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = Store(os.path.join(self.dir, "t.db"))
        with open(SAMPLES / "synthetic_pass.json", encoding="utf-8") as fh:
            self.matches = [Match.from_dict(m) for m in json.load(fh)]
        for m in self.matches:
            self.store.record_match(m)

    def tearDown(self):
        self.store.close()

    def test_pick_is_double_chance_on_the_favourite(self):
        pid = place(self.store, evaluate(self.matches[0]), "default")
        row = self.store.db.execute("SELECT * FROM picks WHERE id = ?", (pid,)).fetchone()
        self.assertEqual((row["market"], row["selection"], row["price"]), ("FT_DC", "1X", 1.28))

    def test_mirrored_game_picks_the_other_side(self):
        place(self.store, evaluate(self.matches[1]), "default")
        row = self.store.db.execute("SELECT * FROM picks WHERE game_id = 'S-002'").fetchone()
        self.assertEqual(row["selection"], "X2")

    def test_rejected_screen_places_nothing(self):
        with open(SAMPLES / "screenshot_games.json", encoding="utf-8") as fh:
            for raw in json.load(fh):
                m = Match.from_dict(raw)
                self.store.record_match(m)
                self.assertIsNone(place(self.store, evaluate(m), "default"))

    def test_poller_reseeing_a_match_does_not_double_pick(self):
        self.assertIsNotNone(place(self.store, evaluate(self.matches[0]), "default"))
        self.assertIsNone(place(self.store, evaluate(self.matches[0]), "default"))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM picks").fetchone()[0], 1)

    def test_settlement(self):
        for m in self.matches:
            place(self.store, evaluate(m), "default")
        self.store.record_result("S-001", ht=(1, 0), ft=(2, 1))  # home win -> 1X wins
        self.store.record_result("S-002", ht=(0, 0), ft=(3, 0))  # home win -> X2 loses
        self.assertEqual(settle(self.store), {"won": 1, "lost": 1})

        rows = self.store.settled_picks()
        by_game = {r["game_id"]: r for r in rows}
        self.assertEqual(by_game["S-001"]["outcome"], "won")
        self.assertAlmostEqual(by_game["S-001"]["returned"], 1.28)
        self.assertEqual(by_game["S-002"]["outcome"], "lost")
        self.assertEqual(by_game["S-002"]["returned"], 0.0)

    def test_draw_settles_both_double_chances_as_wins(self):
        for m in self.matches:
            place(self.store, evaluate(m), "default")
        self.store.record_result("S-001", ht=(0, 0), ft=(1, 1))
        self.store.record_result("S-002", ht=(0, 0), ft=(2, 2))
        self.assertEqual(settle(self.store), {"won": 2, "lost": 0})


class Outcomes(unittest.TestCase):
    def test_outcome_codes(self):
        self.assertEqual(outcome(2, 1), "H")
        self.assertEqual(outcome(1, 1), "D")
        self.assertEqual(outcome(0, 3), "A")


class Statistics(unittest.TestCase):
    def test_wilson_is_wide_at_small_n_and_tight_at_large_n(self):
        lo_s, hi_s = wilson(8, 10)
        lo_l, hi_l = wilson(800, 1000)
        self.assertGreater(hi_s - lo_s, 0.4)
        self.assertLess(hi_l - lo_l, 0.06)

    def test_a_hot_streak_is_not_called_an_edge(self):
        picks = [{"outcome": "won", "stake": 1.0, "returned": 1.29, "price": 1.29}] * 9
        picks += [{"outcome": "lost", "stake": 1.0, "returned": 0.0, "price": 1.29}]
        s = summarise(picks)
        self.assertEqual(s.hit_rate, 0.9)          # looks great
        self.assertGreater(s.roi, 0.15)            # and profitable
        self.assertEqual(s.verdict, "too few picks to say anything")

    def test_bigger_claimed_edge_needs_less_data(self):
        self.assertGreater(picks_needed(0.775, 0.800), picks_needed(0.775, 0.850))

    def test_no_edge_claimed_needs_nothing(self):
        self.assertEqual(picks_needed(0.775, 0.775), 0)


if __name__ == "__main__":
    unittest.main()
