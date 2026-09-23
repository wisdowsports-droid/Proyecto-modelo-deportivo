import unittest

from picks_engine.evaluation.metrics import (
    brier_score,
    calibration_bins,
    evaluate_picks,
    log_loss,
    paper_roi,
)


class TestBrierScore(unittest.TestCase):
    def test_perfect_predictions_score_zero(self):
        preds = [(1.0, 1), (0.0, 0), (1.0, 1)]
        self.assertAlmostEqual(brier_score(preds), 0.0)

    def test_always_fifty_fifty_scores_quarter(self):
        preds = [(0.5, 1), (0.5, 0), (0.5, 1), (0.5, 0)]
        self.assertAlmostEqual(brier_score(preds), 0.25)

    def test_confidently_wrong_scores_worse_than_unsure(self):
        confidently_wrong = brier_score([(0.95, 0)])
        unsure_and_wrong = brier_score([(0.55, 0)])
        self.assertGreater(confidently_wrong, unsure_and_wrong)

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            brier_score([])


class TestLogLoss(unittest.TestCase):
    def test_confidently_wrong_punished_harder_than_brier_would(self):
        # log-loss should blow up much faster than brier for a confident miss
        ll = log_loss([(0.99, 0)])
        b = brier_score([(0.99, 0)])
        self.assertGreater(ll, b)

    def test_handles_extreme_probabilities_without_crashing(self):
        # would be -inf without eps clipping
        result = log_loss([(1.0, 0), (0.0, 1)])
        self.assertTrue(result > 0)


class TestCalibrationBins(unittest.TestCase):
    def test_bins_cover_full_range(self):
        bins = calibration_bins([(0.05, 1), (0.95, 0)], n_bins=10)
        self.assertEqual(len(bins), 10)
        self.assertEqual(bins[0].count, 1)
        self.assertEqual(bins[-1].count, 1)

    def test_empty_bin_has_none_rates(self):
        bins = calibration_bins([(0.05, 1)], n_bins=10)
        self.assertIsNone(bins[5].avg_predicted)
        self.assertIsNone(bins[5].actual_rate)


class TestPaperRoi(unittest.TestCase):
    def test_flat_stake_win(self):
        picks = [{"status": "won", "decimal_odds": 2.0}]
        r = paper_roi(picks, stake_field=None, flat_stake=1.0)
        self.assertAlmostEqual(r.total_staked, 1.0)
        self.assertAlmostEqual(r.total_return, 2.0)
        self.assertAlmostEqual(r.profit, 1.0)
        self.assertAlmostEqual(r.roi_pct, 100.0)

    def test_flat_stake_loss(self):
        picks = [{"status": "lost", "decimal_odds": 3.0}]
        r = paper_roi(picks, stake_field=None, flat_stake=1.0)
        self.assertAlmostEqual(r.profit, -1.0)
        self.assertAlmostEqual(r.roi_pct, -100.0)

    def test_ignores_pending_and_void(self):
        picks = [
            {"status": "pending", "decimal_odds": 2.0},
            {"status": "void", "decimal_odds": 2.0},
            {"status": "won", "decimal_odds": 2.0},
        ]
        r = paper_roi(picks, stake_field=None, flat_stake=1.0)
        self.assertEqual(r.n, 1)

    def test_no_graded_picks_gives_none_roi(self):
        r = paper_roi([{"status": "pending", "decimal_odds": 2.0}], stake_field=None)
        self.assertIsNone(r.roi_pct)


class TestEvaluatePicks(unittest.TestCase):
    def test_flags_unreliable_below_threshold(self):
        picks = [{"model_prob": 0.6, "status": "won", "decimal_odds": 1.8, "kelly_stake": 0.1}]
        summary = evaluate_picks(picks, min_reliable_n=100)
        self.assertFalse(summary.reliable)
        self.assertEqual(summary.n, 1)

    def test_empty_picks_handled_gracefully(self):
        summary = evaluate_picks([], min_reliable_n=100)
        self.assertEqual(summary.n, 0)
        self.assertIsNone(summary.brier)
        self.assertIsNone(summary.roi)


if __name__ == "__main__":
    unittest.main()
