"""Instagram profile resolution.

Hits ``i.instagram.com/api/v1/users/web_profile_info`` with the public
``X-IG-App-ID`` header (the value Instagram's own web client ships) to extract
the numeric user id plus bio/avatar/recent-media metadata.

Why this works now: the endpoint returns HTTP 400 to plain clients (Node
undici, requests, httpx) because Instagram fingerprints the TLS/JA3 handshake,
not the headers. Routing through curl_cffi ``impersonate="chrome"`` presents a
real-Chrome handshake and the endpoint returns the full 200 JSON. ``X-IG-App-ID``
is an app identifier, not a fingerprint header, so it is safe to set alongside
impersonation.

Falls back to a handle-only result (userId=None) if Instagram still blocks —
add.py writes a rename-vulnerable-but-functional entry in that case.
"""

from __future__ import annotations

from urllib.parse import quote

from .fetcher import get

_API = "https://i.instagram.com/api/v1/users/web_profile_info/?username={}"
# Public web-client app id, shipped in every instagram.com page request.
_IG_APP_ID = "936619743392459"


def resolve_instagram_user(username: str) -> dict:
    """Resolve an IG username to its numeric user id + metadata.

    Returns a dict with keys: userId, name, description, avatar, recent, errors.
    Never raises — transport/parse failures land in ``errors`` and userId stays
    None so callers can still persist a handle-only entry.
    """
    out = {
        "userId": None,
        "name": None,
        "description": None,
        "avatar": None,
        "recent": [],
        "errors": [],
    }
    url = _API.format(quote(username))
    try:
        res = get(url, headers={"X-IG-App-ID": _IG_APP_ID})
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"IG api fetch error: {e}")
        return out

    if not (200 <= res.status_code < 300):
        out["errors"].append(f"IG api → HTTP {res.status_code}")
        return out

    try:
        data = res.json()
    except Exception:  # noqa: BLE001
        out["errors"].append("IG response not JSON (likely blocked)")
        return out

    user = (data or {}).get("data", {}).get("user")
    if not user:
        out["errors"].append("IG profile JSON missing data.user")
        return out

    uid = user.get("id")
    out["userId"] = uid if isinstance(uid, str) and uid.isdigit() else None
    out["name"] = user.get("full_name") or username
    out["description"] = user.get("biography") or None
    out["avatar"] = user.get("profile_pic_url_hd") or user.get("profile_pic_url") or None

    edges = (user.get("edge_owner_to_timeline_media") or {}).get("edges")
    if isinstance(edges, list):
        for edge in edges[:3]:
            node = (edge or {}).get("node")
            if not node:
                continue
            caption = None
            cap_edges = (node.get("edge_media_to_caption") or {}).get("edges")
            if isinstance(cap_edges, list) and cap_edges:
                caption = (cap_edges[0] or {}).get("node", {}).get("text")
            likes = (node.get("edge_liked_by") or {}).get("count")
            out["recent"].append(
                {
                    "title": caption[:80] if caption else "(no caption)",
                    "thumb": node.get("thumbnail_src") or node.get("display_url") or None,
                    "views": f"{likes} likes" if likes else None,
                }
            )
    return out
