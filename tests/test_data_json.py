"""Schema and sanity checks on the committed data/data.json, so a bad build can't be deployed."""
import json
from pathlib import Path

import pytest

DATA = json.loads((Path(__file__).resolve().parents[1] / "data/data.json").read_text(encoding="utf-8"))
N = len(DATA["years"])


def test_window_matches_years():
    a, b = DATA["meta"]["window"]
    assert DATA["years"] == list(range(a, b + 1))


@pytest.mark.parametrize("key", ["cpi", "rent", "stocks", "bonds", "gs1", "dGs1", "dM30"])
def test_national_series_complete(key):
    s = DATA["national"][key]
    assert len(s) == N and all(isinstance(v, (int, float)) for v in s)


def test_known_values_spot_check():
    y = DATA["years"]
    nat = DATA["national"]
    assert nat["stocks"][y.index(2008)] == -36.55        # Damodaran S&P 500, 2008
    assert nat["cpi"][y.index(2021)] == pytest.approx(7.04, abs=0.05)  # CPI-U Dec/Dec 2021


@pytest.mark.parametrize("key", list(DATA["metros"]))
def test_metro_fields(key):
    m = DATA["metros"][key]
    assert len(m["hpa"]) == N
    assert all(-50 <= v <= 50 for v in m["hpa"])
    assert 30_000 <= m["price"] <= 5_000_000
    assert 300 <= m["rent"] <= 20_000
    assert 0 < m["prop_tax"] < 4
    assert 0 < m["ins"] < 3
    assert m["hpa_source"]


def test_current_rates_plausible():
    c = DATA["current"]
    assert 1 < c["mortgage30"] < 20 and 0 <= c["index1y"] < 20
