"""Soccer/football (goals) model: independent Poisson with attack/defense
strengths, optional Dixon-Coles low-score correction.

Why Poisson and not Elo-for-a-single-winner: soccer markets (1X2, double
chance, over/under, BTTS) are all really questions about the joint
distribution of (home_goals, away_goals). Modeling goals directly gets you
every one of those markets from a single fitted model instead of a separate
Elo instance per market. This is the standard approach in the public
literature (Maher 1982; Dixon & Coles 1997).

What this does NOT do (see README "Limitaciones" for the honest list):
- Team strengths are fit via a moments-based approximation (average
  goals scored/conceded relative to league average), not the iterative
  maximum-likelihood fit from the original Dixon-Coles paper. The MLE fit
  is more accurate, especially early in a season with uneven schedules;
  it's a documented upgrade path, not implemented here to keep this
  shippable.
- No time-decay weighting of older results (Dixon-Coles' xi parameter).
  A team's form from 18 months ago counts the same as last week's.
- rho (the low-score correlation correction) defaults to 0 -- i.e. off --
  because fitting it needs the same historical-match dataset as the MLE
  strengths above. Pass a fitted rho (typically -0.05 to -0.15) once you
  have one.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from scipy.stats import poisson


@dataclass(frozen=True)
class TeamStrength:
    attack: float  # >1.0 = scores more than league-average team, <1.0 = less
    defense: float  # >1.0 = concedes more than league-average team (i.e. weak defense), <1.0 = strong defense


def _dixon_coles_tau(x: int, y: int, lam: float, mu: float, rho: float) -> float:
    """Low-score correction factor from Dixon & Coles (1997), eq. 5.
    Only touches the four (0,0)/(0,1)/(1,0)/(1,1) cells; everything else
    is untouched (tau=1) because that's the scope Dixon & Coles found the
    independence assumption breaks down for."""
    if x == 0 and y == 0:
        return 1 - lam * mu * rho
    if x == 0 and y == 1:
        return 1 + lam * rho
    if x == 1 and y == 0:
        return 1 + mu * rho
    if x == 1 and y == 1:
        return 1 - rho
    return 1.0


@dataclass
class SoccerPoissonModel:
    league_avg_home_goals: float
    league_avg_away_goals: float
    strengths: dict[str, TeamStrength] = field(default_factory=dict)
    rho: float = 0.0
    default_strength: TeamStrength = field(default_factory=lambda: TeamStrength(1.0, 1.0))

    def expected_goals(self, home: str, away: str) -> tuple[float, float]:
        sh = self.strengths.get(home, self.default_strength)
        sa = self.strengths.get(away, self.default_strength)
        lam_home = self.league_avg_home_goals * sh.attack * sa.defense
        lam_away = self.league_avg_away_goals * sa.attack * sh.defense
        return lam_home, lam_away

    def scoreline_matrix(self, home: str, away: str, max_goals: int = 10) -> list[list[float]]:
        """matrix[i][j] = P(home scores i, away scores j). Truncated at
        max_goals per side (10 covers >99.9% of real matches' mass)."""
        lam_home, lam_away = self.expected_goals(home, away)
        matrix = [[0.0] * (max_goals + 1) for _ in range(max_goals + 1)]
        for i in range(max_goals + 1):
            p_i = poisson.pmf(i, lam_home)
            for j in range(max_goals + 1):
                p = p_i * poisson.pmf(j, lam_away)
                if self.rho != 0.0:
                    p *= _dixon_coles_tau(i, j, lam_home, lam_away, self.rho)
                matrix[i][j] = p
        return matrix

    def match_probabilities(self, home: str, away: str, max_goals: int = 10) -> dict[str, float]:
        matrix = self.scoreline_matrix(home, away, max_goals)
        total = sum(sum(row) for row in matrix)  # < 1 due to truncation; renormalize
        home_win = sum(matrix[i][j] for i in range(max_goals + 1) for j in range(max_goals + 1) if i > j)
        draw = sum(matrix[i][i] for i in range(max_goals + 1))
        away_win = sum(matrix[i][j] for i in range(max_goals + 1) for j in range(max_goals + 1) if i < j)
        return {
            "home_win": float(home_win / total),
            "draw": float(draw / total),
            "away_win": float(away_win / total),
            "double_chance_1x": float((home_win + draw) / total),
            "double_chance_x2": float((draw + away_win) / total),
            "double_chance_12": float((home_win + away_win) / total),
        }

    def over_under(self, home: str, away: str, line: float = 2.5, max_goals: int = 10) -> dict[str, float]:
        matrix = self.scoreline_matrix(home, away, max_goals)
        total = sum(sum(row) for row in matrix)
        over = sum(
            matrix[i][j]
            for i in range(max_goals + 1)
            for j in range(max_goals + 1)
            if i + j > line
        )
        return {"over": float(over / total), "under": float(1 - over / total)}

    def both_teams_to_score(self, home: str, away: str, max_goals: int = 10) -> dict[str, float]:
        matrix = self.scoreline_matrix(home, away, max_goals)
        total = sum(sum(row) for row in matrix)
        yes = sum(
            matrix[i][j]
            for i in range(1, max_goals + 1)
            for j in range(1, max_goals + 1)
        )
        return {"yes": float(yes / total), "no": float(1 - yes / total)}


def fit_team_strengths(
    matches: list[tuple[str, str, int, int]],
) -> SoccerPoissonModel:
    """Fit attack/defense strengths from historical results.

    matches: list of (home_team, away_team, home_goals, away_goals).
    Needs a full round or two of fixtures per team to be meaningful --
    early-season strengths from 1-2 games are noise, not signal. Callers
    should gate on a minimum sample size (see README) before trusting this.

    Method: each team's attack/defense strength is its average
    goals-scored / goals-conceded per game, relative to the league-average
    goals per game. This is the standard "moments" approximation, not a
    true joint MLE fit (see module docstring).
    """
    if not matches:
        raise ValueError("Need at least one match to fit strengths")

    n = len(matches)
    league_avg_home_goals = sum(hg for _, _, hg, _ in matches) / n
    league_avg_away_goals = sum(ag for _, _, _, ag in matches) / n
    league_avg_goals = (league_avg_home_goals + league_avg_away_goals) / 2.0

    teams = {h for h, _, _, _ in matches} | {a for _, a, _, _ in matches}
    strengths: dict[str, TeamStrength] = {}

    for team in teams:
        scored = 0
        conceded = 0
        played = 0
        for h, a, hg, ag in matches:
            if h == team:
                scored += hg
                conceded += ag
                played += 1
            elif a == team:
                scored += ag
                conceded += hg
                played += 1
        if played == 0:
            continue
        avg_scored = scored / played
        avg_conceded = conceded / played
        strengths[team] = TeamStrength(
            attack=avg_scored / league_avg_goals,
            defense=avg_conceded / league_avg_goals,
        )

    return SoccerPoissonModel(
        league_avg_home_goals=league_avg_home_goals,
        league_avg_away_goals=league_avg_away_goals,
        strengths=strengths,
    )
