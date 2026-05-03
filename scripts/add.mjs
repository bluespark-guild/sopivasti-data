#!/usr/bin/env node
/**
 * Add a handle to blocklist/v1.json with auto-resolved stable ID.
 *
 * Usage:
 *   node scripts/add.mjs youtube <category> @handle
 *   node scripts/add.mjs instagram <category> username
 *   node scripts/add.mjs tiktok <category> @handle
 *
 * Valid categories are read from blocklist/v1.json at runtime — no hardcoded
 * list to keep in sync. To add a new category, edit the JSON directly (add
 * a key under `categories` with `label`, `description`, `defaultOn`,
 * `youtube`, `instagram`, `tiktok`).
 *
 * For YouTube: scrapes the channel page HTML to extract `UCxxxxxxxxxxxxxxxxxxxxxx`
 * (immutable channel ID). Survives handle renames.
 *
 * For Instagram: hits `i.instagram.com/api/v1/users/web_profile_info`
 * with the public X-IG-App-ID header to extract numeric user ID.
 * IG aggressively anti-scrapes — this may fail; if it does, the entry
 * is added with handle only (rename-vulnerable but functional).
 *
 * For TikTok: parses the public profile HTML for the rehydration blob's
 * numeric user id. Also prone to anti-bot blocks; falls back to handle-only.
 *
 * Bumps `updatedAt`. Stages the change. Commit + push manually:
 *   git commit -m "blocklist: add @handle (category — reason)"
 *   git push
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveYouTubeChannel } from './lib/yt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BLOCKLIST_PATH = resolve(REPO_ROOT, 'blocklist', 'v1.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// UA still used by Instagram resolver below; YouTube path uses lib/yt.mjs.

function usage(msg, validCategories = null) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage:');
  console.error('  node scripts/add.mjs youtube <category> @handle');
  console.error('  node scripts/add.mjs instagram <category> username');
  console.error('  node scripts/add.mjs tiktok <category> @handle');
  if (validCategories) {
    console.error(`\nValid categories: ${validCategories.join(', ')}`);
  }
  process.exit(1);
}

async function resolveYouTubeChannelId(handle) {
  const result = await resolveYouTubeChannel(handle);
  if (result.error) {
    console.warn(`  ⚠ ${result.error}`);
    return null;
  }
  return result.channelId;
}

async function resolveTikTokUserId(username) {
  // Public profile HTML carries the rehydration JSON blob. The id is buried
  // under user.uniqueId / user.id. TikTok blocks aggressively — if the
  // response isn't HTML or the blob is missing, return null and let the
  // caller persist handle-only.
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn(`  ⚠ tiktok HTTP ${res.status} (anti-bot likely; ID lookup skipped)`);
      return null;
    }
    const html = await res.text();
    const m = html.match(
      /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) {
      console.warn(`  ⚠ tiktok rehydration blob missing (anti-bot interstitial?)`);
      return null;
    }
    const data = JSON.parse(m[1]);
    const id = findTikTokId(data, username.toLowerCase());
    if (id) return id;
    console.warn(`  ⚠ tiktok id not found in rehydration blob`);
    return null;
  } catch (e) {
    console.warn(`  ⚠ tiktok fetch error: ${(e && e.message) || e}`);
    return null;
  }
}

function findTikTokId(obj, expectedUniqueId, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  if (
    obj.user &&
    typeof obj.user === 'object' &&
    typeof obj.user.id === 'string' &&
    typeof obj.user.uniqueId === 'string' &&
    obj.user.uniqueId.toLowerCase() === expectedUniqueId
  ) {
    return obj.user.id;
  }
  for (const key of Object.keys(obj)) {
    const found = findTikTokId(obj[key], expectedUniqueId, depth + 1);
    if (found) return found;
  }
  return null;
}

async function resolveInstagramUserId(username) {
  // Public web_profile_info endpoint. Requires X-IG-App-ID header.
  // 936619743392459 is the long-standing public web app ID.
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'X-IG-App-ID': '936619743392459',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    console.warn(`  ⚠ instagram api → HTTP ${res.status} (anti-bot likely; ID lookup skipped)`);
    return null;
  }
  try {
    const data = await res.json();
    const id = data?.data?.user?.id;
    if (typeof id === 'string' && /^\d+$/.test(id)) return id;
    console.warn(`  ⚠ unexpected instagram response shape`);
    return null;
  } catch {
    console.warn(`  ⚠ instagram response not JSON (likely blocked)`);
    return null;
  }
}

async function main() {
  const [, , platform, category, rawHandle] = process.argv;
  if (!platform || !category || !rawHandle) usage('missing arguments');
  if (platform !== 'youtube' && platform !== 'instagram' && platform !== 'tiktok') {
    usage(`platform must be 'youtube', 'instagram', or 'tiktok', got '${platform}'`);
  }

  const blocklist = JSON.parse(await readFile(BLOCKLIST_PATH, 'utf8'));
  const validCategories = Object.keys(blocklist.categories);
  if (!validCategories.includes(category)) {
    usage(`unknown category '${category}'`, validCategories);
  }
  const cat = blocklist.categories[category];

  let entry;
  if (platform === 'youtube') {
    const handle = rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`;
    if (cat.youtube.some((e) => entryHandle(e).toLowerCase() === handle.toLowerCase())) {
      console.log(`  · ${handle} already in ${category}/youtube — skipping`);
      return;
    }
    console.log(`Resolving channel ID for ${handle}…`);
    const channelId = await resolveYouTubeChannelId(handle);
    entry = channelId ? { handle, channelId } : { handle };
    cat.youtube.push(entry);
    console.log(
      channelId
        ? `  ✓ added ${handle} → ${channelId}`
        : `  ✓ added ${handle} (handle only — ID lookup failed)`,
    );
  } else if (platform === 'instagram') {
    const username = rawHandle.replace(/^@/, '');
    if (cat.instagram.some((e) => entryHandle(e).toLowerCase() === username.toLowerCase())) {
      console.log(`  · ${username} already in ${category}/instagram — skipping`);
      return;
    }
    console.log(`Resolving user ID for ${username}…`);
    const userId = await resolveInstagramUserId(username);
    entry = userId ? { handle: username, userId } : { handle: username };
    cat.instagram.push(entry);
    console.log(
      userId
        ? `  ✓ added ${username} → ${userId}`
        : `  ✓ added ${username} (handle only — ID lookup failed)`,
    );
  } else {
    // tiktok
    if (!Array.isArray(cat.tiktok)) cat.tiktok = [];
    const username = rawHandle.replace(/^@/, '');
    if (cat.tiktok.some((e) => entryHandle(e).toLowerCase() === username.toLowerCase())) {
      console.log(`  · @${username} already in ${category}/tiktok — skipping`);
      return;
    }
    console.log(`Resolving user ID for @${username}…`);
    const userId = await resolveTikTokUserId(username);
    entry = userId ? { handle: username, userId } : { handle: username };
    cat.tiktok.push(entry);
    console.log(
      userId
        ? `  ✓ added @${username} → ${userId}`
        : `  ✓ added @${username} (handle only — ID lookup failed)`,
    );
  }

  blocklist.updatedAt = new Date().toISOString();
  await writeFile(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2) + '\n');

  console.log(`\nStaged. Commit + push:`);
  console.log(`  git add blocklist/v1.json`);
  console.log(`  git commit -m "blocklist: add ${rawHandle} (${category} — <reason>)"`);
  console.log(`  git push`);
}

function entryHandle(entry) {
  return typeof entry === 'string' ? entry : entry.handle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
