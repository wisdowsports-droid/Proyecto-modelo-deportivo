import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from picks_engine.tracking.db import PicksDB

_SEED_PATH = Path(__file__).resolve().parent.parent / "scripts" / "seed_from_legacy.py"
_spec = importlib.util.spec_from_file_location("seed_from_legacy", _SEED_PATH)
seed_from_legacy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(seed_from_legacy)


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


class TestFromEnv(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop("DATABASE_URL", None)

    def tearDown(self):
        os.environ.pop("DATABASE_URL", None)
        if self._saved is not None:
            os.environ["DATABASE_URL"] = self._saved

    def test_missing_url_raises(self):
        with mock.patch("dotenv.load_dotenv"):  # don't pick up a real .env
            with self.assertRaises(RuntimeError):
                PicksDB.from_env()

    def test_non_postgres_url_rejected(self):
        os.environ["DATABASE_URL"] = "picks.db"
        with mock.patch("dotenv.load_dotenv"):
            with self.assertRaises(RuntimeError):
                PicksDB.from_env()


class TestSeedFromLegacy(unittest.TestCase):
    def test_seed_is_idempotent(self):
        with PicksDB(":memory:") as db:
            first = seed_from_legacy.seed(db)
            second = seed_from_legacy.seed(db)
            self.assertEqual(first, 15)
            self.assertEqual(second, 0)
            self.assertEqual(len(db.list_picks()), 15)
            # legacy picks never reach evaluation
            self.assertEqual(db.graded_picks_for_evaluation(), [])


if __name__ == "__main__":
    unittest.main()
