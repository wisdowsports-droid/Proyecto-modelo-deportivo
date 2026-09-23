"""SQLite-backed pick tracking. One row per pick, from creation to
settlement -- this is what replaces narrating results by hand in a doc.

Deliberately plain sqlite3 (stdlib), no ORM: the schema is small and stable
enough that an ORM would be more machinery than the problem needs.
"""
from __future__ import annotations

import datetime
import pathlib
import sqlite3

_SCHEMA_PATH = pathlib.Path(__file__).parent / "schema.sql"

VALID_STATUSES = {"pending", "won", "lost", "push", "void", "no_pick"}


def _utcnow_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class PicksDB:
    def __init__(self, path: str | pathlib.Path = "picks.db"):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    def _init_schema(self) -> None:
        with open(_SCHEMA_PATH, encoding="utf-8") as f:
            self.conn.executescript(f.read())
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "PicksDB":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

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
        cur = self.conn.execute(
            """INSERT INTO picks (
                   created_at, sport, league, event, event_date, market, selection,
                   decimal_odds, devig_method, model_prob, fair_market_prob, edge,
                   kelly_stake, status, legacy_note, source
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                created_at, sport, league, event, event_date, market, selection,
                decimal_odds, devig_method, model_prob, fair_market_prob, edge,
                kelly_stake, status, legacy_note, source,
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

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
        cur = self.conn.execute(
            "UPDATE picks SET status = ?, result_note = ?, settled_at = ? WHERE id = ?",
            (status, result_note, settled_at, pick_id),
        )
        self.conn.commit()
        if cur.rowcount == 0:
            raise KeyError(f"No pick with id={pick_id}")

    # -- reads --------------------------------------------------------------

    def get_pick(self, pick_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM picks WHERE id = ?", (pick_id,)).fetchone()
        return dict(row) if row else None

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
        rows = self.conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]

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
        rows = self.conn.execute(
            "SELECT * FROM picks WHERE status IN ('won','lost') AND model_prob IS NOT NULL"
        ).fetchall()
        return [dict(r) for r in rows]
