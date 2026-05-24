"""Twitch channel resolution.

Resolves a login (lowercase username) to its canonical numeric user id via
Twitch's public GraphQL endpoint. The client-id used here is the same one the
official Twitch web client ships in every page request — no auth, widely
documented in third-party tooling. The endpoint accepts persisted queries by
sha256 hash; the ``ChannelShell`` operation hash is stable and returns id,
login, displayName, avatar, and live-stream metadata in one round-trip.

Twitch logins are 4-25 chars, [a-zA-Z0-9_], case-insensitive (grandfathered
3-char logins like ``xqc`` exist). The URL form is always
``https://www.twitch.tv/<login>`` — no /channel/, /c/, or /@ prefix. Logins can
be changed every 60 days, so the numeric id is the rename-proof identifier we
store.

The GraphQL endpoint is unauthenticated and reliable; it does not fingerprint
hard, but we route through the shared curl_cffi fetcher for one HTTP stack.
"""

from __future__ import annotations

import re

from .fetcher import post_json

_GQL_URL = "https://gql.twitch.tv/gql"
_PUBLIC_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
_CHANNEL_SHELL_HASH = "580ab410bcd0c1ad194224957ae2241e5d252b2c5173d8e0cce9d32d5bb14efe"

_URL_LOGIN = re.compile(r"^https?://(?:www\.|m\.)?twitch\.tv/([\w]{1,25})", re.I)
_LOGIN_RE = re.compile(r"^[a-z0-9_]{3,25}$")
_DIGITS = re.compile(r"^\d+$")


def resolve_twitch_channel(input_str: str) -> dict:
    """Resolve a Twitch login (or URL) to its numeric user id + metadata.

    Returns {"userId", "login", "displayName", "avatar", "banner",
    "viewersCount"} on success, or {"error": str} on failure.
    """
    if not input_str:
        return {"error": "empty input"}
    login = str(input_str).strip()
    url_match = _URL_LOGIN.match(login)
    if url_match:
        login = url_match.group(1)
    login = login.lstrip("@").lower()
    if not _LOGIN_RE.match(login):
        return {"error": f"invalid Twitch login: '{login}' (must be 3-25 chars [a-z0-9_])"}

    payload = [
        {
            "operationName": "ChannelShell",
            "variables": {"login": login},
            "extensions": {
                "persistedQuery": {"version": 1, "sha256Hash": _CHANNEL_SHELL_HASH}
            },
        }
    ]
    try:
        res = post_json(
            _GQL_URL,
            payload,
            headers={"Client-ID": _PUBLIC_CLIENT_ID, "Accept": "*/*"},
        )
        if not (200 <= res.status_code < 300):
            return {"error": f"Twitch gql HTTP {res.status_code}"}
        body = res.json()
    except Exception as e:  # noqa: BLE001
        return {"error": f"Twitch gql fetch error: {e}"}

    data = body[0].get("data") if isinstance(body, list) and body else (body or {}).get("data")
    u = (data or {}).get("userOrError")
    if not isinstance(u, dict):
        return {"error": f"Twitch login '{login}' not found"}
    if u.get("__typename") == "UserDoesNotExist" or not u.get("id"):
        return {"error": f"Twitch login '{login}' does not exist"}
    uid = u.get("id")
    if not (isinstance(uid, str) and _DIGITS.match(uid)):
        return {"error": f"unexpected Twitch user id format: {uid}"}
    resolved_login = u.get("login")
    if isinstance(resolved_login, str) and resolved_login.lower() != login:
        return {"error": f"handle verification failed: input '{login}' resolved to '{resolved_login}'"}

    viewers = (u.get("stream") or {}).get("viewersCount")
    return {
        "userId": uid,
        "login": resolved_login if isinstance(resolved_login, str) else login,
        "displayName": u.get("displayName") if isinstance(u.get("displayName"), str) else None,
        "avatar": u.get("profileImageURL") if isinstance(u.get("profileImageURL"), str) else None,
        "banner": u.get("bannerImageURL") if isinstance(u.get("bannerImageURL"), str) else None,
        "viewersCount": viewers if isinstance(viewers, int) else None,
    }
