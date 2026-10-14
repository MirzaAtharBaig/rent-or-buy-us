"""Pure transforms from raw observations to the annual series the simulator uses.

Everything here is side-effect free so it can be unit-tested with small fixtures.
Observations are lists of (date, value) with value None for missing points.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Iterable, Sequence

Obs = Sequence[tuple[date, float | None]]


class CoverageError(ValueError):
    """Raised when a series doesn't cover every year the simulator needs."""


def _by_year_month(obs: Obs) -> dict[tuple[int, int], float]:
    return {(d.year, d.month): v for d, v in obs if v is not None}


def pct_change(a: float, b: float) -> float:
    return round((b / a - 1.0) * 100.0, 2)


def period_end_changes(obs: Obs, years: Iterable[int], month: int, series_id: str) -> list[float]:
    """Year-over-year % change using one fixed month (12 for Dec/Dec, 10 for a Q4 quarterly series).

    The change for year Y compares month M of Y with month M of Y-1.
    """
    ym = _by_year_month(obs)
    out: list[float] = []
    missing: list[int] = []
    for y in years:
        a, b = ym.get((y - 1, month)), ym.get((y, month))
        if a is None or b is None or a <= 0:
            missing.append(y)
            continue
        out.append(pct_change(a, b))
    if missing:
        raise CoverageError(f"{series_id}: no observation for month {month} around years {missing}")
    return out


def annual_averages(obs: Obs, years: Iterable[int], series_id: str, min_months: int = 10) -> dict[int, float]:
    """Calendar-year mean of monthly observations. Tolerates a few missing months
    (e.g. the Oct 2025 CPI gap) but fails if fewer than `min_months` are present."""
    buckets: dict[int, list[float]] = defaultdict(list)
    for d, v in obs:
        if v is not None:
            buckets[d.year].append(v)
    out: dict[int, float] = {}
    short: list[int] = []
    for y in years:
        vals = buckets.get(y, [])
        if len(vals) < min_months:
            short.append(y)
            continue
        out[y] = sum(vals) / len(vals)
    if short:
        raise CoverageError(f"{series_id}: fewer than {min_months} monthly values in {short}")
    return out


def average_changes(obs: Obs, years: Sequence[int], series_id: str) -> list[float]:
    """% change in calendar-year averages (used for CPI rent, matching BLS annual-average practice)."""
    avg = annual_averages(obs, [years[0] - 1, *years], series_id)
    return [pct_change(avg[y - 1], avg[y]) for y in years]


def average_levels(obs: Obs, years: Sequence[int], series_id: str) -> list[float]:
    avg = annual_averages(obs, years, series_id)
    return [round(avg[y], 2) for y in years]


def level_differences(obs: Obs, years: Sequence[int], series_id: str) -> list[float]:
    """Change in annual-average level, in percentage points (used for interest rates)."""
    avg = annual_averages(obs, [years[0] - 1, *years], series_id)
    return [round(avg[y] - avg[y - 1], 2) for y in years]


def latest(obs: Obs) -> tuple[date, float]:
    for d, v in reversed(list(obs)):
        if v is not None:
            return d, v
    raise CoverageError("series has no observations")


def effective_tax_rate(taxes: float, value: float) -> float:
    """ACS effective property-tax rate: aggregate taxes paid / aggregate home value, in percent."""
    if value <= 0:
        raise ValueError("aggregate value must be positive")
    return round(taxes / value * 100.0, 3)
