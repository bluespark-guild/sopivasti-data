#!/usr/bin/env python3
"""Add a handle to blocklist/v1.json with auto-resolved stable ID.

Usage:
    python3 scripts/add.py youtube @handle
    python3 scripts/add.py instagram username
    python3 scripts/add.py tiktok @handle
    python3 scripts/add.py twitch login

Flat schema — no categories. Every entry the curator pushes is "banned, full
stop." Users see one master toggle, on or off.

ID resolution goes through the shared curl_cffi resolvers (lib/), so the
TLS/JA3 fingerprint matches Chrome:
  - YouTube: scrapes the channel page for UCxxxxxxxxxxxxxxxxxxxxxx (immutable).
  - Instagram: i.instagram.com web_profile_info -> numeric user id (curl_cffi
    impersonation defeats the HTTP 400 that blocks plain clients).
  - TikTok: best-effort rehydration-blob parse; falls back to handle-only when
    the JS anti-bot challenge hides the blob.
  - Twitch: gql.twitch.tv ChannelShell -> numeric user id.

Any resolution miss persists a handle-only entry (rename-vulnerable but
functional). Bumps updatedAt and writes the file. Commit + push is run
separately by the /ban workflow:
    git add blocklist/v1.json && git commit -m "..." && git push
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.instagram import resolve_instagram_user  # noqa: E402
from lib.tiktok import resolve_tiktok_user  # noqa: E402
from lib.twitch import resolve_twitch_channel  # noqa: E402
from lib.yt import resolve_youtube_channel  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
BLOCKLIST_PATH = REPO_ROOT / "blocklist" / "v1.json"

PLATFORMS = ("youtube", "instagram", "tiktok", "twitch")


def usage(msg=None):
    if msg:
        print(f"Error: {msg}\n", file=sys.stderr)
    print("Usage:", file=sys.stderr)
    print("  python3 scripts/add.py youtube @handle", file=sys.stderr)
    print("  python3 scripts/add.py instagram username", file=sys.stderr)
    print("  python3 scripts/add.py tiktok @handle", file=sys.stderr)
    print("  python3 scripts/add.py twitch login", file=sys.stderr)
    sys.exit(1)


def entry_handle(entry):
    return entry if isinstance(entry, str) else entry.get("handle")


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        usage("missing arguments")
    platform, raw_handle = args[0], args[1]
    if platform not in PLATFORMS:
        usage(f"platform must be one of {PLATFORMS}, got '{platform}'")

    blocklist = json.loads(BLOCKLIST_PATH.read_text())
    for key in PLATFORMS:
        if not isinstance(blocklist.get(key), list):
            blocklist[key] = []

    if platform == "youtube":
        handle = raw_handle if raw_handle.startswith("@") else f"@{raw_handle}"
        if any(entry_handle(e).lower() == handle.lower() for e in blocklist["youtube"]):
            print(f"  · {handle} already in youtube — skipping")
            return
        print(f"Resolving channel ID for {handle}…")
        result = resolve_youtube_channel(handle)
        if result.get("error"):
            print(f"  ⚠ {result['error']}")
            channel_id = None
        else:
            channel_id = result.get("channelId")
        entry = {"handle": handle, "channelId": channel_id} if channel_id else {"handle": handle}
        blocklist["youtube"].append(entry)
        print(
            f"  ✓ added {handle} → {channel_id}"
            if channel_id
            else f"  ✓ added {handle} (handle only — ID lookup failed)"
        )

    elif platform == "instagram":
        username = raw_handle.lstrip("@")
        if any(entry_handle(e).lower() == username.lower() for e in blocklist["instagram"]):
            print(f"  · {username} already in instagram — skipping")
            return
        print(f"Resolving user ID for {username}…")
        r = resolve_instagram_user(username)
        for err in r["errors"]:
            print(f"  ⚠ {err}")
        user_id = r["userId"]
        entry = {"handle": username, "userId": user_id} if user_id else {"handle": username}
        blocklist["instagram"].append(entry)
        print(
            f"  ✓ added {username} → {user_id}"
            if user_id
            else f"  ✓ added {username} (handle only — ID lookup failed)"
        )

    elif platform == "tiktok":
        username = raw_handle.lstrip("@")
        if any(entry_handle(e).lower() == username.lower() for e in blocklist["tiktok"]):
            print(f"  · @{username} already in tiktok — skipping")
            return
        print(f"Resolving user ID for @{username}…")
        r = resolve_tiktok_user(username)
        for err in r["errors"]:
            print(f"  ⚠ {err}")
        user_id = r["userId"]
        entry = {"handle": username, "userId": user_id} if user_id else {"handle": username}
        blocklist["tiktok"].append(entry)
        print(
            f"  ✓ added @{username} → {user_id}"
            if user_id
            else f"  ✓ added @{username} (handle only — ID lookup failed)"
        )

    else:  # twitch
        login = raw_handle.lstrip("@").lower()
        if any(entry_handle(e).lower() == login for e in blocklist["twitch"]):
            print(f"  · {login} already in twitch — skipping")
            return
        print(f"Resolving user ID for {login}…")
        r = resolve_twitch_channel(login)
        if r.get("error"):
            print(f"  ⚠ {r['error']}")
            entry = {"handle": login}
        else:
            entry = {"handle": r["login"].lower(), "userId": r["userId"]}
        blocklist["twitch"].append(entry)
        print(
            f"  ✓ added {entry['handle']} → {entry['userId']}"
            if entry.get("userId")
            else f"  ✓ added {login} (handle only — ID lookup failed)"
        )

    # ISO 8601 with millisecond precision + Z, matching JS Date.toISOString()
    now = datetime.now(timezone.utc)
    blocklist["updatedAt"] = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    BLOCKLIST_PATH.write_text(json.dumps(blocklist, indent=2) + "\n")

    print("\nStaged. Commit + push:")
    print("  git add blocklist/v1.json")
    print(f'  git commit -m "blocklist: add {raw_handle} (<reason>)"')
    print("  git push")


if __name__ == "__main__":
    main()
