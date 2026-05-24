#!/usr/bin/env python3
"""Research a candidate URL for the dev blocklist.

Usage:
    python3 scripts/research.py <url>

Validates the URL (YouTube channel / Instagram profile / TikTok profile /
Twitch channel), fetches metadata via the shared curl_cffi resolvers, suggests
a category. Emits a single JSON object to stdout.

Output shape (stable contract — the /ban skill parses this):
{
  "valid": bool,
  "platform": "youtube" | "instagram" | "tiktok" | "twitch" | null,
  "handle": str | null,
  "channelId": str | null,   # YT only
  "userId": str | null,      # IG / TikTok / Twitch (when resolvable)
  "name": str | null,
  "subs": str | null,
  "videoCount": int | null,
  "description": str | null,
  "avatar": str | null,
  "banner": str | null,
  "recent": [ { "title": str, "thumb": str, "views": str } ],
  "channelUrl": str,
  "suggestedCategory": "scam"|"spam"|"ai-slop"|"rage-bait"|"onlyfans" | null,
  "reasoning": str,
  "errors": [ str ]
}
"""

from __future__ import annotations

import json
import re
import sys
from urllib.parse import urlparse

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from lib.instagram import resolve_instagram_user  # noqa: E402
from lib.tiktok import resolve_tiktok_user  # noqa: E402
from lib.twitch import resolve_twitch_channel  # noqa: E402
from lib.yt import resolve_youtube_channel  # noqa: E402

CATEGORIES = ["scam", "spam", "ai-slop", "rage-bait", "onlyfans"]


def emit(obj):
    sys.stdout.write(json.dumps(obj, indent=2) + "\n")


def emit_error(url, msg):
    emit(
        {
            "valid": False,
            "platform": None,
            "handle": None,
            "channelId": None,
            "userId": None,
            "name": None,
            "subs": None,
            "videoCount": None,
            "description": None,
            "avatar": None,
            "banner": None,
            "recent": [],
            "channelUrl": url,
            "suggestedCategory": None,
            "reasoning": "",
            "errors": [msg],
        }
    )


def classify_url(raw_url: str) -> dict:
    try:
        u = urlparse(raw_url)
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": "malformed URL"}
    if not u.scheme or not u.netloc:
        return {"ok": False, "error": "malformed URL"}
    host = re.sub(r"^www\.|^m\.", "", u.hostname.lower()) if u.hostname else ""
    path = u.path

    if host in ("youtube.com", "youtu.be"):
        if host == "youtu.be":
            return {"ok": False, "error": "youtu.be is a video link, not a channel"}
        if path.startswith("/watch") or path.startswith("/shorts/"):
            return {"ok": False, "error": "video URL — paste the channel URL instead"}
        if path.startswith("/@"):
            return {"ok": True, "platform": "youtube", "kind": "handle"}
        if path.startswith("/channel/"):
            return {"ok": True, "platform": "youtube", "kind": "channelId"}
        if path.startswith("/c/"):
            return {"ok": True, "platform": "youtube", "kind": "customUrl"}
        if path.startswith("/user/"):
            return {"ok": True, "platform": "youtube", "kind": "legacyUser"}
        return {"ok": False, "error": "unrecognised YouTube URL form"}

    if host == "instagram.com":
        reserved = {
            "explore", "reels", "reel", "p", "stories", "accounts",
            "direct", "tv", "about", "developer", "legal", "press", "blog",
        }
        m = re.match(r"^/([\w.]+)/?$", path) or re.match(
            r"^/([\w.]+)/(?:tagged|saved|reels)/?$", path
        )
        if not m:
            return {"ok": False, "error": "instagram URL must point to a profile"}
        if m.group(1).lower() in reserved:
            return {"ok": False, "error": f"'{m.group(1)}' is a reserved IG path, not a profile"}
        return {"ok": True, "platform": "instagram", "kind": "username", "username": m.group(1)}

    if host in ("tiktok.com", "vm.tiktok.com"):
        if host == "vm.tiktok.com":
            return {"ok": False, "error": "vm.tiktok.com is a video shortlink, not a profile"}
        m = re.match(r"^/@([\w.-]+)", path)
        if not m:
            return {"ok": False, "error": "tiktok URL must point to a /@handle profile"}
        if re.match(r"^/@[\w.-]+/video/", path):
            return {"ok": False, "error": "tiktok video URL — paste the /@handle profile URL instead"}
        return {"ok": True, "platform": "tiktok", "kind": "username", "username": m.group(1)}

    if host == "twitch.tv":
        m = re.match(r"^/([\w]{1,25})", path)
        if not m:
            return {"ok": False, "error": "twitch URL must point to a channel"}
        # /directory, /p, /downloads etc. are app paths, not channels
        reserved = {"directory", "p", "downloads", "store", "turbo", "subs", "settings"}
        if m.group(1).lower() in reserved:
            return {"ok": False, "error": f"'{m.group(1)}' is a reserved Twitch path, not a channel"}
        return {"ok": True, "platform": "twitch", "kind": "login", "login": m.group(1)}

    return {"ok": False, "error": f"unsupported host: {host}"}


def pick_first(*vals):
    for v in vals:
        if v not in (None, ""):
            return v
    return None


def deep_find(obj, predicate, depth=0):
    if depth > 10 or not isinstance(obj, (dict, list)):
        return None
    if isinstance(obj, dict) and predicate(obj):
        return obj
    if isinstance(obj, list):
        for item in obj:
            found = deep_find(item, predicate, depth + 1)
            if found:
                return found
        return None
    for v in obj.values():
        found = deep_find(v, predicate, depth + 1)
        if found:
            return found
    return None


def deep_find_all(obj, predicate, out=None, depth=0):
    if out is None:
        out = []
    if depth > 12 or not isinstance(obj, (dict, list)):
        return out
    if isinstance(obj, dict) and predicate(obj):
        out.append(obj)
    if isinstance(obj, list):
        for item in obj:
            deep_find_all(item, predicate, out, depth + 1)
        return out
    for v in obj.values():
        deep_find_all(v, predicate, out, depth + 1)
    return out


# --- category heuristics ---------------------------------------------------

_YT_RULES = [
    (
        "scam",
        [
            r"crypto|bitcoin|altcoin", r"\bnft\b", r"pump|10x|100x|moon shot",
            r"guaranteed (returns?|profit)", r"passive income", r"get rich",
            r"forex (signals|trading bot)", r"\bmlm\b|matrix scheme",
        ],
        'Title/description signals: crypto pump, "passive income", "guaranteed returns", or MLM language.',
    ),
    (
        "ai-slop",
        [
            r"\bai-?generated\b", r"\bai brings\b",
            r"\bai (history|facts?|stories|narrat|video|content)",
            r"\b(top|best) \d+\b", r"amazing facts", r"life hacks",
            r"unsolved myster", r"weird (history|facts)", r"did you know\?\?",
            r"generated by ai", r"made with ai",
        ],
        'AI-generated content signals: explicit "AI brings/generated" mention, or templated TTS-explainer pattern (Top N, Amazing Facts, history/mystery loops).',
    ),
    (
        "rage-bait",
        [
            r"react(s|ing) to|tier list|hot takes?", r"\bvs\b.*\bvs\b",
            r"\bvs\b.*\$\d", r"\$\d+,?\d* vs \$\d",
            r"destroyed|exposed|owned|cringe compilation",
            r"you won.?t believe|shocking truth",
            r"last to leave|survive \d+ (days?|hours?)",
            r"\$\d+,000,?000", r"win(s|ning)? \$\d", r"for \$\d+,?\d*,?\d*",
            r"\$1 vs \$", r"trapped (on|in)|stranded (with|in)",
            r"(prank|prick|bully|punish|destroy)(ing|ed)? my (friend|brother|sister|girlfriend|boyfriend|mom|dad)",
            r"age \d+ vs age \d+", r"age \d+-\d+ race",
        ],
        "Rage-bait / engagement-bait pattern: MrBeast-style $-amount challenge titles, \"last to leave\", \"survive N days\", reaction farms.",
    ),
    (
        "onlyfans",
        [r"\bof\b.*link", r"onlyfans|fansly", r"spicy site", r"link in bio.*18\+"],
        "Channel funnels viewers to OnlyFans / paywalled adult content.",
    ),
]


def suggest_youtube_category(name, description, recent):
    haystack = (
        f"{name or ''} {description or ''} " + " ".join(r["title"] for r in recent)
    ).lower()
    for cat, patterns, reason in _YT_RULES:
        if any(re.search(p, haystack) for p in patterns):
            return cat, reason
    return None, "No strong signal — review channel manually before assigning a category."


def _social_category(name, description, recent, errors):
    haystack = (
        f"{name or ''} {description or ''} " + " ".join(r["title"] for r in recent)
    ).lower()
    if re.search(r"onlyfans|fansly|link in bio.*18\+|link in bio.*nsfw|spicy", haystack):
        return "onlyfans", "Bio or captions reference OnlyFans / link-in-bio-NSFW funnel."
    if re.search(r"crypto|forex|guaranteed.*returns|10x|passive income", haystack):
        return "scam", 'Bio or captions mention crypto / forex / "guaranteed returns".'
    if not errors and re.match(r"^[\w\s.]+$", name or "") and len(description or "") < 30:
        return "spam", "Bare bio + plain name suggests spam-bot account (low-confidence — verify manually)."
    return None, "No strong signal from bio + recent captions."


# --- platform research -----------------------------------------------------

def research_youtube(raw_url, info):
    skip_verification = info["kind"] == "channelId"
    result = resolve_youtube_channel(raw_url, skip_verification=skip_verification)
    if result.get("error"):
        return {"errors": [result["error"]]}

    channel_id = result["channelId"]
    handle = result.get("vanityHandle")
    html = result["html"]
    data = result["ytInitialData"]

    name = subs = video_count = avatar = banner = None
    description = None

    header = deep_find(
        data,
        lambda o: isinstance(o, dict)
        and ("c4TabbedHeaderRenderer" in o or "pageHeaderRenderer" in o or "cinematicContainerRenderer" in o),
    )
    if header and "c4TabbedHeaderRenderer" in header:
        h = header["c4TabbedHeaderRenderer"]
        name = pick_first(h.get("title"))
        scr = h.get("subscriberCountText") or {}
        subs = pick_first(scr.get("simpleText"), (scr.get("runs") or [{}])[0].get("text"))
        vcr = h.get("videosCountText") or {}
        video_count = pick_first((vcr.get("runs") or [{}])[0].get("text"))
        av = (h.get("avatar") or {}).get("thumbnails") or []
        avatar = pick_first(av[-1]["url"]) if av else None
        bn = (h.get("banner") or {}).get("thumbnails") or []
        banner = pick_first(bn[-1]["url"]) if bn else None
    elif header and "pageHeaderRenderer" in header:
        h = header["pageHeaderRenderer"]
        name = pick_first(h.get("pageTitle"))
        view = (h.get("content") or {}).get("pageHeaderViewModel") or {}
        try:
            avatar = pick_first(
                view["image"]["decoratedAvatarViewModel"]["avatar"]["avatarViewModel"]["image"]["sources"][0]["url"]
            )
        except (KeyError, IndexError, TypeError):
            pass
        try:
            banner = pick_first(view["banner"]["imageBannerViewModel"]["image"]["sources"][0]["url"])
        except (KeyError, IndexError, TypeError):
            pass
        meta_rows = (((view.get("metadata") or {}).get("contentMetadataViewModel") or {}).get("metadataRows")) or []
        for row in meta_rows:
            for p in (row or {}).get("metadataParts") or []:
                t = (p or {}).get("text", {}).get("content")
                if not isinstance(t, str):
                    continue
                if re.search(r"subscriber", t, re.I):
                    subs = t
                elif re.search(r"video", t, re.I):
                    video_count = t

    desc_match = re.search(r'<meta name="description" content="([^"]+)"', html)
    if desc_match:
        description = desc_match.group(1)

    recent = []
    for block in deep_find_all(data, lambda o: isinstance(o, dict) and "lockupViewModel" in o):
        lvm = block["lockupViewModel"]
        ct = lvm.get("contentType")
        if ct and ct != "LOCKUP_CONTENT_TYPE_VIDEO":
            continue
        md = (lvm.get("metadata") or {}).get("lockupMetadataViewModel") or {}
        title = pick_first((md.get("title") or {}).get("content"))
        if not title:
            continue
        try:
            thumb = pick_first(lvm["contentImage"]["thumbnailViewModel"]["image"]["sources"][0]["url"])
        except (KeyError, IndexError, TypeError):
            thumb = None
        try:
            parts = md["metadata"]["contentMetadataViewModel"]["metadataRows"][0]["metadataParts"]
            views = pick_first((parts[0] or {}).get("text", {}).get("content"))
        except (KeyError, IndexError, TypeError):
            views = None
        recent.append({"title": title, "thumb": thumb, "views": views})
        if len(recent) >= 3:
            break

    if not recent:
        def _legacy(o):
            return isinstance(o, dict) and (
                "gridVideoRenderer" in o or "videoRenderer" in o
                or ("richItemRenderer" in o and (o.get("richItemRenderer") or {}).get("content", {}).get("videoRenderer"))
            )

        for block in deep_find_all(data, _legacy):
            v = (
                block.get("gridVideoRenderer")
                or block.get("videoRenderer")
                or (block.get("richItemRenderer") or {}).get("content", {}).get("videoRenderer")
            )
            if not v:
                continue
            title = pick_first((v.get("title") or {}).get("simpleText"), ((v.get("title") or {}).get("runs") or [{}])[0].get("text"))
            th = (v.get("thumbnail") or {}).get("thumbnails") or []
            thumb = pick_first(th[-1]["url"]) if th else None
            views = pick_first(
                (v.get("viewCountText") or {}).get("simpleText"),
                (v.get("shortViewCountText") or {}).get("simpleText"),
                ((v.get("viewCountText") or {}).get("runs") or [{}])[0].get("text"),
            )
            if title:
                recent.append({"title": title, "thumb": thumb, "views": views})
            if len(recent) >= 3:
                break

    if not avatar:
        og = re.search(r'<meta property="og:image" content="([^"]+)"', html)
        if og:
            avatar = og.group(1)

    if isinstance(video_count, str):
        m = re.search(r"[\d,]+", video_count)
        video_count = int(m.group(0).replace(",", "")) if m else None

    cat, reasoning = suggest_youtube_category(name, description, recent)
    return {
        "valid": True,
        "platform": "youtube",
        "handle": handle,
        "channelId": channel_id,
        "userId": None,
        "name": name,
        "subs": subs if isinstance(subs, str) else None,
        "videoCount": video_count if isinstance(video_count, int) else None,
        "description": description,
        "avatar": avatar,
        "banner": banner,
        "recent": recent,
        "channelUrl": f"https://www.youtube.com/{handle}" if handle else f"https://www.youtube.com/channel/{channel_id}",
        "suggestedCategory": cat,
        "reasoning": reasoning,
        "errors": [],
    }


def research_instagram(raw_url, info):
    username = info["username"]
    r = resolve_instagram_user(username)
    cat, reasoning = _social_category(r["name"], r["description"], r["recent"], r["errors"])
    return {
        "valid": True,
        "platform": "instagram",
        "handle": username,
        "channelId": None,
        "userId": r["userId"],
        "name": r["name"],
        "subs": None,
        "videoCount": None,
        "description": r["description"],
        "avatar": r["avatar"],
        "banner": None,
        "recent": r["recent"],
        "channelUrl": f"https://www.instagram.com/{username}/",
        "suggestedCategory": cat,
        "reasoning": reasoning,
        "errors": r["errors"],
    }


def research_tiktok(raw_url, info):
    username = info["username"]
    r = resolve_tiktok_user(username)
    haystack = f"{r['name'] or ''} {r['description'] or ''}".lower()
    cat, reasoning = None, "No strong signal from bio."
    if re.search(r"onlyfans|fansly|link in bio.*18\+|spicy", haystack):
        cat, reasoning = "onlyfans", "Bio references OnlyFans / link-in-bio-NSFW funnel."
    elif re.search(r"crypto|forex|guaranteed.*returns|10x|passive income", haystack):
        cat, reasoning = "scam", 'Bio mentions crypto / forex / "guaranteed returns".'
    return {
        "valid": True,
        "platform": "tiktok",
        "handle": username,
        "channelId": None,
        "userId": r["userId"],
        "name": r["name"],
        "subs": None,
        "videoCount": None,
        "description": r["description"],
        "avatar": r["avatar"],
        "banner": None,
        "recent": [],
        "channelUrl": f"https://www.tiktok.com/@{username}",
        "suggestedCategory": cat,
        "reasoning": reasoning,
        "errors": r["errors"],
    }


def research_twitch(raw_url, info):
    login = info["login"]
    r = resolve_twitch_channel(login)
    if r.get("error"):
        return {
            "valid": True,
            "platform": "twitch",
            "handle": login.lower(),
            "channelId": None,
            "userId": None,
            "name": None,
            "subs": None,
            "videoCount": None,
            "description": None,
            "avatar": None,
            "banner": None,
            "recent": [],
            "channelUrl": f"https://www.twitch.tv/{login.lower()}",
            "suggestedCategory": None,
            "reasoning": "No strong signal — review channel manually before assigning a category.",
            "errors": [r["error"]],
        }
    return {
        "valid": True,
        "platform": "twitch",
        "handle": r["login"],
        "channelId": None,
        "userId": r["userId"],
        "name": r["displayName"],
        "subs": None,
        "videoCount": None,
        "description": None,
        "avatar": r["avatar"],
        "banner": r["banner"],
        "recent": [],
        "channelUrl": f"https://www.twitch.tv/{r['login']}",
        "suggestedCategory": None,
        "reasoning": "No strong signal — review channel manually before assigning a category.",
        "errors": [],
    }


def main():
    if len(sys.argv) < 2 or not sys.argv[1]:
        emit_error("", "usage: python3 scripts/research.py <url>")
        sys.exit(1)
    url = sys.argv[1]

    info = classify_url(url)
    if not info["ok"]:
        emit_error(url, info["error"])
        sys.exit(0)  # invalid candidate, not a hard failure

    try:
        if info["platform"] == "youtube":
            result = research_youtube(url, info)
        elif info["platform"] == "instagram":
            result = research_instagram(url, info)
        elif info["platform"] == "tiktok":
            result = research_tiktok(url, info)
        else:
            result = research_twitch(url, info)
        if result.get("suggestedCategory") not in CATEGORIES and result.get("suggestedCategory") is not None:
            result["suggestedCategory"] = None
        emit(result)
    except Exception as e:  # noqa: BLE001
        emit_error(url, f"fetch failed: {e}")


if __name__ == "__main__":
    main()
