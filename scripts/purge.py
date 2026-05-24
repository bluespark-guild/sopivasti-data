#!/usr/bin/env python3
"""Purge jsdelivr edge cache for blocklist/v1.json.

jsdelivr caches @master branch URLs for 12h at the edge. After pushing a
blocklist change to GitHub, call this to force the edge to re-fetch on next
request — combined with the 1h client TTL in Komma, curated additions
propagate within ~1h end-to-end instead of ~13h.

Usage:
    python3 scripts/purge.py

The purge endpoint is unauthenticated, idempotent, and returns a small JSON
body. Any 2xx is success; failures are warnings only — the cache still expires
naturally within 12h. Routed through curl_cffi for one HTTP stack across the
toolchain (the endpoint does not fingerprint, but consistency beats a stray
runtime).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.fetcher import get  # noqa: E402

PURGE_URL = (
    "https://purge.jsdelivr.net/gh/bluespark-guild/sopivasti-data@master/blocklist/v1.json"
)


def main():
    try:
        res = get(PURGE_URL)
        if not (200 <= res.status_code < 300):
            print(f"  ⚠ jsdelivr purge → HTTP {res.status_code} (cache will expire naturally within 12h)")
            return
        print("  ✓ jsdelivr edge purged")
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ jsdelivr purge error: {e}")


if __name__ == "__main__":
    main()
