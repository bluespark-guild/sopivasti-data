"""YouTube channel resolution.

Resolves @handle (or any channel URL) to its canonical UCxxxxxxxxxxxxxxxxxxxxxx
by parsing ytInitialData.metadata.channelMetadataRenderer.externalId — the
page-subject ID YouTube embeds for crawlers/RSS.

Why not regex-match ``"channelId":"UC..."`` directly?
That string appears dozens of times per page (sidebar suggestions, related
creators, comment authors, recent collabs). The first hit is rarely the page
subject. ytInitialData.metadata is canonical and singular.

Verification: cross-checks the resolved channel's vanityChannelUrl matches the
input handle. Mismatch -> reject with explicit error so silent misresolution
becomes a loud failure.

Verification limits: only catches *technical* misresolution (page returned a
channel with a different handle than input). It cannot detect handle
*squatting* — when YouTube's handle @x is legitimately registered to a
different person than the one the user wanted. The caller must visually verify
name + sub-count before adding to the blocklist.

YouTube does not fingerprint-block plain clients, but we still route through the
shared curl_cffi fetcher for one coherent HTTP stack across the toolchain.
"""

from __future__ import annotations

import json
import re

from .fetcher import get

_YT_INITIAL_DATA = re.compile(r"var ytInitialData = (\{.+?\});</script>", re.S)
_VANITY_HANDLE = re.compile(r"/(@[\w.-]+)$")
_CHANNEL_ID = re.compile(r"^UC[\w-]{22}$")
_URL_HANDLE = re.compile(r"/(@[\w.-]+)(/|$)")


def fetch_youtube_html(url: str) -> dict:
    """GET a YouTube URL. Returns {"html": str, "finalUrl": str}.

    Raises RuntimeError on non-2xx so callers surface it as an error string.
    """
    res = get(url)
    if not (200 <= res.status_code < 300):
        raise RuntimeError(f"HTTP {res.status_code}")
    return {"html": res.text, "finalUrl": res.url}


def extract_yt_initial_data(html: str):
    m = _YT_INITIAL_DATA.search(html)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except (ValueError, json.JSONDecodeError):
        return None


def get_channel_metadata(yt_initial_data):
    meta = (yt_initial_data or {}).get("metadata", {}).get("channelMetadataRenderer")
    if not meta:
        return None
    return {
        "channelId": meta.get("externalId"),
        "vanityChannelUrl": meta.get("vanityChannelUrl"),
        "title": meta.get("title"),
        "description": meta.get("description"),
        "keywords": meta.get("keywords"),
    }


def _extract_handle_from_vanity_url(vanity_url):
    if not vanity_url:
        return None
    m = _VANITY_HANDLE.search(vanity_url)
    return m.group(1) if m else None


def _normalise_handle(value):
    if not value:
        return None
    trimmed = str(value).strip()
    return trimmed if trimmed.startswith("@") else f"@{trimmed}"


def resolve_youtube_channel(input_str: str, *, skip_verification: bool = False) -> dict:
    """Resolve a handle (or channel URL) to its canonical channelId.

    Returns {"channelId", "vanityHandle", "title", "html", "ytInitialData"} on
    success, or {"error": str} on failure.

    skip_verification — set True when the input is a channelId (no handle to
    verify against) or when the caller intentionally wants the resolved page
    regardless of handle drift.
    """
    expected_handle = None
    if re.match(r"^https?://", input_str):
        url = input_str.rstrip("/")
        m = _URL_HANDLE.search(url)
        if m:
            expected_handle = m.group(1)
    elif re.match(r"^UC[\w-]{22}$", input_str):
        url = f"https://www.youtube.com/channel/{input_str}"
    else:
        handle = _normalise_handle(input_str)
        if not handle:
            return {"error": "empty input"}
        expected_handle = handle
        # quote @handle path segment
        from urllib.parse import quote

        url = f"https://www.youtube.com/{quote(handle)}"

    # /videos has a cleaner layout than /featured (less sidebar cross-promo)
    # and reliably emits ytInitialData.metadata.channelMetadataRenderer for the
    # page subject.
    target_url = url if re.search(r"/videos$", url) else f"{url}/videos"

    try:
        html = fetch_youtube_html(target_url)["html"]
    except Exception as e:  # noqa: BLE001 — surface any transport failure as error
        return {"error": f"fetch failed: {e}"}

    data = extract_yt_initial_data(html)
    if not data:
        return {"error": "ytInitialData missing — page layout changed?"}

    meta = get_channel_metadata(data)
    if not meta or not meta.get("channelId"):
        return {"error": "channelMetadataRenderer.externalId missing"}
    if not _CHANNEL_ID.match(meta["channelId"]):
        return {"error": f"unexpected externalId format: {meta['channelId']}"}

    vanity_handle = _extract_handle_from_vanity_url(meta.get("vanityChannelUrl"))

    if not skip_verification and expected_handle and vanity_handle:
        if expected_handle.lower() != vanity_handle.lower():
            return {
                "error": (
                    f"handle verification failed: input {expected_handle} resolved to "
                    f"{vanity_handle} (externalId {meta['channelId']}). YouTube "
                    "redirected to a different channel."
                ),
                "suspectedChannelId": meta["channelId"],
                "actualHandle": vanity_handle,
            }

    return {
        "channelId": meta["channelId"],
        "vanityHandle": vanity_handle,
        "title": meta.get("title"),
        "html": html,  # expose so callers can parse further without re-fetching
        "ytInitialData": data,
    }
