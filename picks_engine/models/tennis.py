"""Tennis: Elo with surface blending and experience-based dynamic K.

Two things make tennis Elo different from a generic team-sport Elo:

1. No home/away -- almost every tour match is effectively neutral site, so
   home_advantage is not a parameter here (pass 0 implicitly).
2. Surface matters a lot (clay-court specialists vs hard-court players).
   This blends an overall rating with a surface-specific rating rather than
   keeping them fully separate, because a surface-only rating for a player
   with few matches on that surface is unreliable -- blending lets the
   overall rating cover the cold-start.

The dynamic K-factor (K shrinks as a player accumulates matches) is the
same idea Glicko uses via rating deviation, done the cheap Elo-friendly way:
new players' ratings move fast (few informative results yet), veterans'
ratings move slowly (a lot of evidence already backs their rating up). The
formula k = k_base / (matches_played + k_offset) ** k_power is the one
popularized by publicly-documented tennis Elo implementations (e.g. the
FiveThirtyEight tennis Elo methodology writeup); defaults here match theirs
as a starting point, not as ground truth -- recalibrate against real ATP/WTA
history if you want serious accuracy (see README).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from picks_engine.models.elo import EloRatings, expected_score


@dataclass
class TennisConfig:
    surface_weight: float = 0.5  # 0 = ignore surface entirely, 1 = surface rating only
    k_base: float = 250.0
    k_offset: float = 5.0
    k_power: float = 0.4


@dataclass
class TennisEloModel:
    config: TennisConfig = field(default_factory=TennisConfig)
    overall: EloRatings = field(default_factory=EloRatings)
    by_surface: dict[str, EloRatings] = field(default_factory=dict)
    matches_played: dict[str, int] = field(default_factory=dict)

    def _surface_ratings(self, surface: str) -> EloRatings:
        if surface not in self.by_surface:
            self.by_surface[surface] = EloRatings()
        return self.by_surface[surface]

    def _blended_rating(self, player: str, surface: str | None) -> float:
        overall = self.overall.get(player)
        if not surface:
            return overall
        w = self.config.surface_weight
        surf = self._surface_ratings(surface).get(player)
        return w * surf + (1 - w) * overall

    def win_probability(self, player_a: str, player_b: str, surface: str | None = None) -> float:
        ra = self._blended_rating(player_a, surface)
        rb = self._blended_rating(player_b, surface)
        return expected_score(ra, rb)

    def dynamic_k(self, player: str) -> float:
        m = self.matches_played.get(player, 0)
        return self.config.k_base / (m + self.config.k_offset) ** self.config.k_power

    def record_result(self, winner: str, loser: str, surface: str | None = None) -> None:
        # Symmetric K for this match: average of each player's own
        # experience-adjusted K, so a veteran beating a newcomer doesn't
        # swing as hard as two newcomers playing each other, but swings
        # more than two veterans playing each other.
        k = (self.dynamic_k(winner) + self.dynamic_k(loser)) / 2.0
        self.overall.update(winner, loser, score_a=1.0, k=k)
        if surface:
            self._surface_ratings(surface).update(winner, loser, score_a=1.0, k=k)
        self.matches_played[winner] = self.matches_played.get(winner, 0) + 1
        self.matches_played[loser] = self.matches_played.get(loser, 0) + 1
