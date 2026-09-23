"""NBA (and, with looser confidence, other pro basketball leagues): Elo with
margin-of-victory scaling.

Defaults (K=20, home_advantage=100) are the publicly-documented starting
point from FiveThirtyEight's NBA Elo methodology, not something fit against
real data in this codebase -- treat as a v1 prior. FiveThirtyEight's actual
production model also folds in rest days, injuries (via a separate player
value system called RAPTOR/CARM-Elo) and back-to-back schedule effects;
none of that is here. Team-level Elo from scores alone is a reasonable
baseline, not the ceiling.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from picks_engine.models._margin_elo import MarginEloConfig, MarginEloModel


def default_config() -> MarginEloConfig:
    return MarginEloConfig(sport="NBA", k=20.0, home_advantage=100.0)


@dataclass
class NBAEloModel(MarginEloModel):
    config: MarginEloConfig = field(default_factory=default_config)
