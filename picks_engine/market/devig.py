"""Convert bookmaker decimal odds into fair (no-vig) probabilities.

A bookmaker's quoted odds always imply probabilities that sum to more than
100% -- the extra is the "vig" or "overround", the house's built-in margin.
Comparing a model's probability against the *raw* implied probability is
unfair to the model (it's being compared against a number that is, by
construction, too high). Everything downstream (edge, Kelly stake) needs the
de-vigged ("fair") probability instead.

Two methods are provided:

- ``multiplicative``: the simple, standard approach. Divide each raw implied
  probability by the overround. Assumes the vig is spread proportionally
  across all outcomes. Good enough for most two/three-way markets.

- ``shin``: Shin's (1992) method, which assumes the overround partly comes
  from informed ("insider") money and corrects for the fact that vig is
  usually NOT spread proportionally -- longshots tend to carry more of it
  than favorites (the "favorite-longshot bias"). More accurate for skewed
  markets (e.g. a 1.08 / 12.00 / 34.00 line), which is exactly the kind of
  market this project deals with a lot (heavy favorites in football,
  tennis moneylines, etc).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from scipy.optimize import brentq


@dataclass(frozen=True)
class DevigResult:
    fair_probabilities: tuple[float, ...]
    overround: float
    method: str
    # Shin's "z": estimated proportion of insider/informed money. 0.0 for
    # the multiplicative method (it doesn't model this).
    z: float = 0.0

    def as_dict(self) -> dict:
        return {
            "fair_probabilities": list(self.fair_probabilities),
            "overround": self.overround,
            "method": self.method,
            "z": self.z,
        }


def raw_implied_probabilities(odds: Sequence[float]) -> list[float]:
    """1/odds for each outcome. Does NOT remove the vig."""
    if len(odds) < 2:
        raise ValueError("Need at least 2 odds to form a market")
    for o in odds:
        if o <= 1.0:
            raise ValueError(f"Decimal odds must be > 1.0, got {o}")
    return [1.0 / o for o in odds]


def devig_multiplicative(odds: Sequence[float]) -> DevigResult:
    p = raw_implied_probabilities(odds)
    overround = sum(p)
    fair = tuple(pi / overround for pi in p)
    return DevigResult(fair_probabilities=fair, overround=overround, method="multiplicative")


def devig_shin(odds: Sequence[float], *, max_iter: int = 100) -> DevigResult:
    """Shin's (1992) de-vig method.

    Solves for z in the closed-form relation:

        pi_i = (sqrt(z^2 + 4(1-z) * p_i^2 / S) - z) / (2(1-z))

    where p_i are raw implied probabilities, S = sum(p_i) (the overround),
    chosen so that sum(pi_i) == 1.

    Falls back to the multiplicative method (with z=0) if the market has no
    overround (S <= 1, e.g. a promo / arbitrage line) or if root-finding
    fails for numerical reasons.
    """
    p = raw_implied_probabilities(odds)
    total = sum(p)

    if total <= 1.0:
        fair = tuple(pi / total for pi in p)
        return DevigResult(fair_probabilities=fair, overround=total, method="shin", z=0.0)

    def pi_of_z(z: float) -> list[float]:
        return [
            (math.sqrt(z * z + 4 * (1 - z) * (pi * pi) / total) - z) / (2 * (1 - z))
            for pi in p
        ]

    def f(z: float) -> float:
        return sum(pi_of_z(z)) - 1.0

    lo, hi = 0.0, 1.0 - 1e-9
    f_lo, f_hi = f(lo), f(hi)

    if f_lo * f_hi > 0:
        # Root not bracketed (can happen with near-uniform, low-overround
        # markets) -- multiplicative is a safe, sane fallback.
        fair = tuple(pi / total for pi in p)
        return DevigResult(fair_probabilities=fair, overround=total, method="multiplicative", z=0.0)

    z = brentq(f, lo, hi, maxiter=max_iter)
    fair_raw = pi_of_z(z)
    # Numerical safety: renormalize so it sums to exactly 1.
    s = sum(fair_raw)
    fair = tuple(v / s for v in fair_raw)
    return DevigResult(fair_probabilities=fair, overround=total, method="shin", z=z)


def devig(odds: Sequence[float], method: str = "shin") -> DevigResult:
    """Convenience dispatcher. method: 'shin' (default) or 'multiplicative'."""
    if method == "shin":
        return devig_shin(odds)
    if method == "multiplicative":
        return devig_multiplicative(odds)
    raise ValueError(f"Unknown devig method: {method!r}")
