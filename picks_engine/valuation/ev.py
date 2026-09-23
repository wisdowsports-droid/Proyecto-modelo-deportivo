"""Turn (model probability, market odds) into an edge and a paper stake.

This is deliberately the smallest module in the codebase: it does one
well-defined thing (Kelly criterion math) and nothing else. All the
judgment calls about HOW confident to be in the model probability belong
upstream, in the sport model that produced it -- this module just does the
arithmetic honestly once a probability exists.

A note on what "edge" means here, since it's easy to misread a positive edge
as "this pick will probably win": edge is an expected-value statement, valid
over many repetitions, not a per-bet confidence statement. A pick can have a
genuine positive edge and still lose most of the time (e.g. a fair-value
+9.1% edge on a 13% chance shot still loses 87% of the time -- see the
Medellín-Jaguares-Cúcuta-style long-shot picks in the legacy data this
project inherited). Evaluate this system on calibration and long-run ROI
over many picks (picks_engine.evaluation.metrics), never on whether any
single pick hit.
"""
from __future__ import annotations

from dataclasses import dataclass

from picks_engine.market.devig import DevigResult, devig


@dataclass(frozen=True)
class Valuation:
    model_prob: float
    fair_market_prob: float
    decimal_odds: float
    edge: float  # model_prob - fair_market_prob
    kelly_full: float  # fraction of bankroll, full Kelly (can be 0 if no edge)
    kelly_stake: float  # fraction of bankroll actually recommended (after applying `fraction`)
    is_value: bool

    def as_dict(self) -> dict:
        return {
            "model_prob": self.model_prob,
            "fair_market_prob": self.fair_market_prob,
            "decimal_odds": self.decimal_odds,
            "edge": self.edge,
            "kelly_full": self.kelly_full,
            "kelly_stake": self.kelly_stake,
            "is_value": self.is_value,
        }


def kelly_fraction(model_prob: float, decimal_odds: float) -> float:
    """Full Kelly stake as a fraction of bankroll. 0 if there's no edge
    (never recommends a negative/short stake -- this project only ever
    takes the side offered, not lays it)."""
    if not (0.0 < model_prob < 1.0):
        raise ValueError(f"model_prob must be in (0, 1), got {model_prob}")
    if decimal_odds <= 1.0:
        raise ValueError(f"decimal_odds must be > 1.0, got {decimal_odds}")
    b = decimal_odds - 1.0  # net odds (profit per unit staked if it wins)
    q = 1.0 - model_prob
    f = (b * model_prob - q) / b
    return max(f, 0.0)


def evaluate(
    model_prob: float,
    market_odds: list[float],
    picked_index: int,
    *,
    devig_method: str = "shin",
    kelly_multiplier: float = 0.25,
    value_threshold: float = 0.02,
) -> Valuation:
    """The one function most callers need.

    model_prob: your model's probability that the outcome at
        market_odds[picked_index] happens.
    market_odds: the FULL set of decimal odds for the market (e.g.
        [home, draw, away] for a 1X2 line, or [player_a, player_b] for a
        tennis moneyline) -- needed to de-vig properly, a single price
        alone can't tell you the house's margin.
    picked_index: which outcome model_prob is about.
    kelly_multiplier: fractional Kelly (0.25 = quarter-Kelly). Full Kelly
        (1.0) is mathematically optimal for long-run bankroll growth ONLY
        if model_prob is exactly correct; in practice model probabilities
        have estimation error, so betting a fraction of full Kelly is the
        standard way to survive being wrong about how right you are.
    value_threshold: minimum edge to flag is_value=True. 2% is a common,
        conservative default -- small enough to catch real mispricings,
        large enough to not be pure model noise.
    """
    devig_result: DevigResult = devig(market_odds, method=devig_method)
    fair_market_prob = devig_result.fair_probabilities[picked_index]
    decimal_odds = market_odds[picked_index]

    edge = model_prob - fair_market_prob
    kf = kelly_fraction(model_prob, decimal_odds)
    stake = kf * kelly_multiplier

    return Valuation(
        model_prob=model_prob,
        fair_market_prob=fair_market_prob,
        decimal_odds=decimal_odds,
        edge=edge,
        kelly_full=kf,
        kelly_stake=stake,
        is_value=edge >= value_threshold,
    )
