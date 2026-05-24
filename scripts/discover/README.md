# Komma Discover (sopivasti-data side)

Discovery itself moved to **HQ** (`projects/hq/scripts/discover/`). HQ scrapes
[Playboard.co](https://playboard.co) on a daily cron, enriches each candidate,
and writes pending channels to its KV-backed review queue. Curator approvals
land in an `apply:` queue.

What lives here:

- **`scripts/komma-apply.mjs`** + **`.github/workflows/komma-apply.yml`** —
  every 15 min, drains HQ's apply queue, runs `scripts/add.py` per item,
  commits the change, pushes, and ACKs HQ. The discovery side never touches
  this repo's git tree directly. (Node orchestrator; delegates fetching to the
  Python adder.)
- **`scripts/research.py`** — channel enrichment helper (avatar, banner,
  recent videos, category suggestion). HQ's discover script invokes it via
  the `SOPIVASTI_DATA_PATH` env var when running headlessly.
- **`scripts/add.py`** — single-channel adder. Used by both `komma-apply.mjs`
  (HQ-driven) and the `/ban` skill (manual one-offs). Resolves stable IDs via
  curl_cffi (Chrome impersonation) — see `scripts/requirements.txt`.

The previous Social Blade-based local HTML curator (Phase 1) was removed once
HQ Phase 2 went live. The `output/` directory + `build.mjs` no longer exist.

For the full pipeline diagram and tokens, see
`projects/hq/scripts/discover/README.md`.
