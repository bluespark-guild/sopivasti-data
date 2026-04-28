# sopivasti-data

Public, developer-curated data files consumed by Sopivasti apps.

Currently hosts:

- `blocklist/v1.json` — accounts the Komma extension hides in YouTube + Instagram feeds and blocks at the profile level. Refreshed by extension installs every 24h.

The extension fetches files directly from `raw.githubusercontent.com` — no Cloudflare Worker, no CD pipeline, no custom domain. Editing a file and pushing is the entire deploy flow.

## Adding a YouTube channel or Instagram account to the blocklist

1. Open `blocklist/v1.json` (edit on github.com or locally).
2. Pick the right **category** under `categories`. Categories:
   - `scam` — rug-pulls, impersonators, financial fraud (default ON for all users)
   - `spam` — bot farms, link spam, mass-engagement (default ON)
   - `ai-slop` — auto-generated low-effort content (default ON)
   - `rage-bait` — engagement traps, manufactured drama (default ON)
   - `onlyfans` — accounts whose primary purpose is funnelling to OF (default OFF — subjective, users opt in)
3. Append the handle to the right platform array inside that category.
   - YouTube handles include the leading `@` (e.g. `"@scammer1"`).
   - Instagram usernames are bare (e.g. `"fakebrand_co"`).
4. Update `updatedAt` to the current ISO timestamp.
5. Commit with the reason in the message — the commit log is the audit trail.

   ```
   blocklist: add @scammer1 (scam — crypto rug-pull promotions)
   ```

6. Push to `master`. `raw.githubusercontent.com` serves the new JSON within ~5 minutes. Each Komma install picks it up on its next 24h refresh, or sooner via Options → Refresh now.

## Endpoint

```
https://raw.githubusercontent.com/bluespark-guild/sopivasti-data/master/blocklist/v1.json
```

## Schema

```json
{
  "version": 1,
  "schema": 1,
  "updatedAt": "<ISO 8601 timestamp>",
  "categories": {
    "scam":      { "youtube": ["@handle"], "instagram": ["username"] },
    "spam":      { "youtube": [],          "instagram": [] },
    "ai-slop":   { "youtube": [],          "instagram": [] },
    "rage-bait": { "youtube": [],          "instagram": [] },
    "onlyfans":  { "youtube": [],          "instagram": [] }
  }
}
```

`schema: 1` is the contract version. Any breaking schema change ships under a new path (`v2.json`) so existing extension installs keep working.

Adding a new category requires both:
1. An extension release that adds the category to `BLOCKLIST_CATEGORIES` in `extension/utils/dev-blocklist.ts`.
2. A `categories.<new-id>` entry in this JSON.

Categories on the JSON that the extension doesn't know about are silently ignored (forward-compatible). Categories the extension knows about that aren't on the JSON are treated as empty.

## Why public

Curation is intentionally transparent — anyone can see what's blocked and why (via commit messages), and community members can open issues or PRs to suggest additions or removals.
