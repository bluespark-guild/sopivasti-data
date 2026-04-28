# sopivasti-data

Public, developer-curated data files consumed by Sopivasti apps.

Currently hosts:

- `blocklist/v1.json` — accounts the Komma extension hides in YouTube + Instagram feeds and blocks at the profile level. Refreshed by extension installs every 24h.

The extension fetches files directly from `raw.githubusercontent.com` — no Cloudflare Worker, no CD pipeline, no custom domain. Editing a file and pushing is the entire deploy flow.

## Adding a YouTube channel or Instagram account

**Recommended: use the resolver script.** It auto-fetches the immutable channel ID / user ID so the block survives handle renames.

```bash
# YouTube
node scripts/add.mjs youtube scam @scammer1
# → Resolving channel ID for @scammer1…
# → ✓ added @scammer1 → UCabcdef1234567890abcdef
# → Staged. Commit + push:
# →   git commit -m "blocklist: add @scammer1 (scam — <reason>)"

# Instagram
node scripts/add.mjs instagram onlyfans fakebrand_co
# → Resolving user ID for fakebrand_co…
# → ✓ added fakebrand_co → 1234567890
```

After the script runs, write the commit message with the reason and push.

If you'd rather edit JSON by hand, both shapes are accepted:

```json
"scam": {
  "youtube": [
    "@scammer_legacy",                                   // handle-only (rename-vulnerable)
    { "handle": "@scammer1", "channelId": "UCabc..." }   // both (rename-proof)
  ],
  "instagram": [
    "fakebrand_legacy",
    { "handle": "fakebrand_co", "userId": "1234567890" }
  ]
}
```

## Categories

Category metadata (label, description, default-on flag) lives in the JSON itself — adding a category is a single push to this repo, no extension release required. Render order in the Options UI follows JSON insertion order.

Current categories (defaults follow the `defaultOn` flag in the file):

| ID | Default | Use for |
|---|---|---|
| `scam` | ON | Financial fraud, rug-pulls, impersonators (objective harm) |
| `slop` | ON | Low-quality engagement-bait, MrBeast clones, drama farms, reaction farms, kid clickbait — content not worth your time |
| `ai` | ON | AI-generated content (TTS + stock + AI animation, fake news, AI cartoon farms) |
| `onlyfans` | OFF | Accounts whose primary purpose is funnelling to OF (subjective — users opt in) |
| `food` | OFF | Cooking / recipe / food-vlog channels (subjective — users opt in if food content drowns their feed) |

To add a category, add a new key under `categories` with `label`, `description`, `defaultOn`, `youtube`, `instagram`. The next 24h cache refresh picks it up; users see the new toggle in Options. **Trust note:** anyone with write access to this repo can introduce a `defaultOn: true` category that becomes active for all users on next refresh — the extension does not gate category metadata changes through Chrome Web Store review.

## Endpoint

```
https://raw.githubusercontent.com/bluespark-guild/sopivasti-data/master/blocklist/v1.json
```

## Schema

```json
{
  "version": 1,
  "schema": 2,
  "updatedAt": "<ISO 8601 timestamp>",
  "categories": {
    "scam": {
      "label": "Scams",
      "description": "Financial fraud, rug-pulls, impersonators",
      "defaultOn": true,
      "youtube": [<entry>...],
      "instagram": [<entry>...]
    },
    "...": { ... }
  }
}
```

Where `<entry>` is one of:

- A bare string (handle only):
  - YouTube: `"@handle"`
  - Instagram: `"username"`
- An object with the immutable ID:
  - YouTube: `{ "handle": "@handle", "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx" }`
  - Instagram: `{ "handle": "username", "userId": "1234567890" }`

`schema: 2` is the contract version (schema 1 — categories without metadata — is no longer supported). Any breaking schema change ships under a new path (`v2.json`) so existing extension installs keep working.

## Why both handle and ID?

Handles (`@channel` / `username`) are mutable — owners can rename to evade blocklists. The immutable IDs (YouTube: `UC...`, Instagram: numeric) survive renames.

The extension matches:

- **YouTube**: channel ID first (against `/channel/UC...` URLs and `/channel/UC...` links inside feed cards), handle second (against `/@handle` URLs).
- **Instagram**: handle only at runtime (IG URLs and feed cards don't expose user ID reliably). User ID is stored for audit trail and future-proofing.

Always prefer storing both when the resolver succeeds. Use handle-only as a fallback when the ID lookup fails (Instagram anti-bot can block first attempts).

## Why public

Curation is intentionally transparent — anyone can see what's blocked and why (via commit messages), and community members can open issues or PRs to suggest additions or removals.
