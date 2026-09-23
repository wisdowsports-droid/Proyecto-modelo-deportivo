import unittest

from picks_engine.valuation.ev import evaluate, kelly_fraction


class TestKellyFraction(unittest.TestCase):
    def test_no_edge_gives_zero_stake(self):
        # fair coin, fair-ish 2.0 odds (50% implied) -> no edge -> 0 stake
        self.assertAlmostEqual(kelly_fraction(0.5, 2.0), 0.0, places=6)

    def test_positive_edge_gives_positive_stake(self):
        self.assertGreater(kelly_fraction(0.6, 2.0), 0.0)

    def test_negative_edge_clamped_to_zero(self):
        # model thinks 40% but odds imply 50% -> negative edge -> never bet negative
        self.assertEqual(kelly_fraction(0.4, 2.0), 0.0)

    def test_rejects_bad_inputs(self):
        with self.assertRaises(ValueError):
            kelly_fraction(1.0, 2.0)
        with self.assertRaises(ValueError):
            kelly_fraction(0.5, 1.0)


class TestEvaluate(unittest.TestCase):
    def test_flags_value_above_threshold(self):
        v = evaluate(model_prob=0.90, market_odds=[1.30, 4.2], picked_index=0, value_threshold=0.02)
        self.assertTrue(v.is_value)
        self.assertGreater(v.edge, 0.02)

    def test_no_value_when_model_agrees_with_market(self):
        # construct odds whose fair (shin) probability is ~= model_prob
        v = evaluate(model_prob=0.5, market_odds=[2.0, 2.0], picked_index=0, value_threshold=0.02)
        self.assertFalse(v.is_value)
        self.assertAlmostEqual(v.edge, 0.0, places=6)

    def test_kelly_stake_respects_multiplier(self):
        full = evaluate(model_prob=0.9, market_odds=[1.3, 4.2], picked_index=0, kelly_multiplier=1.0)
        quarter = evaluate(model_prob=0.9, market_odds=[1.3, 4.2], picked_index=0, kelly_multiplier=0.25)
        self.assertAlmostEqual(quarter.kelly_stake, full.kelly_full * 0.25, places=6)
        self.assertLess(quarter.kelly_stake, full.kelly_stake)


if __name__ == "__main__":
    unittest.main()
