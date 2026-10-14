"""Network clients for FRED, the Census API and Zillow Research, with an on-disk cache.

Every response is cached under data/raw/ so a build can be repeated offline (`--offline`)
and so the exact inputs behind a published data.json are committed alongside it.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import requests

log = logging.getLogger(__name__)

FRED_BASE = "https://api.stlouisfed.org/fred"
CENSUS_BASE = "https://api.census.gov/data"
TIMEOUT_S = 30
RETRIES = 4


class SourceError(RuntimeError):
    """A remote source failed or returned something unexpected."""


def _get(url: str, params: dict[str, Any] | None = None) -> requests.Response:
    """GET with bounded retries and exponential backoff on network errors and 429/5xx."""
    delay = 2.0
    for attempt in range(1, RETRIES + 1):
        try:
            r = requests.get(url, params=params, timeout=TIMEOUT_S)
            if r.status_code in (429, 500, 502, 503, 504):
                raise SourceError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r
        except (requests.RequestException, SourceError) as exc:
            if attempt == RETRIES:
                raise SourceError(f"GET {url} failed after {RETRIES} attempts: {exc}") from exc
            log.warning("GET %s failed (%s); retry %d/%d in %.0fs", url, exc, attempt, RETRIES, delay)
            time.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


@dataclass
class Cache:
    root: Path
    offline: bool = False

    def path(self, *parts: str) -> Path:
        p = self.root.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def read(self, *parts: str) -> str | None:
        p = self.root.joinpath(*parts)
        return p.read_text(encoding="utf-8") if p.exists() else None

    def write(self, text: str, *parts: str) -> None:
        self.path(*parts).write_text(text, encoding="utf-8")


class Fred:
    """Minimal FRED client. Needs FRED_API_KEY (free: https://fred.stlouisfed.org/docs/api/api_key.html)."""

    def __init__(self, cache: Cache, api_key: str | None = None) -> None:
        self.cache = cache
        self.key = api_key or os.environ.get("FRED_API_KEY", "")
        if not self.key and not cache.offline:
            raise SourceError("FRED_API_KEY is not set. Put it in .env or export it before running the build.")

    def _call(self, endpoint: str, cache_name: str, **params: Any) -> dict[str, Any]:
        cached = self.cache.read("fred", cache_name)
        if self.cache.offline:
            if cached is None:
                raise SourceError(f"--offline but no cached FRED response for {cache_name}")
            return json.loads(cached)
        r = _get(f"{FRED_BASE}/{endpoint}", {**params, "api_key": self.key, "file_type": "json"})
        data = r.json()
        if "error_message" in data:
            raise SourceError(f"FRED {endpoint} {params}: {data['error_message']}")
        self.cache.write(json.dumps(data, indent=1), "fred", cache_name)
        return data

    def info(self, series_id: str) -> dict[str, Any]:
        data = self._call("series", f"{series_id}.info.json", series_id=series_id)
        if not data.get("seriess"):
            raise SourceError(f"FRED series {series_id} not found")
        return data["seriess"][0]

    def observations(self, series_id: str) -> list[tuple[date, float | None]]:
        data = self._call("series/observations", f"{series_id}.json", series_id=series_id)
        out: list[tuple[date, float | None]] = []
        for o in data["observations"]:
            v = o["value"]
            out.append((date.fromisoformat(o["date"]), None if v == "." else float(v)))
        if not out:
            raise SourceError(f"FRED series {series_id} returned no observations")
        return out

    def find_fhfa_metro(self, match: list[str]) -> tuple[str, str]:
        """Find the quarterly FHFA All-Transactions HPI whose title contains every `match` token."""
        text = "All-Transactions House Price Index " + " ".join(match)
        slug = re.sub(r"[^a-z0-9]+", "-", text.lower())
        data = self._call("series/search", f"search-{slug}.json", search_text=text, limit=200)
        hits = [
            s for s in data.get("seriess", [])
            if re.fullmatch(r"ATNHPIUS\d{5}Q", s["id"])
            and all(tok.lower() in s["title"].lower() for tok in match)
        ]
        if len(hits) != 1:
            found = ", ".join(f"{s['id']} ({s['title']})" for s in hits) or "none"
            raise SourceError(
                f"FHFA search for {match} matched {len(hits)} series: {found}. "
                "Set fhfa_series explicitly in config/metros.yaml."
            )
        return hits[0]["id"], hits[0]["title"]


def census_state_property_tax(cache: Cache, acs_year: int) -> dict[str, tuple[float, float]]:
    """State aggregates from ACS 1-year: B25090_001E (real estate taxes paid) and B25082_001E (home value).
    Returns {state_abbrev: (taxes, value)} plus 'US'."""
    name = f"acs1-{acs_year}-B25090-B25082.json"
    cached = cache.read("census", name)
    if cached is None:
        if cache.offline:
            raise SourceError(f"--offline but no cached Census response {name}")
        rows: list[list[str]] = []
        for geo in ("state:*", "us:1"):
            r = _get(f"{CENSUS_BASE}/{acs_year}/acs/acs1", {"get": "NAME,B25090_001E,B25082_001E", "for": geo})
            part = r.json()
            rows.extend(part[1:] if rows else part)
        cached = json.dumps(rows)
        cache.write(cached, "census", name)
    rows = json.loads(cached)
    header, body = rows[0], rows[1:]
    i_name, i_tax, i_val = header.index("NAME"), header.index("B25090_001E"), header.index("B25082_001E")
    out: dict[str, tuple[float, float]] = {}
    for row in body:
        abbr = STATE_ABBR.get(row[i_name])
        if abbr:
            out[abbr] = (float(row[i_tax]), float(row[i_val]))
    if len(out) < 51:
        raise SourceError(f"Census response covered only {len(out)} of 52 geographies")
    return out


def zillow_latest(cache: Cache, url: str, regions: list[str], label: str) -> dict[str, tuple[str, float]]:
    """Latest value per RegionName from a Zillow Research metro CSV. Saves only the needed rows."""
    name = f"zillow-{label}.csv"
    cached = cache.read("zillow", name)
    if cached is None:
        if cache.offline:
            raise SourceError(f"--offline but no cached Zillow extract {name}")
        text = _get(url).text
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None or "RegionName" not in reader.fieldnames:
            raise SourceError(f"Zillow CSV at {url} has no RegionName column; has the file layout changed?")
        keep = [row for row in reader if row["RegionName"] in set(regions)]
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=reader.fieldnames)
        w.writeheader()
        w.writerows(keep)
        cached = buf.getvalue()
        cache.write(cached, "zillow", name)
    reader = csv.DictReader(io.StringIO(cached))
    date_cols = [c for c in (reader.fieldnames or []) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", c)]
    out: dict[str, tuple[str, float]] = {}
    for row in reader:
        for c in reversed(date_cols):
            if row[c]:
                out[row["RegionName"]] = (c, float(row[c]))
                break
    missing = sorted(set(regions) - out.keys())
    if missing:
        raise SourceError(f"Zillow {label}: no data for regions {missing}; check zillow_region names")
    return out


STATE_ABBR = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO",
    "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
    "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "United States": "US",
}
