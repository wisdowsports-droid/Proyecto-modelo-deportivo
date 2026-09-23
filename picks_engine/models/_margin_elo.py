"""Shared implementation for margin-of-victory Elo sports (NBA, NFL, MLB).

These three sports are structurally the same problem for Elo purposes: two
teams, a home team, a final-score margin, no draws. They differ only in the
tuning constants (K-factor, home advantage, MOV curve shape), so this module
holds ONE implementation and models/basketball.py, models/football.py,
models/baseball.py are thin config wrappers around it. Change behavior for
all three here; change behavior for just one of them in its own file.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from picks_engine.models.elo import EloRatings, mov_multiplier_538


@dataclass(frozen=True)
class MarginEloConfig:
    sport: str
    k: float
    home_advantage: float
    mov_base: float = 2.2
    mov_scale: float = 0.001


@dataclass
class MarginEloModel:
    config: MarginEloConfig
    ratings: EloRatings = field(default_factory=EloRatings)

    def win_probability(self, team_home: str, team_away: str) -> float:
        return self.ratings.expected(team_home, team_away, home_advantage=self.config.home_advantage)

    def record_result(self, team_home: str, team_away: str, home_score: int, away_score: int) -> tuple[float, float]:
        if home_score == away_score:
            raise ValueError(
                f"{self.config.sport} model does not support ties "
                f"({team_home} {home_score} - {away_score} {team_away})"
            )
        margin = home_score - away_score
        home_won = margin > 0
        score_home = 1.0 if home_won else 0.0

        home_elo_adj = self.ratings.get(team_home) + self.config.home_advantage
        away_elo = self.ratings.get(team_away)
        elo_diff_winner = (home_elo_adj - away_elo) if home_won else (away_elo - home_elo_adj)

        mov = mov_multiplier_538(
            point_diff=margin,
            elo_diff_winner=elo_diff_winner,
            base=self.config.mov_base,
            scale=self.config.mov_scale,
        )
        return self.ratings.update(
            team_home,
            team_away,
            score_a=score_home,
            k=self.config.k,
            mov_multiplier=mov,
            home_advantage=self.config.home_advantage,
        )
