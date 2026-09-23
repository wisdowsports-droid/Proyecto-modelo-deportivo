#!/usr/bin/env python3
"""One-time import: load the 15 picks from the original "prueba en papel"
Claude Doc (both batches, 17-21 sep and 22 sep 2026) into the new tracking
DB, as historical/legacy rows.

Deliberately sets model_prob=NULL for every row here -- see
picks_engine.tracking.db.PicksDB.graded_picks_for_evaluation and
picks_engine.evaluation.metrics module docstrings for why: none of these 15
picks came from a real statistical model (soccer.py/elo.py didn't exist
yet), so scoring them with Brier/log-loss would silently credit or blame
the new engine for the old, ungrounded approach. The old numbers
(prob_modelo, edge, confianza, etc.) are preserved verbatim in
legacy_note for provenance, never fed into evaluation.

Usage:
    python3 scripts/seed_from_legacy.py [path/to/picks.db]
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from picks_engine.tracking.db import PicksDB  # noqa: E402

SEED_CSV = Path(__file__).resolve().parent.parent / "data" / "seed_picks.csv"
SOURCE_DOC = "legacy:doc-353c8eca-c0d9-4d4c-9786-fd796cc283b9"

STATUS_MAP = {
    "Acerto": "won",
    "No acerto": "lost",
    "Fallo": "lost",
    "Sin pick": "no_pick",
    "Pendiente": "pending",
}

MARKET_MAP = {
    "1X2": "1x2",
    "Doble oportunidad": "double_chance_1x",
    "Goles": "over_under_2.5",
    "": None,
}


def build_legacy_note(row: dict, status: str) -> str | None:
    parts = []
    if row.get("cuota_1x2"):
        parts.append(f"cuota_1x2={row['cuota_1x2']}")
    if row.get("prob_modelo"):
        parts.append(f"prob_modelo={row['prob_modelo']}")
    if row.get("prob_mercado_implicita"):
        parts.append(f"prob_mercado={row['prob_mercado_implicita']}")
    if row.get("edge"):
        parts.append(f"edge={row['edge']}")
    if row.get("valor_sn"):
        parts.append(f"valor={row['valor_sn']}")
    if row.get("prob_justa_pick"):
        parts.append(f"prob_justa={row['prob_justa_pick']}")
    if row.get("confianza"):
        parts.append(f"confianza={row['confianza']}")
    if status == "pending" and row.get("resultado_real"):
        # not a settled result yet -- keep the as-of-cutoff live status as
        # context, not as result_note (which implies settlement)
        parts.append(f"estado_al_corte={row['resultado_real']}")
    return "; ".join(parts) if parts else None


def seed(db_path: str) -> int:
    with PicksDB(db_path) as db:
        n = 0
        with open(SEED_CSV, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                status = STATUS_MAP.get(row["acierto"].strip(), "pending")
                market = MARKET_MAP.get(row["mercado"].strip(), row["mercado"].strip() or None)
                decimal_odds = float(row["cuota_pick"]) if row.get("cuota_pick") else None

                pid = db.add_pick(
                    sport="soccer",
                    league=row["liga"],
                    event=row["partido"],
                    event_date=row["fecha"],
                    market=market or "unspecified",
                    selection=row["pick"],
                    decimal_odds=decimal_odds,
                    model_prob=None,  # see module docstring: legacy picks are never model-graded
                    status="pending",  # settle below if the CSV says otherwise; add_pick always starts pending
                    legacy_note=build_legacy_note(row, status),
                    source=f"{SOURCE_DOC}:tanda-{row['tanda']}",
                )
                if status != "pending":
                    db.settle_pick(pid, status, result_note=row.get("resultado_real") or None)
                n += 1
        return n


if __name__ == "__main__":
    db_path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent / "picks.db")
    count = seed(db_path)
    print(f"Imported {count} legacy picks into {db_path}")
