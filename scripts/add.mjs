#!/usr/bin/env node
/**
 * Add a handle to blocklist/v1.json with auto-resolved stable ID.
 *
 * Usage:
 *   node scripts/add.mjs youtube @handle
 *   node scripts/add.mjs instagram username
 *   node scripts/add.mjs tiktok @handle
 *   node scripts/add.mjs twitch login
 *
 * Flat schema — no categories. Every entry the curator pushes is "banned,
 * full stop." Users see one master toggle, on or off.
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
 * For Twitch: hits gql.twitch.tv with the public web client-id when
 * scripts/lib/twitch.mjs is present; otherwise persists handle-only.
 *
 * Bumps `updatedAt`. Stages the change. Commit + push manually:
 *   git commit -m "blocklist: add @handle (reason)"
 *   git push
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveYouTubeChannel } from './lib/yt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BLOCKLIST_PATH = resolve(REPO_ROOT, 'blocklist', 'v1.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage:');
  console.error('  node scripts/add.mjs youtube @handle');
  console.error('  node scripts/add.mjs instagram username');
  console.error('  node scripts/add.mjs tiktok @handle');
  console.error('  node scripts/add.mjs twitch login');
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

async function resolveTwitchEntry(login) {
  const libPath = resolve(__dirname, 'lib', 'twitch.mjs');
  if (!existsSync(libPath)) {
    return { handle: login };
  }
  try {
    const mod = await import('./lib/twitch.mjs');
    const result = await mod.resolveTwitchChannel(login);
    if (result?.error) {
      console.warn(`  ⚠ ${result.error}`);
      return { handle: login };
    }
    return { handle: result.login.toLowerCase(), userId: result.userId };
  } catch (e) {
    console.warn(`  ⚠ twitch resolver error: ${(e && e.message) || e}`);
    return { handle: login };
  }
}

async function main() {
  const [, , platform, rawHandle] = process.argv;
  if (!platform || !rawHandle) usage('missing arguments');
  if (
    platform !== 'youtube' &&
    platform !== 'instagram' &&
    platform !== 'tiktok' &&
    platform !== 'twitch'
  ) {
    usage(`platform must be 'youtube', 'instagram', 'tiktok', or 'twitch', got '${platform}'`);
  }

  const blocklist = JSON.parse(await readFile(BLOCKLIST_PATH, 'utf8'));
  if (!Array.isArray(blocklist.youtube)) blocklist.youtube = [];
  if (!Array.isArray(blocklist.instagram)) blocklist.instagram = [];
  if (!Array.isArray(blocklist.tiktok)) blocklist.tiktok = [];
  if (!Array.isArray(blocklist.twitch)) blocklist.twitch = [];

  let entry;
  if (platform === 'youtube') {
    const handle = rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`;
    if (blocklist.youtube.some((e) => entryHandle(e).toLowerCase() === handle.toLowerCase())) {
      console.log(`  · ${handle} already in youtube — skipping`);
      return;
    }
    console.log(`Resolving channel ID for ${handle}…`);
    const channelId = await resolveYouTubeChannelId(handle);
    entry = channelId ? { handle, channelId } : { handle };
    blocklist.youtube.push(entry);
    console.log(
      channelId
        ? `  ✓ added ${handle} → ${channelId}`
        : `  ✓ added ${handle} (handle only — ID lookup failed)`,
    );
  } else if (platform === 'instagram') {
    const username = rawHandle.replace(/^@/, '');
    if (blocklist.instagram.some((e) => entryHandle(e).toLowerCase() === username.toLowerCase())) {
      console.log(`  · ${username} already in instagram — skipping`);
      return;
    }
    console.log(`Resolving user ID for ${username}…`);
    const userId = await resolveInstagramUserId(username);
    entry = userId ? { handle: username, userId } : { handle: username };
    blocklist.instagram.push(entry);
    console.log(
      userId
        ? `  ✓ added ${username} → ${userId}`
        : `  ✓ added ${username} (handle only — ID lookup failed)`,
    );
  } else if (platform === 'tiktok') {
    const username = rawHandle.replace(/^@/, '');
    if (blocklist.tiktok.some((e) => entryHandle(e).toLowerCase() === username.toLowerCase())) {
      console.log(`  · @${username} already in tiktok — skipping`);
      return;
    }
    console.log(`Resolving user ID for @${username}…`);
    const userId = await resolveTikTokUserId(username);
    entry = userId ? { handle: username, userId } : { handle: username };
    blocklist.tiktok.push(entry);
    console.log(
      userId
        ? `  ✓ added @${username} → ${userId}`
        : `  ✓ added @${username} (handle only — ID lookup failed)`,
    );
  } else {
    const login = rawHandle.replace(/^@/, '').toLowerCase();
    if (blocklist.twitch.some((e) => entryHandle(e).toLowerCase() === login)) {
      console.log(`  · ${login} already in twitch — skipping`);
      return;
    }
    console.log(`Resolving user ID for ${login}…`);
    entry = await resolveTwitchEntry(login);
    blocklist.twitch.push(entry);
    console.log(
      entry.userId
        ? `  ✓ added ${entry.handle} → ${entry.userId}`
        : `  ✓ added ${login} (handle only — ID lookup failed)`,
    );
  }

  blocklist.updatedAt = new Date().toISOString();
  await writeFile(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2) + '\n');

  console.log(`\nStaged. Commit + push:`);
  console.log(`  git add blocklist/v1.json`);
  console.log(`  git commit -m "blocklist: add ${rawHandle} (<reason>)"`);
  console.log(`  git push`);
}

function entryHandle(entry) {
  return typeof entry === 'string' ? entry : entry.handle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
