#!/usr/bin/env node
/**
 * Purge jsdelivr edge cache for blocklist/v1.json.
 *
 * jsdelivr caches `@master` branch URLs for 12h at the edge. After pushing a
 * blocklist change to GitHub, call this script to force the edge to re-fetch
 * on next request — combined with the 1h client TTL in Komma, that means
 * curated additions propagate within ~1h end-to-end instead of ~13h.
 *
 * Usage:
 *   node scripts/purge.mjs
 *
 * The purge endpoint is unauthenticated, idempotent, and returns a small JSON
 * body. We treat any 2xx as success. Failures are warnings only — the cache
 * still expires naturally within 12h.
 */

const PURGE_URL =
  'https://purge.jsdelivr.net/gh/bluespark-guild/sopivasti-data@master/blocklist/v1.json';

async function main() {
  try {
    const res = await fetch(PURGE_URL);
    if (!res.ok) {
      console.warn(`  ⚠ jsdelivr purge → HTTP ${res.status} (cache will expire naturally within 12h)`);
      return;
    }
    console.log(`  ✓ jsdelivr edge purged`);
  } catch (e) {
    console.warn(`  ⚠ jsdelivr purge error: ${(e && e.message) || e}`);
  }
}

main();
