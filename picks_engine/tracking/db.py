"""Pick tracking. One row per pick, from creation to settlement -- this is
what replaces narrating results by hand in a doc.

Two backends behind the same PicksDB interface:

- Supabase (Postgres) -- the real database. Pass a ``postgresql://`` URL, or
  use ``PicksDB.from_env()``, which reads DATABASE_URL (from the environment
  or a ``.env`` file at the project root). Schema lives in
  ``supabase/migrations/``.
- SQLite -- only for tests and offline experiments. Pass a file path or
  ``":memory:"``. Schema lives in ``schema.sql`` next to this file; keep the
  two schemas in sync when adding columns.

Plain SQL on both (psycopg / stdlib sqlite3), no ORM: the schema is small and
stable enough that an ORM would be more machinery than the problem needs.
Rows come back as plain dicts with dates/timestamps as ISO strings on both
backends, so callers never need to know which one they're talking to.
"""
from __future__ import annotations

import datetime
import os
import pathlib
import sqlite3

_SCHEMA_PATH = pathlib.Path(__file__).parent / "schema.sql"
_PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]

VALID_STATUSES = {"pending", "won", "lost", "push", "void", "no_pick"}

_COLUMNS = (
    "created_at", "sport", "league", "event", "event_date", "market", "selection",
    "decimal_odds", "devig_method", "model_prob", "fair_market_prob", "edge",
    "kelly_stake", "status", "legacy_note", "source",
)


def _utcnow_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _is_postgres_url(target: str) -> bool:
    return target.startswith(("postgres://", "postgresql://"))


def _normalize_row(row: dict) -> dict:
    # Postgres hands back date/datetime objects; SQLite hands back strings.
    return {
        k: v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v
        for k, v in row.items()
    }


class PicksDB:
    def __init__(self, target: str | pathlib.Path):
        target = str(target)
        self.is_postgres = _is_postgres_url(target)
        if self.is_postgres:
            import psycopg
            from psycopg.rows import dict_row

            # prepare_threshold=None: Supabase's transaction pooler (port 6543)
            # doesn't support prepared statements; harmless on the session pooler.
            self.conn = psycopg.connect(target, row_factory=dict_row, prepare_threshold=None)
            self._ph = "%s"
        else:
            self.conn = sqlite3.connect(target)
            self.conn.row_factory = sqlite3.Row
            self._ph = "?"
            with open(_SCHEMA_PATH, encoding="utf-8") as f:
                self.conn.executescript(f.read())
            self.conn.commit()

    @classmethod
    def from_env(cls) -> "PicksDB":
        """Connect to Supabase using DATABASE_URL (environment or .env)."""
        try:
            from dotenv import load_dotenv

            load_dotenv(_PROJECT_ROOT / ".env")
        except ImportError:
            pass
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError(
                "DATABASE_URL is not set. Copy .env.example to .env and paste your "
                "Supabase connection string (Dashboard -> Connect -> Session pooler)."
            )
        if not _is_postgres_url(url):
            raise RuntimeError("DATABASE_URL must be a postgresql:// URL (Supabase connection string).")
        return cls(url)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "PicksDB":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _execute(self, query: str, params: tuple | list = ()):
        return self.conn.execute(query.replace("?", self._ph), params)

    # -- writes -----------------------------------------------------------

    def add_pick(
        self,
        *,
        sport: str,
        event: str,
        market: str,
        selection: str,
        decimal_odds: float | None = None,
        league: str | None = None,
        event_date: str | None = None,
        devig_method: str | None = None,
        model_prob: float | None = None,
        fair_market_prob: float | None = None,
        edge: float | None = None,
        kelly_stake: float | None = None,
        legacy_note: str | None = None,
        source: str | None = None,
        created_at: str | None = None,
        status: str = "pending",
    ) -> int:
        if status not in VALID_STATUSES:
            raise ValueError(f"status must be one of {VALID_STATUSES}, got {status!r}")
        created_at = created_at or _utcnow_iso()
        values = (
            created_at, sport, league, event, event_date, market, selection,
            decimal_odds, devig_method, model_prob, fair_market_prob, edge,
            kelly_stake, status, legacy_note, source,
        )
        query = (
            f"INSERT INTO picks ({', '.join(_COLUMNS)}) "
            f"VALUES ({', '.join('?' * len(_COLUMNS))})"
        )
        if self.is_postgres:
            pick_id = self._execute(query + " RETURNING id", values).fetchone()["id"]
        else:
            pick_id = self._execute(query, values).lastrowid
        self.conn.commit()
        return int(pick_id)

    def settle_pick(
        self,
        pick_id: int,
        status: str,
        result_note: str | None = None,
        settled_at: str | None = None,
    ) -> None:
        if status not in VALID_STATUSES or status == "pending":
            raise ValueError(f"settle status must be one of {VALID_STATUSES - {'pending'}}, got {status!r}")
        settled_at = settled_at or _utcnow_iso()
        cur = self._execute(
            "UPDATE picks SET status = ?, result_note = ?, settled_at = ? WHERE id = ?",
            (status, result_note, settled_at, pick_id),
        )
        self.conn.commit()
        if cur.rowcount == 0:
            raise KeyError(f"No pick with id={pick_id}")

    # -- reads --------------------------------------------------------------

    def get_pick(self, pick_id: int) -> dict | None:
        row = self._execute("SELECT * FROM picks WHERE id = ?", (pick_id,)).fetchone()
        return _normalize_row(dict(row)) if row else None

    def list_picks(
        self,
        *,
        status: str | None = None,
        sport: str | None = None,
        order_by: str = "id",
    ) -> list[dict]:
        if order_by not in {"id", "created_at", "event_date"}:
            raise ValueError(f"unsupported order_by: {order_by!r}")
        query = "SELECT * FROM picks WHERE 1=1"
        params: list = []
        if status is not None:
            query += " AND status = ?"
            params.append(status)
        if sport is not None:
            query += " AND sport = ?"
            params.append(sport)
        query += f" ORDER BY {order_by}"
        return [_normalize_row(dict(r)) for r in self._execute(query, params).fetchall()]

    def graded_picks_for_evaluation(self) -> list[dict]:
        """Picks with both a real model_prob AND a clean win/loss outcome --
        the only rows picks_engine.evaluation.metrics should score.

        Excluded on purpose:
        - status not in (won, lost): pending has no outcome yet; push/void
          were never a clean win-or-lose test; no_pick was never a bet.
        - model_prob IS NULL: legacy/qualitative picks (e.g. this project's
          first two batches, made by eyeballing odds + confidence words, no
          real model). Scoring those against a Brier score would silently
          credit the new engine for the old approach's luck (or blame it
          for the old approach's misses) -- keep the two eras separate.
        """
        rows = self._execute(
            "SELECT * FROM picks WHERE status IN ('won','lost') AND model_prob IS NOT NULL"
        ).fetchall()
        return [_normalize_row(dict(r)) for r in rows]
