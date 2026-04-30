#!/usr/bin/env node
/**
 * Drain the HQ Komma apply queue.
 *
 * Pulls pending block items from `${HQ_BASE_URL}/api/komma/apply-queue` (bearer auth),
 * runs `add.mjs youtube <category> @<handle>` for each, commits everything in one commit,
 * pushes, then ACKs all consumed items so HQ deletes them from KV.
 *
 * Designed to run on cron (every 15 min) from sopivasti-data. No GitHub PAT needed —
 * the workflow's default GITHUB_TOKEN handles the push, and HQ access is via
 * KOMMA_APPLY_TOKEN (shared bearer between HQ Worker secret + this workflow's GHA secret).
 *
 * Required env:
 *   HQ_BASE_URL          e.g. https://hq.sopivasti.workers.dev
 *   KOMMA_APPLY_TOKEN    bearer token matching HQ Worker secret of the same name
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const HQ_BASE_URL = process.env.HQ_BASE_URL;
const TOKEN = process.env.KOMMA_APPLY_TOKEN;
if (!HQ_BASE_URL) throw new Error('HQ_BASE_URL env required');
if (!TOKEN) throw new Error('KOMMA_APPLY_TOKEN env required');

function run(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
    p.on('close', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${cmd} ${args.join(' ')} exit ${code}`));
    });
  });
}

function runCapture(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, { cwd: REPO_ROOT, ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code === 0) resolveP(out);
      else rejectP(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${err}`));
    });
  });
}

async function gitClean() {
  const status = await runCapture('git', ['status', '--porcelain']);
  return status.trim() === '';
}

async function fetchQueue() {
  const res = await fetch(`${HQ_BASE_URL}/api/komma/apply-queue`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`apply-queue HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.items ?? [];
}

async function ack(channelIds) {
  const res = await fetch(`${HQ_BASE_URL}/api/komma/apply-ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ channelIds }),
  });
  if (!res.ok) throw new Error(`apply-ack HTTP ${res.status}: ${await res.text()}`);
}

async function main() {
  if (!(await gitClean())) {
    console.error('working tree dirty — refusing to run');
    process.exit(1);
  }

  const items = await fetchQueue();
  if (items.length === 0) {
    console.log('Queue empty.');
    return;
  }
  console.log(`Draining ${items.length} item(s)…`);

  const applied = [];
  const skipped = [];
  const failed = [];

  for (const item of items) {
    if (!item?.handle || !item?.category) {
      console.log(`  ✗ ${item?.channelId} — missing handle/category, skipping`);
      skipped.push(item);
      continue;
    }
    const handle = item.handle.startsWith('@') ? item.handle : `@${item.handle}`;
    try {
      await run('node', ['scripts/add.mjs', 'youtube', item.category, handle]);
      applied.push(item);
      console.log(`  ✓ ${handle} → ${item.category}`);
    } catch (e) {
      failed.push({ item, error: e.message });
      console.error(`  ✗ ${handle} — ${e.message}`);
    }
  }

  if (await gitClean()) {
    console.log('No file changes (all items were duplicates).');
    if (applied.length > 0) {
      // Even with no diff, ACK so they don't loop forever.
      await ack(applied.map((i) => i.channelId));
    }
    return;
  }

  await run('git', ['config', 'user.name', 'komma-bot']);
  await run('git', ['config', 'user.email', 'noreply@sopivasti.com']);
  await run('git', ['add', 'blocklist/v1.json']);

  const byCategory = applied.reduce((acc, i) => {
    acc[i.category] = (acc[i.category] || 0) + 1;
    return acc;
  }, {});
  const counts = Object.entries(byCategory)
    .map(([c, n]) => `${n} ${c}`)
    .join(', ');
  const lines = applied.map(
    (i) => `- ${i.handle.startsWith('@') ? i.handle : `@${i.handle}`} → ${i.category}${i.reasoning ? ` (${i.reasoning})` : ''}`,
  );
  const msg = `blocklist: batch add ${applied.length} (${counts})\n\n${lines.join('\n')}`;

  await run('git', ['commit', '-m', msg]);
  await run('git', ['push']);

  await ack(applied.map((i) => i.channelId));
  console.log(`Pushed + ACKed ${applied.length}.`);

  if (failed.length > 0) {
    console.error(`${failed.length} failed (NOT ACKed; will retry next run):`);
    for (const f of failed) console.error(`  ${f.item.channelId}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
