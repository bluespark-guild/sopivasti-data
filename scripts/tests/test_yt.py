"""Smoke test for resolve_youtube_channel.

Cases include channels where the previous regex-based extractor failed
(PBD/Valuetainment swap, MyronGainesX/FreshandFit swap). These are LIVE fetches
against youtube.com — marked ``network`` so CI can skip when rate-limited:

    pytest scripts/tests/test_yt.py            # run everything
    pytest -m "not network" scripts/tests      # skip live fetches
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.yt import resolve_youtube_channel  # noqa: E402

CASES = [
    # Previously swapped pairs
    ("@PBDPodcast", "UCGX7nGXpz-CmO_Arg-cgJ7A"),
    ("@valuetainment", "UCIHdDJ0tjn_3j-FS7s_X1kQ"),
    ("@MyronGainesX", "UC4HttNRwamCTHVu_H6i-uvw"),
    ("@FreshandFitClips", "UCWvOWoP13fXw1DlfKVRnZgw"),
    # Sanity: well-known channels
    ("@MrBeast", "UCX6OQ3DkcsbYNE6H8uQQuVA"),
    ("@pokimane", "UChXKjLEzAB1K7EZQey7Fm1Q"),
    ("@PirateSoftware", "UCMnULQ6F6kLDAHxofDWIbrw"),
]


@pytest.mark.network
@pytest.mark.parametrize("handle,expected", CASES)
def test_resolve_channel_id(handle, expected):
    result = resolve_youtube_channel(handle)
    assert not result.get("error"), f"{handle}: {result.get('error')}"
    assert result["channelId"] == expected, (
        f"{handle}: got {result['channelId']}, expected {expected}"
    )
