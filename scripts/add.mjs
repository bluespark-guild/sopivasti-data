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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BLOCKLIST_PATH = resolve(REPO_ROOT, 'blocklist', 'v1.json');

const CATEGORIES = ['scam', 'spam', 'ai-slop', 'rage-bait', 'onlyfans'];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage:');
  console.error('  node scripts/add.mjs youtube <category> @handle');
  console.error('  node scripts/add.mjs instagram <category> username');
  console.error(`\nCategories: ${CATEGORIES.join(', ')}`);
  process.exit(1);
}

async function resolveYouTubeChannelId(handle) {
  const clean = handle.startsWith('@') ? handle : `@${handle}`;
  const url = `https://www.youtube.com/${encodeURIComponent(clean)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    console.warn(`  ⚠ youtube.com/${clean} → HTTP ${res.status}`);
    return null;
  }
  const html = await res.text();
  // Multiple shapes — try in order of reliability.
  const patterns = [
    /"channelId":"(UC[\w-]{22})"/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
    /\/channel\/(UC[\w-]{22})/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  console.warn(`  ⚠ could not extract channel ID from HTML`);
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
