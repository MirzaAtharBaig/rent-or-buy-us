import json

import requests
import pytest

from pipeline import sources


def _response(body: bytes) -> requests.Response:
    response = requests.Response()
    response.status_code = 200
    response._content = body
    return response


def test_census_retries_invalid_json_response(tmp_path, monkeypatch):
    monkeypatch.setenv("CENSUS_API_KEY", "test-key")
    header = ["NAME", "B25090_001E", "B25082_001E", "state"]
    state_rows = [[name, "1000", "100000", "00"] for name in sources.STATE_ABBR]
    responses = iter([
        _response(b""),
        _response(json.dumps([header, *state_rows]).encode()),
        _response(json.dumps([header, ["United States", "1000", "100000", "1"]]).encode()),
    ])
    monkeypatch.setattr(sources, "_get", lambda *args, **kwargs: next(responses))
    monkeypatch.setattr(sources.time, "sleep", lambda _: None)

    result = sources.census_state_property_tax(sources.Cache(tmp_path), 2024)

    assert result["NE"] == (1000.0, 100000.0)


def test_census_requires_api_key(tmp_path, monkeypatch):
    monkeypatch.delenv("CENSUS_API_KEY", raising=False)

    with pytest.raises(sources.SourceError, match="CENSUS_API_KEY is required"):
        sources.census_state_property_tax(sources.Cache(tmp_path), 2024)
