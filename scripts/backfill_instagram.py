#!/usr/bin/env python3
"""Backfill numeric userId for Instagram entries added before ID resolution.

Re-resolves every handle-only IG entry via the shared curl_cffi resolver and
writes the userId in place (order preserved). Rate-limited to stay under IG's
anti-bot radar. Misses are left handle-only and reported at the end.

Usage:
    python3 scripts/backfill_instagram.py            # live run
    python3 scripts/backfill_instagram.py --dry-run  # resolve + report, no write
"""

from __future__ import annotations

import json
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.instagram import resolve_instagram_user  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
BLOCKLIST_PATH = REPO_ROOT / "blocklist" / "v1.json"


def main():
    dry_run = "--dry-run" in sys.argv[1:]

    blocklist = json.loads(BLOCKLIST_PATH.read_text())
    ig = blocklist.get("instagram", [])

    # Normalize plain-string entries to dicts so we can attach userId.
    todo = []
    for i, e in enumerate(ig):
        if isinstance(e, str):
            ig[i] = {"handle": e}
            e = ig[i]
        if not e.get("userId"):
            todo.append(e)

    print(f"{len(todo)} handle-only IG entries to resolve "
          f"(of {len(ig)} total){' [DRY RUN]' if dry_run else ''}\n")

    resolved, misses = 0, []
    for n, entry in enumerate(todo, 1):
        handle = entry["handle"]
        r = resolve_instagram_user(handle)
        uid = r["userId"]
        if uid:
            if not dry_run:
                entry["userId"] = uid
            resolved += 1
            print(f"  [{n}/{len(todo)}] ✓ {handle} → {uid}")
        else:
            err = r["errors"][0] if r["errors"] else "no userId in response"
            misses.append((handle, err))
            print(f"  [{n}/{len(todo)}] ✗ {handle} — {err}")
        # Jittered delay to avoid a uniform request cadence.
        if n < len(todo):
            time.sleep(random.uniform(1.5, 3.5))

    if not dry_run:
        now = datetime.now(timezone.utc)
        blocklist["updatedAt"] = (
            now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
        )
        BLOCKLIST_PATH.write_text(json.dumps(blocklist, indent=2) + "\n")

    print(f"\nResolved {resolved}/{len(todo)}. Misses: {len(misses)}")
    for handle, err in misses:
        print(f"  · {handle} — {err}")
    if not dry_run:
        print("\nWritten. Review diff, then commit + push + purge.")


if __name__ == "__main__":
    main()
