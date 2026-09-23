"""NFL: Elo with margin-of-victory scaling.

Defaults (K=20, home_advantage=48) follow FiveThirtyEight's publicly
documented NFL Elo starting point. Known gaps versus a production-grade NFL
model: no quarterback adjustment (538's own NFL Elo blends in a QB-value
term that moves ratings a lot when a team's starting QB changes -- this is
arguably the single biggest lever in NFL prediction and it's not here), no
rest-day/travel adjustment, no preseason mean-reversion between seasons.
Treat this as team-strength-from-final-scores only.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from picks_engine.models._margin_elo import MarginEloConfig, MarginEloModel


def default_config() -> MarginEloConfig:
    return MarginEloConfig(sport="NFL", k=20.0, home_advantage=48.0)


@dataclass
class NFLEloModel(MarginEloModel):
    config: MarginEloConfig = field(default_factory=default_config)
