#!/usr/bin/env python3
"""Worked example: the full pipeline (fit a model -> de-vig the market ->
compute edge/Kelly -> log the pick -> settle it -> evaluate) on one real
matchup from this project's history: Independiente Medellin vs Jaguares de
Cordoba, Liga BetPlay, 22 sep 2026.

Run: python3 scripts/example_end_to_end.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from picks_engine.evaluation.metrics import evaluate_picks  # noqa: E402
from picks_engine.models.soccer import fit_team_strengths  # noqa: E402
from picks_engine.tracking.db import PicksDB  # noqa: E402
from picks_engine.valuation.ev import evaluate  # noqa: E402


def main() -> None:
    # 1) Fit team strengths from recent results. In production this comes
    #    from a real historical-results feed (see README "Fuentes de
    #    datos"); here it's a small illustrative sample so the script is
    #    runnable with zero external dependencies/API keys.
    recent_matches = [
        ("Independiente Medellin", "Once Caldas", 2, 0),
        ("Once Caldas", "Independiente Medellin", 1, 1),
        ("Independiente Medellin", "Bucaramanga", 3, 1),
        ("Jaguares de Cordoba", "Independiente Medellin", 1, 2),
        ("Jaguares de Cordoba", "Alianza FC", 0, 0),
        ("Union Magdalena", "Jaguares de Cordoba", 2, 1),
        ("Jaguares de Cordoba", "Once Caldas", 0, 2),
        ("Bucaramanga", "Jaguares de Cordoba", 3, 0),
    ]
    model = fit_team_strengths(recent_matches)
    print("Fuerzas ataque/defensa (relativas a 1.0 = promedio de esta muestra):")
    for team, s in model.strengths.items():
        print(f"  {team:28s} attack={s.attack:.2f}  defense={s.defense:.2f}")
    print(
        "  (con solo 1-2 partidos por equipo estas fuerzas son ruido, no señal -- "
        "Alianza FC en 0.00 es un solo 0-0, no 'el peor ataque de la liga'. "
        "Esto es exactamente el problema de muestra chica que motivó este proyecto; "
        "con datos históricos reales de una temporada completa esto se estabiliza.)"
    )

    # 2) Model's probabilities for the match.
    probs = model.match_probabilities("Independiente Medellin", "Jaguares de Cordoba")
    print("\nProbabilidades del modelo (Medellin de local):")
    for k, v in probs.items():
        print(f"  {k:20s} {v:.1%}")

    # 3) The market's own 1X2 line (this is the real line captured in the
    #    original doc for this match).
    market_1x2 = [1.26, 5.50, 11.50]  # [home, draw, away]

    # 4) The pick that matters here is DOUBLE CHANCE 1X (home-or-draw), not
    #    a single 1X2 leg. Combine the model's home+draw probability, and
    #    approximate the market's double-chance price from the 1X2 legs
    #    (1 / (1/odds_home + 1/odds_draw) -- an approximation, since a
    #    book's actual double-chance quote can differ slightly from this;
    #    see README "Limitaciones").
    model_prob_1x = probs["double_chance_1x"]
    approx_1x_odds = 1.0 / (1.0 / market_1x2[0] + 1.0 / market_1x2[1])
    print(f"\nModelo P(1X) = {model_prob_1x:.1%}   cuota 1X aproximada del mercado = {approx_1x_odds:.2f}")

    valuation = evaluate(
        model_prob=model_prob_1x,
        market_odds=[approx_1x_odds, 1.0 / (1.0 - 1.0 / approx_1x_odds)],  # crude 2-way normalization, see note below
        picked_index=0,
    )
    # NOTE: the second "leg" constructed above is a placeholder to satisfy
    # evaluate()'s need for a full market (it needs >=2 prices to detect
    # the overround). For a real double-chance market, use the book's own
    # two-way double-chance/lay price instead of this approximation.
    print(f"Edge estimado: {valuation.edge:+.1%}   Kelly (1/4) sugerido: {valuation.kelly_stake:.1%} del bankroll de papel")

    # 5) Log it.
    db = PicksDB("example.db")
    pick_id = db.add_pick(
        sport="soccer",
        league="Liga BetPlay",
        event="Independiente Medellin vs Jaguares de Cordoba",
        event_date="2026-09-22",
        market="double_chance_1x",
        selection="Medellin o empate",
        decimal_odds=approx_1x_odds,
        devig_method="shin",
        model_prob=model_prob_1x,
        fair_market_prob=valuation.fair_market_prob,
        edge=valuation.edge,
        kelly_stake=valuation.kelly_stake,
        source="example_end_to_end.py",
    )
    print(f"\nPick #{pick_id} guardado en example.db (status=pending)")

    # 6) Settle it once the real result is known, then evaluate.
    db.settle_pick(pick_id, "won", result_note="Medellin gano/empato (ejemplo)")
    graded = db.graded_picks_for_evaluation()
    summary = evaluate_picks(graded, min_reliable_n=100)
    print(f"\nEvaluación con {summary.n} pick(s) graded — reliable={summary.reliable} "
          f"(hacen falta {summary.min_reliable_n} para que esto signifique algo real)")
    db.close()


if __name__ == "__main__":
    main()
