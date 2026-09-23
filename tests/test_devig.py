import unittest

from picks_engine.market.devig import devig_multiplicative, devig_shin, raw_implied_probabilities


class TestRawImplied(unittest.TestCase):
    def test_basic(self):
        self.assertAlmostEqual(raw_implied_probabilities([2.0, 2.0])[0], 0.5)

    def test_rejects_bad_odds(self):
        with self.assertRaises(ValueError):
            raw_implied_probabilities([1.0, 2.0])  # odds must be > 1.0
        with self.assertRaises(ValueError):
            raw_implied_probabilities([2.0])  # need >= 2 outcomes


class TestMultiplicative(unittest.TestCase):
    def test_sums_to_one(self):
        r = devig_multiplicative([1.08, 12.00, 34.00])
        self.assertAlmostEqual(sum(r.fair_probabilities), 1.0, places=9)

    def test_no_vig_market_unchanged(self):
        # exactly fair odds: 1/0.5=2.0, 1/0.5=2.0 -> no overround
        r = devig_multiplicative([2.0, 2.0])
        self.assertAlmostEqual(r.overround, 1.0, places=6)
        self.assertAlmostEqual(r.fair_probabilities[0], 0.5, places=6)


class TestShin(unittest.TestCase):
    def test_sums_to_one(self):
        r = devig_shin([1.26, 5.50, 11.50])
        self.assertAlmostEqual(sum(r.fair_probabilities), 1.0, places=6)

    def test_favors_favorite_vs_multiplicative(self):
        # Shin's method should assign a heavy favorite a HIGHER fair
        # probability than plain multiplicative de-vig, and the longshot a
        # LOWER one -- that's the whole point of correcting for the
        # favorite-longshot bias built into bookmaker margins.
        odds = [1.08, 12.00, 34.00]
        mult = devig_multiplicative(odds)
        shin = devig_shin(odds)
        self.assertGreater(shin.fair_probabilities[0], mult.fair_probabilities[0])
        self.assertLess(shin.fair_probabilities[2], mult.fair_probabilities[2])

    def test_two_way_symmetric_market(self):
        # symmetric market: both methods should agree exactly (no
        # favorite-longshot asymmetry to correct when both sides are equal)
        r = devig_shin([1.90, 1.90])
        self.assertAlmostEqual(r.fair_probabilities[0], 0.5, places=6)
        self.assertAlmostEqual(r.fair_probabilities[1], 0.5, places=6)

    def test_no_overround_falls_back_cleanly(self):
        r = devig_shin([2.0, 2.0])
        self.assertAlmostEqual(sum(r.fair_probabilities), 1.0, places=6)
        self.assertEqual(r.z, 0.0)


if __name__ == "__main__":
    unittest.main()
