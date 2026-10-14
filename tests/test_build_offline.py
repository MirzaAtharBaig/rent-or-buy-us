"""End-to-end pipeline test: run build() offline against synthetic cached responses."""
import json
import shutil
from pathlib import Path

import pytest

from pipeline import build as B

ROOT = Path(__file__).resolve().parents[1]


def _fred(cache: Path, sid: str, obs: list[tuple[str, float]], title: str = "t") -> None:
    d = cache / "fred"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{sid}.json").write_text(json.dumps({"observations": [{"date": a, "value": str(v)} for a, v in obs]}))
    (d / f"{sid}.info.json").write_text(json.dumps({"seriess": [{"id": sid, "title": title, "last_updated": "x"}]}))


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    for sub in ("config", "data/manual"):
        shutil.copytree(ROOT / sub, tmp_path / sub)
    (tmp_path / "config/metros.yaml").write_text(
        "metros:\n  - {key: national, name: US, states: [US], zillow_region: United States, fhfa_series: USSTHPI}\n"
        "  - {key: lincoln, name: 'Lincoln, NE', states: [NE], zillow_region: 'Lincoln, NE', fhfa_series: ATNHPIUS30700Q}\n")
    raw = tmp_path / "data/raw"
    months = [f"{y}-{m:02d}-01" for y in range(2000, 2026) for m in range(1, 13)]
    _fred(raw, "CPIAUCNS", [(d, 100 + i * 0.2) for i, d in enumerate(months)])
    _fred(raw, "CUUR0000SEHA", [(d, 200 + i * 0.5) for i, d in enumerate(months)])
    _fred(raw, "GS1", [(d, 3.0) for d in months])
    _fred(raw, "MORTGAGE30US", [(d, 6.0) for d in months])
    _fred(raw, "DGS1", [("2026-08-04", 4.04)])
    for sid in ("USSTHPI", "ATNHPIUS30700Q"):
        _fred(raw, sid, [(f"{y}-10-01", 100 * 1.04 ** (y - 2000)) for y in range(2000, 2026)], title=sid)
    (raw / "census").mkdir()
    states = list(B.__dict__["census_state_property_tax"].__globals__["STATE_ABBR"].keys())
    rows = [["NAME", "B25090_001E", "B25082_001E", "state"]] + [[s, "1000", "100000", "00"] for s in states]
    (raw / "census/acs1-2024-B25090-B25082.json").write_text(json.dumps(rows))
    (raw / "zillow").mkdir()
    hdr = "RegionID,RegionName,2026-08-31\n"
    (raw / "zillow/zillow-zhvi.csv").write_text(hdr + "1,United States,369678\n2,\"Lincoln, NE\",281140\n")
    (raw / "zillow/zillow-zori.csv").write_text(hdr + "1,United States,1948\n2,\"Lincoln, NE\",1279\n")
    monkeypatch.setattr(B, "ROOT", tmp_path)
    return tmp_path


def test_offline_build(sandbox):
    data = B.build(offline=True, relock=False)
    assert data["years"][0] == 2001 and data["years"][-1] == 2025
    assert data["metros"]["lincoln"]["hpa"] == [4.0] * 25
    assert data["metros"]["lincoln"]["prop_tax"] == 1.0          # 1000/100000 from the fixture
    assert data["metros"]["lincoln"]["ins"] == 0.80              # NE is in the high-insurance group
    assert data["national"]["dM30"] == [0.0] * 25
    assert data["current"]["index1y"] == 4.04
    assert (sandbox / "data/series.lock.json").exists()
