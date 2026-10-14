"""Unit tests for pipeline/transforms.py using tiny hand-checked fixtures."""
from datetime import date

import pytest

from pipeline import transforms as T


def monthly(year_values: dict[int, float], months=range(1, 13)):
    return [(date(y, m, 1), v) for y, v in year_values.items() for m in months]


def test_dec_to_dec_change():
    obs = [(date(2000, 12, 1), 100.0), (date(2001, 12, 1), 103.0), (date(2002, 12, 1), 103.0)]
    assert T.period_end_changes(obs, [2001, 2002], 12, "X") == [3.0, 0.0]


def test_q4_change_uses_october_dates():
    obs = [(date(2024, 10, 1), 323.49), (date(2025, 10, 1), 336.34)]  # FHFA Lincoln, NE Q4 values
    assert T.period_end_changes(obs, [2025], 10, "ATNHPIUS30700Q") == [3.97]


def test_missing_period_raises():
    obs = [(date(2000, 12, 1), 100.0)]
    with pytest.raises(T.CoverageError):
        T.period_end_changes(obs, [2001], 12, "X")


def test_annual_average_tolerates_one_missing_month():
    obs = monthly({2024: 100.0, 2025: 110.0})
    obs = [(d, None if (d.year, d.month) == (2025, 10) else v) for d, v in obs]  # like the Oct 2025 CPI gap
    assert T.average_changes(obs, [2025], "CUUR0000SEHA") == [10.0]


def test_annual_average_rejects_sparse_years():
    obs = [(date(2024, 1, 1), 1.0), (date(2025, 1, 1), 2.0)]
    with pytest.raises(T.CoverageError):
        T.average_changes(obs, [2025], "X")


def test_level_differences_in_points():
    obs = monthly({2022: 2.0, 2023: 5.0})
    assert T.level_differences(obs, [2023], "GS1") == [3.0]


def test_effective_tax_rate():
    # Illinois 2024 ACS aggregates: $21.262B taxes / $1,185.8B value = 1.793%
    assert T.effective_tax_rate(21.262e9, 1185.8e9) == 1.793


def test_latest_skips_missing():
    obs = [(date(2026, 1, 1), 1.0), (date(2026, 2, 1), None)]
    assert T.latest(obs) == (date(2026, 1, 1), 1.0)
