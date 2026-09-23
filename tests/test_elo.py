import unittest

from picks_engine.models.elo import EloRatings, expected_score, mov_multiplier_538


class TestExpectedScore(unittest.TestCase):
    def test_equal_ratings_is_fifty_fifty(self):
        self.assertAlmostEqual(expected_score(1500, 1500), 0.5)

    def test_higher_rating_favored(self):
        self.assertGreater(expected_score(1600, 1500), 0.5)

    def test_symmetry(self):
        a = expected_score(1600, 1400)
        b = expected_score(1400, 1600)
        self.assertAlmostEqual(a + b, 1.0, places=9)


class TestEloRatings(unittest.TestCase):
    def test_unknown_team_gets_default(self):
        r = EloRatings()
        self.assertEqual(r.get("Nobody FC"), 1500.0)

    def test_winner_rating_goes_up(self):
        r = EloRatings()
        r.set("A", 1500)
        r.set("B", 1500)
        r.update("A", "B", score_a=1.0, k=20)
        self.assertGreater(r.get("A"), 1500)
        self.assertLess(r.get("B"), 1500)

    def test_zero_sum(self):
        r = EloRatings()
        r.set("A", 1550)
        r.set("B", 1480)
        before = r.get("A") + r.get("B")
        r.update("A", "B", score_a=0.0, k=20, mov_multiplier=1.7)
        after = r.get("A") + r.get("B")
        self.assertAlmostEqual(before, after, places=9)

    def test_upset_moves_rating_more_than_expected_result(self):
        r1 = EloRatings()
        r1.set("Favorite", 1700)
        r1.set("Underdog", 1300)
        r1.update("Favorite", "Underdog", score_a=1.0, k=20)  # expected result
        expected_win_delta = r1.get("Favorite") - 1700

        r2 = EloRatings()
        r2.set("Favorite", 1700)
        r2.set("Underdog", 1300)
        r2.update("Favorite", "Underdog", score_a=0.0, k=20)  # upset loss
        upset_loss_delta = 1700 - r2.get("Favorite")

        self.assertGreater(upset_loss_delta, expected_win_delta)


class TestMovMultiplier(unittest.TestCase):
    def test_rejects_zero_margin(self):
        with self.assertRaises(ValueError):
            mov_multiplier_538(point_diff=0, elo_diff_winner=100)

    def test_bigger_margin_bigger_multiplier(self):
        small = mov_multiplier_538(point_diff=1, elo_diff_winner=0)
        big = mov_multiplier_538(point_diff=30, elo_diff_winner=0)
        self.assertGreater(big, small)

    def test_favorite_blowout_damped_vs_underdog_blowout(self):
        # Same margin, but the favorite (positive elo_diff_winner) winning
        # big should move ratings less than the underdog winning by the
        # same margin (elo_diff_winner negative) -- that's the whole
        # purpose of the damping term.
        favorite_blowout = mov_multiplier_538(point_diff=20, elo_diff_winner=300)
        underdog_blowout = mov_multiplier_538(point_diff=20, elo_diff_winner=-300)
        self.assertLess(favorite_blowout, underdog_blowout)


if __name__ == "__main__":
    unittest.main()
