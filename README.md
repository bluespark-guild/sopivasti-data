# sopivasti-data

Public, developer-curated data files consumed by Sopivasti apps.

Currently hosts:

- `blocklist/v1.json` — accounts the Komma extension hides in YouTube + Instagram feeds and blocks at the profile level. Refreshed by extension installs every 24h.

The extension fetches files directly from `raw.githubusercontent.com` — no Cloudflare Worker, no CD pipeline, no custom domain. Editing a file and pushing is the entire deploy flow.

## Adding a YouTube channel or Instagram account to the blocklist

1. Open `blocklist/v1.json` (edit on github.com or locally).
2. Append the handle to the right platform array.
   - YouTube handles are stored with the leading `@` (e.g. `"@scammer1"`).
   - Instagram usernames are bare (e.g. `"fakebrand_co"`).
3. Update `updatedAt` to the current ISO timestamp.
4. Commit with the reason in the message — the commit log is the audit trail.

   ```
   blocklist: add @scammer1 (crypto rug-pull promotions)
   ```

5. Push to `master`. `raw.githubusercontent.com` serves the new JSON within ~5 minutes. Each Komma install picks it up on its next 24h refresh, or sooner via Options → Refresh now.

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
  "youtube":   ["@handle1", "@handle2"],
  "instagram": ["username1", "username2"]
}
```

`schema: 1` is the contract version. Any breaking schema change ships under a new path (`v2.json`) so existing extension installs keep working.

## Why public

The curation is intentionally transparent — anyone can see what's blocked and why (via commit messages), and community members can open issues or PRs to suggest additions or removals.
