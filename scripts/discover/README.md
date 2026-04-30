# Komma Discover

Phase 1 batch curator. Pulls top channels per country from Social Blade, dedupes against the existing blocklist, enriches each via `scripts/research.mjs`, and renders a single HTML review page with in-card undo + per-card category override.

## Run

```bash
# from repo root
node scripts/discover/build.mjs us --limit 100
open scripts/discover/output/us-$(date +%F).html
```

Args:

- `<country>` — ISO 3166-1 alpha-2 (e.g. `us`, `gb`, `in`, `br`)
- `--limit N` — cap rows (default 100)
- `--concurrency N` — parallel research.mjs calls (default 3; bump cautiously, YouTube rate-limits)

## How it works

1. `socialblade.py` — `curl_cffi` Chrome impersonation defeats Cloudflare; parses `<tr id="UC…">` rows for channel ID + handle + name + subs.
2. `build.mjs` — loads `blocklist/v1.json`, filters out already-blocked channels by channel ID and handle.
3. Enrichment runs `node scripts/research.mjs https://www.youtube.com/channel/<id>` per remaining row in a small worker pool. Output JSON includes avatar, banner, recent 5 videos, suggested category.
4. Renders one self-contained HTML file. Each card has avatar, sub count, suggested category, recent thumbnails, recent titles, category dropdown, and Block/Skip buttons.

## Review UX

- **Block** flips the card to a confirmation state (dimmed body, ✓ badge, countdown bar, big Undo). Auto-removes after 8s.
- **Skip** same flow but greyscale + "re-surfaces in 6 months" copy.
- **Undo** anytime in the 8-second window reverts the decision.
- **Keyboard**: hover a card, press `B` to block, `S` to skip, `1`-`5` to select category.
- All decisions persist to `localStorage` keyed by `komma-discover-<country>-<date>`. Refresh-safe.
- **Export decisions (JSON)** — full per-channel record.
- **Export add.mjs commands** — shell script of `node scripts/add.mjs youtube <category> @<handle>` lines for each Block. Run sequentially to apply.

## Phase 2 (later)

Port to HQ Cloudflare Worker + KV + daily cron. Replace the localStorage state with KV-backed queue. Replace the Export step with a direct GitHub commit via the Worker's GH token.

## Output

Generated HTML files land in `output/` (gitignored).
