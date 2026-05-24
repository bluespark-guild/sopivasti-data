"""TikTok profile resolution (best-effort).

Hits the public profile HTML and parses the
``__UNIVERSAL_DATA_FOR_REHYDRATION__`` blob for the numeric user id + metadata.

Reality check: TikTok runs a JS anti-bot challenge. curl_cffi ``impersonate``
fixes the TLS handshake but TikTok still serves a ~1.4KB challenge shell with
NO rehydration blob to non-browser clients — so userId resolution usually
fails here and we fall back to handle-only (functional, rename-vulnerable).

To actually resolve TikTok userIds, swap the fetch for a real browser
(camoufox / agent-browser) that executes the challenge JS. The parse logic
below already handles a real HTML response, so wiring camoufox in is a
fetch-layer swap only — see ``_fetch_profile_html``. Not wired by default
(adds a Firefox download + slower runs); the curator decided handle-only is
acceptable for TikTok for now.
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote

from .fetcher import get

_REHYDRATION = re.compile(
    r'<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)</script>'
)
_OG_IMAGE = re.compile(r'<meta property="og:image" content="([^"]+)"')
_OG_TITLE = re.compile(r'<meta property="og:title" content="([^"]+)"')
_META_DESC = re.compile(r'<meta name="description" content="([^"]+)"')


def _fetch_profile_html(username: str):
    """Fetch profile HTML. Swap this body for camoufox to beat the JS challenge."""
    url = f"https://www.tiktok.com/@{quote(username)}"
    res = get(url)
    if not (200 <= res.status_code < 300):
        raise RuntimeError(f"TikTok HTTP {res.status_code}")
    return res.text


def _find_tiktok_id(obj, expected_unique_id: str, depth: int = 0):
    if depth > 10 or not isinstance(obj, dict):
        return None
    user = obj.get("user")
    if (
        isinstance(user, dict)
        and isinstance(user.get("id"), str)
        and isinstance(user.get("uniqueId"), str)
        and user["uniqueId"].lower() == expected_unique_id
    ):
        return user["id"]
    for v in obj.values():
        if isinstance(v, dict):
            found = _find_tiktok_id(v, expected_unique_id, depth + 1)
            if found:
                return found
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    found = _find_tiktok_id(item, expected_unique_id, depth + 1)
                    if found:
                        return found
    return None


def resolve_tiktok_user(username: str) -> dict:
    """Resolve a TikTok @handle to its numeric user id + metadata (best-effort).

    Returns a dict with keys: userId, name, description, avatar, errors.
    Never raises — failures land in ``errors`` with userId=None so callers can
    still persist a handle-only entry.
    """
    out = {"userId": None, "name": None, "description": None, "avatar": None, "errors": []}
    try:
        html = _fetch_profile_html(username)
    except Exception as e:  # noqa: BLE001
        out["errors"].append(str(e))
        return out

    m = _REHYDRATION.search(html)
    if m:
        try:
            data = json.loads(m.group(1))
            uid = _find_tiktok_id(data, username.lower())
            if uid:
                out["userId"] = uid
            # pull metadata from the same blob if present
            user_block = _find_user_block(data, username.lower())
            if user_block:
                out["name"] = user_block.get("nickname") or user_block.get("uniqueId")
                out["description"] = user_block.get("signature") or None
                out["avatar"] = (
                    user_block.get("avatarLarger")
                    or user_block.get("avatarMedium")
                    or user_block.get("avatarThumb")
                )
        except Exception as e:  # noqa: BLE001
            out["errors"].append(f"TikTok state parse: {e}")
    else:
        out["errors"].append("tiktok rehydration blob missing (anti-bot interstitial?)")

    # og:* / meta fallbacks for display metadata
    if not out["avatar"]:
        og = _OG_IMAGE.search(html)
        if og:
            out["avatar"] = og.group(1)
    if not out["name"]:
        og = _OG_TITLE.search(html)
        if og:
            out["name"] = og.group(1)
    if not out["description"]:
        md = _META_DESC.search(html)
        if md:
            out["description"] = md.group(1)
    return out


def _find_user_block(obj, expected_unique_id: str, depth: int = 0):
    if depth > 10 or not isinstance(obj, dict):
        return None
    user = obj.get("user")
    if (
        isinstance(user, dict)
        and isinstance(user.get("uniqueId"), str)
        and user["uniqueId"].lower() == expected_unique_id
    ):
        return user
    for v in obj.values():
        if isinstance(v, dict):
            found = _find_user_block(v, expected_unique_id, depth + 1)
            if found:
                return found
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    found = _find_user_block(item, expected_unique_id, depth + 1)
                    if found:
                        return found
    return None
