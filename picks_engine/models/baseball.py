"""MLB: Elo with margin-of-victory scaling, tuned down.

Baseball outcomes are noisier game-to-game than NBA/NFL (a great team still
loses ~35-40% of its games over a 162-game season), so both K and the home
advantage default are set much lower than basketball/football -- ratings
should move slowly on any single result. Defaults here (K=4,
home_advantage=24) are illustrative starting points in that spirit, not
fit against real MLB history.

Known gap, and it's a big one for baseball specifically: the single
starting pitcher matters enormously and isn't modeled at all here -- this
is team-Elo-from-final-scores only. A serious MLB model blends team Elo
with a separate starting-pitcher rating (this is what public MLB Elo
systems, e.g. FiveThirtyEight's, actually do); that's a documented next
step, not implemented in this version (see README).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from picks_engine.models._margin_elo import MarginEloConfig, MarginEloModel


def default_config() -> MarginEloConfig:
    return MarginEloConfig(sport="MLB", k=4.0, home_advantage=24.0)


@dataclass
class MLBEloModel(MarginEloModel):
    config: MarginEloConfig = field(default_factory=default_config)
