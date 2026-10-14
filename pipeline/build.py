"""Build data/data.json from primary sources.

Usage:
    python -m pipeline.build              # fetch everything (needs FRED_API_KEY)
    python -m pipeline.build --offline    # rebuild from the cache in data/raw/
    python -m pipeline.build --relock     # re-resolve FHFA series ids (ignores data/series.lock.json)
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from . import transforms as T
from .sources import Cache, Fred, SourceError, census_state_property_tax, zillow_latest

ROOT = Path(__file__).resolve().parents[1]
log = logging.getLogger("pipeline.build")

# Bounds used to catch transcription or parsing mistakes, not to judge the data.
SANITY = {"hpa": (-50.0, 50.0), "rent": (-5.0, 15.0), "cpi": (-5.0, 15.0), "stocks": (-60.0, 60.0), "bonds": (-30.0, 40.0)}


def load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines) so local runs don't need an extra dependency."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def val(x: Any) -> Any:
    """Assumption entries may be plain values or {value: ..., kind: ...} dicts."""
    return x["value"] if isinstance(x, dict) and "value" in x else x


def check_bounds(name: str, series: list[float], key: str) -> None:
    lo, hi = SANITY[key]
    bad = [v for v in series if not lo <= v <= hi]
    if bad:
        raise T.CoverageError(f"{name}: values outside [{lo}, {hi}]: {bad}")


def read_market_returns(path: Path, years: list[int]) -> tuple[list[float], list[float]]:
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(line for line in f if not line.startswith("#")))
    by_year = {int(r["year"]): (float(r["sp500_total_return"]), float(r["tbond10_total_return"])) for r in rows}
    missing = [y for y in years if y not in by_year]
    if missing:
        raise T.CoverageError(f"{path.name} is missing years {missing}; add them from Damodaran's dataset")
    return [by_year[y][0] for y in years], [by_year[y][1] for y in years]


def build(offline: bool, relock: bool) -> dict[str, Any]:
    A = yaml.safe_load((ROOT / "config/assumptions.yaml").read_text(encoding="utf-8"))
    M = yaml.safe_load((ROOT / "config/metros.yaml").read_text(encoding="utf-8"))["metros"]
    years = list(range(A["window"]["start_year"], A["window"]["end_year"] + 1))
    cache = Cache(ROOT / "data/raw", offline=offline)
    fred = Fred(cache)
    lock_path = ROOT / "data/series.lock.json"
    lock: dict[str, Any] = {} if relock or not lock_path.exists() else json.loads(lock_path.read_text(encoding="utf-8"))

    log.info("window %d-%d (%d years), offline=%s", years[0], years[-1], len(years), offline)

    # --- National series -------------------------------------------------------------
    cpi = T.period_end_changes(fred.observations("CPIAUCNS"), years, 12, "CPIAUCNS")
    rent = T.average_changes(fred.observations("CUUR0000SEHA"), years, "CUUR0000SEHA")
    gs1_obs = fred.observations("GS1")
    m30_obs = fred.observations("MORTGAGE30US")
    stocks, bonds = read_market_returns(ROOT / "data/manual/market_returns.csv", years)
    for name, s, key in (("CPI", cpi, "cpi"), ("rent", rent, "rent"), ("stocks", stocks, "stocks"), ("bonds", bonds, "bonds")):
        check_bounds(name, s, key)
    m30_date, m30_now = T.latest(m30_obs)
    dgs1_date, dgs1_now = T.latest(fred.observations("DGS1"))
    national = {
        "cpi": cpi, "rent": rent, "stocks": stocks, "bonds": bonds,
        "gs1": T.average_levels(gs1_obs, years, "GS1"),
        "dGs1": T.level_differences(gs1_obs, years, "GS1"),
        "m30": T.average_levels(m30_obs, years, "MORTGAGE30US"),
        "dM30": T.level_differences(m30_obs, years, "MORTGAGE30US"),
    }

    # --- Property tax, insurance, caps --------------------------------------------------
    acs_year = int(A["sources"]["acs_year"])
    acs = census_state_property_tax(cache, acs_year)
    tax_rate = {st: T.effective_tax_rate(t, v) for st, (t, v) in acs.items()}
    ins_cfg = A["insurance_pct_of_value"]

    def insurance_for(states: list[str]) -> tuple[float, str]:
        vals, notes = [], set()
        for st in states:
            for grp in ("low_states", "high_states"):
                if st in ins_cfg[grp]["states"]:
                    vals.append(ins_cfg[grp]["value"]); notes.add(ins_cfg[grp]["note"]); break
            else:
                vals.append(ins_cfg["default"])
        return round(sum(vals) / len(vals), 3), "; ".join(sorted(notes))

    # --- Zillow current values ------------------------------------------------------------
    regions = [m["zillow_region"] for m in M]
    zhvi = zillow_latest(cache, A["sources"]["zillow_zhvi_url"], regions, "zhvi")
    zori = zillow_latest(cache, A["sources"]["zillow_zori_url"], regions, "zori")

    # --- Metros ---------------------------------------------------------------------------------
    metros: dict[str, Any] = {}
    for m in M:
        key = m["key"]
        sid = m.get("fhfa_series") or lock.get(key, {}).get("series")
        if not sid:
            sid, title = fred.find_fhfa_metro(m["fhfa_match"])
            log.info("resolved %s -> %s (%s)", key, sid, title)
        info = fred.info(sid)
        lock[key] = {"series": sid, "title": info["title"], "last_updated": info.get("last_updated")}
        hpa = T.period_end_changes(fred.observations(sid), years, 10, sid)  # Q4 observations are dated YYYY-10-01
        check_bounds(f"{key} HPA", hpa, "hpa")

        states = m["states"]
        overrides = A.get("property_tax_overrides", {})
        notes: list[str] = []
        if len(states) == 1 and states[0] in overrides:
            ptax = overrides[states[0]]["value"]; notes.append(overrides[states[0]]["note"])
        else:
            ptax = round(sum(tax_rate[s] for s in states) / len(states), 3)
            notes.append(f"Property tax: {acs_year} ACS effective rate for {'/'.join(states)} (average)" if len(states) > 1
                         else f"Property tax: {acs_year} ACS effective rate for {states[0]}")
        ins, ins_note = insurance_for(states)
        if ins_note:
            notes.append(f"Insurance: {ins_note}")
        caps = A.get("assessment_caps", {})
        cap = caps[states[0]]["value"] if len(states) == 1 and states[0] in caps else 0.0
        if cap:
            notes.append(caps[states[0]]["note"])
        zd, zv = zhvi[m["zillow_region"]]
        rd, rv = zori[m["zillow_region"]]
        metros[key] = {
            "name": m["name"], "states": states, "hpa": hpa,
            "hpa_source": f"FHFA All-Transactions HPI, {info['title']} ({sid}), Q4-to-Q4",
            "price": round(zv), "price_date": zd, "rent": round(rv), "rent_date": rd,
            "prop_tax": ptax, "ins": ins, "assess_cap": cap, "notes": notes,
        }

    lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")

    defaults = {k: val(v) for k, v in A["defaults"].items()}
    return {
        "meta": {
            "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "source": "pipeline",
            "window": [years[0], years[-1]],
            "acs_year": acs_year,
            "notes": "Generated by pipeline/build.py. Do not edit by hand.",
        },
        "years": years,
        "national": national,
        "current": {"mortgage30": m30_now, "mortgage30_date": m30_date.isoformat(),
                    "index1y": dgs1_now, "index1y_date": dgs1_date.isoformat()},
        "assumptions": {"defaults": defaults, "simulation": A["simulation"]},
        "metros": metros,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="use only cached responses in data/raw/")
    ap.add_argument("--relock", action="store_true", help="re-resolve FHFA series ids")
    ap.add_argument("--out", default=str(ROOT / "data/data.json"))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    load_dotenv(ROOT / ".env")
    try:
        data = build(args.offline, args.relock)
    except (SourceError, T.CoverageError, KeyError) as exc:
        log.error("build failed: %s", exc)
        return 1
    Path(args.out).write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    log.info("wrote %s (%d metros)", args.out, len(data["metros"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
