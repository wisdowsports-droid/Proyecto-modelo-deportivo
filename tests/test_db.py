import tempfile
import unittest
from pathlib import Path

from picks_engine.tracking.db import PicksDB


class TestPicksDB(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test.db"
        self.db = PicksDB(self.db_path)

    def tearDown(self):
        self.db.close()
        self._tmpdir.cleanup()

    def _add(self, **overrides):
        defaults = dict(
            sport="soccer",
            event="A vs B",
            market="moneyline",
            selection="A",
            decimal_odds=1.9,
        )
        defaults.update(overrides)
        return self.db.add_pick(**defaults)

    def test_add_and_get(self):
        pid = self._add(model_prob=0.6)
        row = self.db.get_pick(pid)
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["model_prob"], 0.6)

    def test_settle_updates_status(self):
        pid = self._add()
        self.db.settle_pick(pid, "won", result_note="A won 2-0")
        row = self.db.get_pick(pid)
        self.assertEqual(row["status"], "won")
        self.assertEqual(row["result_note"], "A won 2-0")
        self.assertIsNotNone(row["settled_at"])

    def test_settle_rejects_bad_status(self):
        pid = self._add()
        with self.assertRaises(ValueError):
            self.db.settle_pick(pid, "pending")
        with self.assertRaises(ValueError):
            self.db.settle_pick(pid, "not_a_real_status")

    def test_settle_missing_pick_raises(self):
        with self.assertRaises(KeyError):
            self.db.settle_pick(999999, "won")

    def test_list_picks_filters(self):
        self._add(sport="soccer")
        self._add(sport="tennis")
        pid3 = self._add(sport="soccer")
        self.db.settle_pick(pid3, "won")

        self.assertEqual(len(self.db.list_picks(sport="tennis")), 1)
        self.assertEqual(len(self.db.list_picks(sport="soccer")), 2)
        self.assertEqual(len(self.db.list_picks(status="won")), 1)

    def test_graded_picks_excludes_no_model_and_unsettled(self):
        pid_no_model = self._add()  # no model_prob
        self.db.settle_pick(pid_no_model, "won")

        pid_pending = self._add(model_prob=0.7)  # never settled

        pid_graded = self._add(model_prob=0.7)
        self.db.settle_pick(pid_graded, "lost")

        graded = self.db.graded_picks_for_evaluation()
        graded_ids = {row["id"] for row in graded}
        self.assertIn(pid_graded, graded_ids)
        self.assertNotIn(pid_no_model, graded_ids)
        self.assertNotIn(pid_pending, graded_ids)


if __name__ == "__main__":
    unittest.main()
