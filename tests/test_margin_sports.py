import unittest

from picks_engine.models.basketball import NBAEloModel
from picks_engine.models.football import NFLEloModel
from picks_engine.models.baseball import MLBEloModel
from picks_engine.models.tennis import TennisEloModel


class TestMarginEloModels(unittest.TestCase):
    def test_rejects_ties(self):
        for cls in (NBAEloModel, NFLEloModel, MLBEloModel):
            model = cls()
            with self.assertRaises(ValueError):
                model.record_result("Home", "Away", 10, 10)

    def test_home_favored_with_equal_ratings(self):
        for cls in (NBAEloModel, NFLEloModel, MLBEloModel):
            model = cls()
            # equal underlying ratings -> home_advantage alone should push
            # win probability above 0.5
            self.assertGreater(model.win_probability("Home", "Away"), 0.5, msg=cls.__name__)

    def test_win_updates_ratings_favorably(self):
        for cls in (NBAEloModel, NFLEloModel, MLBEloModel):
            model = cls()
            before = model.ratings.get("Home")
            model.record_result("Home", "Away", 100, 90)
            self.assertGreater(model.ratings.get("Home"), before, msg=cls.__name__)

    def test_bigger_margin_moves_rating_more(self):
        # Two independent models (fresh ratings each), same K/home_adv:
        # a blowout should move the winner's rating more than a nail-biter.
        close = NBAEloModel()
        close.record_result("Home", "Away", 101, 100)
        close_delta = close.ratings.get("Home") - 1500

        blowout = NBAEloModel()
        blowout.record_result("Home", "Away", 130, 90)
        blowout_delta = blowout.ratings.get("Home") - 1500

        self.assertGreater(blowout_delta, close_delta)


class TestTennisEloModel(unittest.TestCase):
    def test_new_players_are_coinflip(self):
        t = TennisEloModel()
        self.assertAlmostEqual(t.win_probability("A", "B"), 0.5)

    def test_winner_rating_increases(self):
        t = TennisEloModel()
        t.record_result("A", "B", surface="clay")
        self.assertGreater(t.overall.get("A"), 1500)
        self.assertLess(t.overall.get("B"), 1500)
        self.assertGreater(t.by_surface["clay"].get("A"), 1500)

    def test_k_shrinks_with_experience(self):
        t = TennisEloModel()
        k_new = t.dynamic_k("Newcomer")
        for _ in range(50):
            t.record_result("Veteran", "PunchingBag")
        k_veteran = t.dynamic_k("Veteran")
        self.assertLess(k_veteran, k_new)

    def test_surface_blend_differs_from_overall_only(self):
        t = TennisEloModel()
        # Build history where A is much better on clay than on hard.
        for _ in range(10):
            t.record_result("A", "B", surface="clay")
        for _ in range(10):
            t.record_result("B", "A", surface="hard")
        clay_prob = t.win_probability("A", "B", surface="clay")
        hard_prob = t.win_probability("A", "B", surface="hard")
        self.assertGreater(clay_prob, hard_prob)


if __name__ == "__main__":
    unittest.main()
