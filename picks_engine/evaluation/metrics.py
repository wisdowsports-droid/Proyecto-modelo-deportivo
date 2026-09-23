"""Scoring the engine honestly: calibration and paper ROI, not win rate.

Why not just count wins/losses ("we went 6-4, we're good"): a well-calibrated
70%-confidence pick is SUPPOSED to lose 30% of the time. Judging the system
by whether any individual pick hit conflates variance with skill -- exactly
the trap the original doc-based "prueba en papel" fell into with an 8-pick
and a 5-pick sample. These metrics instead ask "when the model says 70%,
does it actually happen about 70% of the time, over many picks" (Brier
score, log-loss, calibration bins) and "would this have made or lost paper
money" (ROI) -- both of which need real sample size to mean anything.

Rule of thumb used here (min_reliable_n, default 100): below ~100 graded
picks, treat brier/log-loss/roi as "too early to tell", not as a verdict.
That threshold isn't a magic constant -- it's a conservative floor. Real
statistical significance for a betting edge typically needs even more than
that; 100 is "stop pretending this is noise-free", not "this is proven".
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


def brier_score(predictions: list[tuple[float, int]]) -> float:
    """Mean squared error between predicted probability and outcome (0/1).
    0 = perfect, 0.25 = what you get from guessing 50% on everything
    (a coin-flip model), useful as a baseline to beat. Lower is better."""
    if not predictions:
        raise ValueError("Need at least one prediction")
    return sum((p - o) ** 2 for p, o in predictions) / len(predictions)


def log_loss(predictions: list[tuple[float, int]], eps: float = 1e-15) -> float:
    """Mean negative log-likelihood. Punishes confident-and-wrong much
    harder than Brier does (a 99%-confidence pick that loses costs a lot
    more log-loss than a 60%-confidence one that loses) -- use alongside
    Brier, not instead of it, since they penalize different failure modes."""
    if not predictions:
        raise ValueError("Need at least one prediction")
    total = 0.0
    for p, o in predictions:
        p = min(max(p, eps), 1 - eps)
        total += -(o * math.log(p) + (1 - o) * math.log(1 - p))
    return total / len(predictions)


@dataclass(frozen=True)
class CalibrationBin:
    lo: float
    hi: float
    count: int
    avg_predicted: float | None
    actual_rate: float | None


def calibration_bins(predictions: list[tuple[float, int]], n_bins: int = 10) -> list[CalibrationBin]:
    """Bucket predictions by predicted probability and compare against the
    actual hit rate in each bucket. A well-calibrated model has
    avg_predicted ~= actual_rate in every bucket with enough count to judge.
    With few graded picks most buckets will have count=0 or 1 -- that's
    expected, not a bug; it's the same small-sample problem this whole
    module exists to make visible instead of paper over."""
    buckets: list[list[tuple[float, int]]] = [[] for _ in range(n_bins)]
    for p, o in predictions:
        idx = min(int(p * n_bins), n_bins - 1)
        buckets[idx].append((p, o))

    out = []
    for i, b in enumerate(buckets):
        lo, hi = i / n_bins, (i + 1) / n_bins
        if not b:
            out.append(CalibrationBin(lo, hi, 0, None, None))
            continue
        avg_pred = sum(p for p, _ in b) / len(b)
        actual = sum(o for _, o in b) / len(b)
        out.append(CalibrationBin(lo, hi, len(b), avg_pred, actual))
    return out


@dataclass(frozen=True)
class RoiResult:
    n: int
    total_staked: float
    total_return: float
    profit: float
    roi_pct: float | None


def paper_roi(picks: list[dict], *, stake_field: str = "kelly_stake", flat_stake: float = 1.0) -> RoiResult:
    """picks: rows shaped like picks_engine.tracking.db rows (need at least
    'status' in {'won','lost'} and 'decimal_odds'; 'kelly_stake' used as the
    bet size if present and stake_field='kelly_stake', otherwise flat_stake
    units per pick). Ignores pending/push/void/no_pick rows."""
    total_staked = 0.0
    total_return = 0.0
    n = 0
    for pk in picks:
        if pk.get("status") not in ("won", "lost"):
            continue
        stake = pk.get(stake_field) if stake_field else None
        if not stake:
            stake = flat_stake
        total_staked += stake
        if pk["status"] == "won":
            total_return += stake * pk["decimal_odds"]
        n += 1
    profit = total_return - total_staked
    roi_pct = (profit / total_staked * 100.0) if total_staked else None
    return RoiResult(n=n, total_staked=total_staked, total_return=total_return, profit=profit, roi_pct=roi_pct)


@dataclass(frozen=True)
class EvaluationSummary:
    n: int
    reliable: bool
    min_reliable_n: int
    brier: float | None
    log_loss: float | None
    calibration: list[CalibrationBin]
    roi: RoiResult | None


def evaluate_picks(picks: list[dict], *, min_reliable_n: int = 100, stake_field: str = "kelly_stake") -> EvaluationSummary:
    """picks should already be filtered to graded, model-backed picks --
    see picks_engine.tracking.db.PicksDB.graded_picks_for_evaluation, which
    does exactly that filtering. Passing raw/ungraded/legacy rows here will
    KeyError or silently mix incomparable eras of picks together."""
    predictions = [(pk["model_prob"], 1 if pk["status"] == "won" else 0) for pk in picks]
    n = len(predictions)
    if n == 0:
        return EvaluationSummary(
            n=0, reliable=False, min_reliable_n=min_reliable_n,
            brier=None, log_loss=None, calibration=[], roi=None,
        )
    return EvaluationSummary(
        n=n,
        reliable=n >= min_reliable_n,
        min_reliable_n=min_reliable_n,
        brier=brier_score(predictions),
        log_loss=log_loss(predictions),
        calibration=calibration_bins(predictions),
        roi=paper_roi(picks, stake_field=stake_field),
    )
