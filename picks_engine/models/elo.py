"""Generic Elo rating engine, sport-agnostic.

This is the shared core used by every sport model in this package. A sport
module (tennis.py, basketball.py, football.py, baseball.py) is mostly just:
"how do I turn a game result into a score_a in [0, 1] and a margin-of-victory
multiplier", handed to this engine.

Design notes (read before tuning K-factors):

- Ratings live in a plain ``dict[str, float]`` wrapped by :class:`EloRatings`.
  There is no database here on purpose -- persistence is the tracking
  module's job (picks_engine.tracking.db), not the model's.
- ``expected(a, b)`` is the standard logistic Elo win probability. The
  denominator 400 is the historic Elo convention (chess); it just sets the
  rating scale, it is not sacred, but changing it means every K-factor and
  starting rating in this codebase needs re-tuning, so leave it alone unless
  you are recalibrating everything.
- ``k`` (the update speed) and the margin-of-victory multiplier are
  deliberately NOT hardcoded here -- they are sport-specific and passed in by
  the caller. FiveThirtyEight's public NBA/NFL Elo writeups are the reference
  point for the constants used in models/basketball.py and models/football.py.
- Nothing here is fit to real historical data yet. Starting ratings default
  to 1500 (neutral) for any team not seen before, which is fine once a
  season's worth of games has flowed through, but is a cold-start problem for
  a brand-new team/player. See README "Limitaciones" section.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


DEFAULT_RATING = 1500.0


@dataclass
class EloRatings:
    """Mutable store of current ratings for one sport/league.

    Kept intentionally dumb (no history, no persistence) -- wrap it with
    picks_engine.tracking.db if you need to replay/audit rating changes over
    time.
    """

    ratings: dict[str, float] = field(default_factory=dict)
    default_rating: float = DEFAULT_RATING

    def get(self, team: str) -> float:
        return self.ratings.get(team, self.default_rating)

    def set(self, team: str, value: float) -> None:
        self.ratings[team] = value

    def expected(self, team_a: str, team_b: str, home_advantage: float = 0.0) -> float:
        """P(team_a beats team_b), team_a treated as playing at home if
        home_advantage != 0 (pass 0 for a neutral-site match, e.g. most
        tennis and many Champions-League-style fixtures)."""
        return expected_score(self.get(team_a) + home_advantage, self.get(team_b))

    def update(
        self,
        team_a: str,
        team_b: str,
        score_a: float,
        k: float,
        mov_multiplier: float = 1.0,
        home_advantage: float = 0.0,
    ) -> tuple[float, float]:
        """Update both teams' ratings after a result.

        score_a: 1.0 if team_a won, 0.0 if team_b won, 0.5 for a draw
        (soccer/hockey-style ties -- most of the sports modeled here don't
        have draws, but the engine supports it).
        Returns (new_rating_a, new_rating_b).
        """
        ra, rb = self.get(team_a), self.get(team_b)
        exp_a = expected_score(ra + home_advantage, rb)
        delta = k * mov_multiplier * (score_a - exp_a)
        new_a, new_b = ra + delta, rb - delta
        self.set(team_a, new_a)
        self.set(team_b, new_b)
        return new_a, new_b


def expected_score(rating_a: float, rating_b: float) -> float:
    """Standard logistic Elo expectation: P(a beats b)."""
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))


def mov_multiplier_538(point_diff: float, elo_diff_winner: float, *, base: float = 2.2, scale: float = 0.001) -> float:
    """FiveThirtyEight-style margin-of-victory multiplier.

    Used by the NBA/NFL/MLB models so a 30-point blowout moves ratings more
    than a 1-point nail-biter, while damping the effect for favorites who
    are "supposed to" win big (elo_diff_winner = winner's rating minus
    loser's rating, BEFORE the game).

        multiplier = ln(|point_diff| + 1) * base / (elo_diff_winner * scale + base)

    point_diff must be non-zero (there's no MOV concept for a 0-0 tie in a
    market that doesn't allow ties; sports without margins, e.g. tennis
    moneyline, should just pass mov_multiplier=1.0 to EloRatings.update
    instead of calling this).
    """
    if point_diff == 0:
        raise ValueError("mov_multiplier_538 needs a non-zero margin")
    return math.log(abs(point_diff) + 1) * base / (elo_diff_winner * scale + base)


def elo_to_probabilities_multiway(elos: dict[str, float]) -> dict[str, float]:
    """Not used for head-to-head sports, but handy for e.g. futures-style
    "who wins the tournament" markets with >2 entrants: softmax over ratings
    scaled by the same 400-point convention as expected_score."""
    if not elos:
        return {}
    scaled = {k: 10 ** (v / 400.0) for k, v in elos.items()}
    total = sum(scaled.values())
    return {k: v / total for k, v in scaled.items()}
