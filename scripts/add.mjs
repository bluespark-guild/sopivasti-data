#!/usr/bin/env node
/**
 * Add a handle to blocklist/v1.json with auto-resolved stable ID.
 *
 * Usage:
 *   node scripts/add.mjs youtube <category> @handle
 *   node scripts/add.mjs instagram <category> username
 *
 * Categories: scam, spam, ai-slop, rage-bait, onlyfans
 *
 * For YouTube: scrapes the channel page HTML to extract `UCxxxxxxxxxxxxxxxxxxxxxx`
 * (immutable channel ID). Survives handle renames.
 *
 * For Instagram: hits `i.instagram.com/api/v1/users/web_profile_info`
 * with the public X-IG-App-ID header to extract numeric user ID.
 * IG aggressively anti-scrapes — this may fail; if it does, the entry
 * is added with handle only (rename-vulnerable but functional).
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

const CATEGORIES = ['scam', 'slop', 'ai', 'onlyfans'];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// UA still used by Instagram resolver below; YouTube path uses lib/yt.mjs.

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage:');
  console.error('  node scripts/add.mjs youtube <category> @handle');
  console.error('  node scripts/add.mjs instagram <category> username');
  console.error(`\nCategories: ${CATEGORIES.join(', ')}`);
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
  if (platform !== 'youtube' && platform !== 'instagram') {
    usage(`platform must be 'youtube' or 'instagram', got '${platform}'`);
  }
  if (!CATEGORIES.includes(category)) usage(`unknown category '${category}'`);

  const blocklist = JSON.parse(await readFile(BLOCKLIST_PATH, 'utf8'));
  const cat = blocklist.categories[category];
  if (!cat) usage(`category '${category}' missing from blocklist`);

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
  } else {
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
