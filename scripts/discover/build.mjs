#!/usr/bin/env node
/**
 * Build a discovery batch HTML for review.
 *
 * Pipeline:
 *   1. Scrape Social Blade top-N for the given country (Python helper).
 *   2. Dedupe against existing blocklist/v1.json (any platform, any category).
 *   3. Enrich each remaining channel via scripts/research.mjs (parallel, rate-limited).
 *   4. Render a single self-contained HTML review page with in-card undo.
 *
 * Usage:
 *   node scripts/discover/build.mjs <country> [--limit N] [--concurrency N]
 *
 * Examples:
 *   node scripts/discover/build.mjs us --limit 100
 *   node scripts/discover/build.mjs gb --limit 50 --concurrency 4
 *
 * Output:
 *   scripts/discover/output/<country>-<ISO-date>.html
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BLOCKLIST_PATH = resolve(REPO_ROOT, 'blocklist', 'v1.json');
const RESEARCH_SCRIPT = resolve(REPO_ROOT, 'scripts', 'research.mjs');
const SOCIALBLADE_SCRIPT = resolve(__dirname, 'socialblade.py');
const OUTPUT_DIR = resolve(__dirname, 'output');

function parseArgs(argv) {
  const args = { country: null, limit: 100, concurrency: 3 };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else positional.push(a);
  }
  args.country = positional[0];
  if (!args.country) {
    console.error('Usage: build.mjs <country> [--limit N] [--concurrency N]');
    process.exit(1);
  }
  return args;
}

function runJson(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, args, opts);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return rejectP(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${err}`));
      try {
        resolveP(JSON.parse(out));
      } catch (e) {
        rejectP(new Error(`bad JSON from ${cmd}: ${e.message}\n--- stdout:\n${out}\n--- stderr:\n${err}`));
      }
    });
  });
}

async function loadBlocklist() {
  const raw = await readFile(BLOCKLIST_PATH, 'utf8');
  const data = JSON.parse(raw);
  const channelIds = new Set();
  const handles = new Set();
  for (const cat of Object.values(data.categories ?? {})) {
    for (const entry of cat.youtube ?? []) {
      if (entry.channelId) channelIds.add(entry.channelId);
      if (entry.handle) handles.add(entry.handle.toLowerCase().replace(/^@/, ''));
    }
  }
  return { channelIds, handles };
}

async function discoverSocialBlade(country, limit) {
  return runJson('python3', [SOCIALBLADE_SCRIPT, country, '--limit', String(limit)]);
}

async function research(channelId) {
  const url = `https://www.youtube.com/channel/${channelId}`;
  return runJson('node', [RESEARCH_SCRIPT, url]);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCard(row, enriched) {
  const r = enriched ?? {};
  const name = escapeHtml(r.name || row.name);
  const handle = r.handle ? `@${escapeHtml(r.handle)}` : row.handle ? `@${escapeHtml(row.handle)}` : '';
  const subs = escapeHtml(row.subs || r.subs || '?');
  const channelId = escapeHtml(row.channelId);
  const channelUrl = escapeHtml(r.channelUrl || `https://www.youtube.com/channel/${row.channelId}`);
  const avatar = r.avatar ? `<img src="${escapeHtml(r.avatar)}" alt="" loading="lazy" />` : `<span class="ch-avatar-fallback">${escapeHtml(name[0] ?? '?')}</span>`;
  const banner = r.banner
    ? `style="background-image:url('${escapeHtml(r.banner)}'); background-size:cover; background-position:center;"`
    : '';
  const suggested = r.suggestedCategory ? escapeHtml(r.suggestedCategory) : '';
  const reasoning = escapeHtml(r.reasoning || '');
  const errors = (r.errors ?? []).filter(Boolean);
  const errBadge = errors.length
    ? `<div class="ch-err">⚠ ${escapeHtml(errors.join('; '))}</div>`
    : '';

  const recent = (r.recent ?? []).slice(0, 5);
  const thumbs = recent
    .map(
      (v) =>
        `<div class="ch-thumb"><img src="${escapeHtml(v.thumb)}" alt="" loading="lazy" /></div>`,
    )
    .join('');
  const titles = recent
    .slice(0, 3)
    .map((v) => `<div title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</div>`)
    .join('');

  return `
<div class="ch-card" data-rank="${row.rank}" data-channel-id="${channelId}" data-handle="${escapeHtml(row.handle ?? '')}" data-suggested="${suggested}">
  <div class="ch-banner" ${banner}>
    <div class="ch-rank">#${row.rank}</div>
    <div class="ch-avatar">${avatar}</div>
  </div>
  <div class="ch-body">
    <div class="ch-name"><a href="${channelUrl}" target="_blank" rel="noopener">${name}</a></div>
    <div class="ch-meta">${handle} · ${subs} subs</div>
    ${suggested ? `<div class="ch-tag-row"><span class="ch-tag suggested">→ ${suggested}</span></div>` : ''}
    ${reasoning ? `<div class="ch-reason">${reasoning}</div>` : ''}
    <div class="ch-thumbs">${thumbs || '<div class="ch-thumb empty"></div>'.repeat(5)}</div>
    <div class="ch-titles">${titles}</div>
    ${errBadge}
  </div>
  <div class="ch-confirm" hidden>
    <div class="ch-check">✓</div>
    <div class="ch-confirm-label"></div>
    <div class="ch-confirm-sub"></div>
  </div>
  <div class="ch-countdown" hidden><div class="ch-countdown-bar"></div></div>
  <div class="ch-actions">
    <select class="ch-cat">
      <option value="scam">scam</option>
      <option value="slop">slop</option>
      <option value="ai">ai</option>
      <option value="food">food</option>
      <option value="onlyfans">onlyfans</option>
    </select>
    <button class="ch-btn skip" data-action="skip">Skip</button>
    <button class="ch-btn block" data-action="block">Block</button>
  </div>
  <div class="ch-actions undo-row" hidden>
    <button class="ch-btn undo" data-action="undo">↶ Undo</button>
  </div>
</div>`;
}

function renderHtml(country, rows, enriched, blockedCount, scrapedCount) {
  const cards = rows.map((row, i) => renderCard(row, enriched[i])).join('\n');
  const flag = country.toUpperCase();
  const date = new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Komma Discover · ${flag} · ${date}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #111827; background: #f5f5f5; line-height: 1.5; }
  header { background: #fff; padding: 18px 24px; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 18px; font-weight: 700; }
  header .meta { color: #6b7280; font-size: 13px; }
  header .stats { margin-left: auto; display: flex; gap: 16px; font-size: 13px; }
  header .stat-num { font-weight: 700; color: #111827; }
  .toolbar { display: flex; gap: 8px; padding: 12px 24px; background: #fafafa; border-bottom: 1px solid #e5e7eb; }
  .toolbar button { padding: 6px 12px; border-radius: 6px; border: 1px solid #e5e7eb; background: #fff; font-size: 13px; cursor: pointer; }
  .toolbar button.primary { background: #111827; color: #fff; border-color: #111827; }
  main { max-width: 1400px; margin: 0 auto; padding: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .ch-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; position: relative; transition: opacity 0.2s; }
  .ch-card.confirming .ch-body { opacity: 0.35; pointer-events: none; }
  .ch-card.confirming .ch-banner { filter: grayscale(0.6); opacity: 0.5; }
  .ch-card.removed { display: none; }
  .ch-banner { height: 84px; background: linear-gradient(135deg, #cbd5e1, #94a3b8); display: flex; align-items: flex-end; padding: 8px; position: relative; }
  .ch-rank { position: absolute; top: 8px; left: 10px; background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .ch-avatar { width: 52px; height: 52px; border-radius: 50%; overflow: hidden; border: 3px solid #fff; margin-bottom: -26px; background: #fff; flex-shrink: 0; }
  .ch-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .ch-avatar-fallback { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-weight: 700; color: #6b7280; font-size: 22px; }
  .ch-body { padding: 32px 14px 14px; }
  .ch-name { font-size: 15px; font-weight: 600; margin-bottom: 2px; }
  .ch-name a { color: inherit; text-decoration: none; }
  .ch-name a:hover { text-decoration: underline; }
  .ch-meta { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
  .ch-tag-row { margin-bottom: 8px; }
  .ch-tag { font-size: 11px; padding: 3px 8px; border-radius: 4px; background: #f3f4f6; color: #374151; }
  .ch-tag.suggested { background: #fef3c7; color: #92400e; font-weight: 600; }
  .ch-reason { font-size: 11px; color: #6b7280; margin-bottom: 8px; line-height: 1.4; font-style: italic; }
  .ch-thumbs { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; margin-bottom: 8px; }
  .ch-thumb { aspect-ratio: 16/9; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
  .ch-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .ch-thumb.empty { background: linear-gradient(135deg, #e5e7eb, #cbd5e1); }
  .ch-titles { font-size: 11px; color: #6b7280; line-height: 1.4; min-height: 36px; }
  .ch-titles div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch-err { margin-top: 6px; font-size: 11px; color: #b91c1c; background: #fee2e2; padding: 4px 8px; border-radius: 4px; }
  .ch-actions { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #f3f4f6; background: #fafafa; }
  .ch-cat { flex: 1; padding: 6px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
  .ch-btn { padding: 7px 12px; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .ch-btn.block { background: #dc2626; color: #fff; }
  .ch-btn.skip { background: #f3f4f6; color: #374151; }
  .ch-btn.undo { flex: 1; background: #fff; color: #dc2626; padding: 10px; font-weight: 700; cursor: pointer; }
  .ch-actions.undo-row { background: #fff; padding: 0; border-top: 1px solid #fee2e2; }
  .ch-confirm { position: absolute; inset: 84px 0 44px 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 16px; text-align: center; background: rgba(255,255,255,0.94); backdrop-filter: blur(2px); z-index: 5; }
  .ch-check { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 22px; font-weight: 700; background: #dc2626; }
  .ch-card[data-state="skipped"] .ch-check { background: #6b7280; }
  .ch-confirm-label { font-size: 13px; font-weight: 600; }
  .ch-confirm-sub { font-size: 11px; color: #6b7280; }
  .ch-countdown { height: 3px; background: #fee2e2; position: absolute; bottom: 44px; left: 0; right: 0; overflow: hidden; z-index: 6; }
  .ch-countdown-bar { height: 100%; width: 100%; background: #dc2626; transform-origin: left; animation: countdown 8s linear forwards; }
  .ch-card[data-state="skipped"] .ch-countdown { background: #e5e7eb; }
  .ch-card[data-state="skipped"] .ch-countdown-bar { background: #6b7280; }
  @keyframes countdown { from { transform: scaleX(1); } to { transform: scaleX(0); } }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr 1fr; } header .stats { width: 100%; } }
</style>
</head>
<body>
<header>
  <h1>Komma Discover · ${flag}</h1>
  <span class="meta">Top channels by subs · ${date}</span>
  <div class="stats">
    <div><span class="stat-num" id="stat-pending">${rows.length}</span> pending</div>
    <div><span class="stat-num" id="stat-blocked">0</span> blocked</div>
    <div><span class="stat-num" id="stat-skipped">0</span> skipped</div>
    <div><span class="meta">${scrapedCount} scraped · ${blockedCount} already blocked</span></div>
  </div>
</header>
<div class="toolbar">
  <button id="export-btn" class="primary">Export decisions (JSON)</button>
  <button id="export-cmds-btn">Export add.mjs commands</button>
  <button id="clear-btn">Clear localStorage</button>
  <span style="margin-left:auto;color:#6b7280;font-size:12px;">B/S/1-5 keyboard shortcuts. Decisions saved to localStorage.</span>
</div>
<main>
  <div class="grid">
${cards}
  </div>
</main>
<script>
(() => {
  const STORAGE_KEY = 'komma-discover-${country}-${date}';
  const COMMIT_DELAY_MS = 8000;
  const decisions = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  const timers = new Map();

  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions)); }

  function updateStats() {
    const blocked = Object.values(decisions).filter(d => d.action === 'block').length;
    const skipped = Object.values(decisions).filter(d => d.action === 'skip').length;
    document.getElementById('stat-blocked').textContent = blocked;
    document.getElementById('stat-skipped').textContent = skipped;
    document.getElementById('stat-pending').textContent =
      document.querySelectorAll('.ch-card:not(.removed)').length - blocked - skipped;
  }

  function applySavedState() {
    document.querySelectorAll('.ch-card').forEach(card => {
      const id = card.dataset.channelId;
      const d = decisions[id];
      if (!d) return;
      if (d.action === 'block' || d.action === 'skip') {
        card.classList.add('removed');
      }
    });
    updateStats();
  }

  function setConfirmState(card, action, category) {
    const labelEl = card.querySelector('.ch-confirm-label');
    const subEl = card.querySelector('.ch-confirm-sub');
    if (action === 'block') {
      card.dataset.state = 'blocked';
      labelEl.textContent = \`Blocked · \${category}\`;
      subEl.textContent = 'Auto-commits in 8s';
    } else {
      card.dataset.state = 'skipped';
      labelEl.textContent = 'Skipped';
      subEl.textContent = 'Re-surfaces in 6 months';
      card.querySelector('.ch-check').textContent = '→';
    }
    card.classList.add('confirming');
    card.querySelector('.ch-confirm').hidden = false;
    card.querySelector('.ch-countdown').hidden = false;
    card.querySelector('.ch-actions:not(.undo-row)').hidden = true;
    card.querySelector('.ch-actions.undo-row').hidden = false;
    // restart countdown animation
    const bar = card.querySelector('.ch-countdown-bar');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
  }

  function clearConfirmState(card) {
    card.classList.remove('confirming');
    delete card.dataset.state;
    card.querySelector('.ch-check').textContent = '✓';
    card.querySelector('.ch-confirm').hidden = true;
    card.querySelector('.ch-countdown').hidden = true;
    card.querySelector('.ch-actions:not(.undo-row)').hidden = false;
    card.querySelector('.ch-actions.undo-row').hidden = true;
  }

  function commit(card) {
    card.classList.add('removed');
    timers.delete(card);
    updateStats();
  }

  function act(card, action) {
    const id = card.dataset.channelId;
    const handle = card.dataset.handle;
    const category = card.querySelector('.ch-cat').value;
    decisions[id] = {
      action, category: action === 'block' ? category : null,
      handle, name: card.querySelector('.ch-name').textContent.trim(),
      ts: Date.now(),
    };
    save();
    setConfirmState(card, action, category);
    const t = setTimeout(() => commit(card), COMMIT_DELAY_MS);
    timers.set(card, t);
    updateStats();
  }

  function undo(card) {
    const id = card.dataset.channelId;
    delete decisions[id];
    save();
    if (timers.has(card)) { clearTimeout(timers.get(card)); timers.delete(card); }
    clearConfirmState(card);
    updateStats();
  }

  document.querySelectorAll('.ch-card').forEach(card => {
    card.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'undo') undo(card);
      else act(card, action);
    });
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(decisions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = STORAGE_KEY + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('export-cmds-btn').addEventListener('click', () => {
    const cmds = Object.entries(decisions)
      .filter(([, d]) => d.action === 'block' && d.handle)
      .map(([, d]) => \`node scripts/add.mjs youtube \${d.category} @\${d.handle}\`)
      .join('\\n');
    const blob = new Blob([cmds], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = STORAGE_KEY + '.sh';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('clear-btn').addEventListener('click', () => {
    if (!confirm('Clear all decisions for this batch?')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  // Keyboard: B/S on hovered card, 1-5 to set category
  let hovered = null;
  document.addEventListener('mouseover', e => {
    const c = e.target.closest('.ch-card');
    if (c && !c.classList.contains('removed') && !c.classList.contains('confirming')) hovered = c;
  });
  document.addEventListener('keydown', e => {
    if (!hovered) return;
    if (e.key.toLowerCase() === 'b') { act(hovered, 'block'); }
    else if (e.key.toLowerCase() === 's') { act(hovered, 'skip'); }
    else if (e.key >= '1' && e.key <= '5') {
      const sel = hovered.querySelector('.ch-cat');
      sel.selectedIndex = Number(e.key) - 1;
    }
  });

  applySavedState();
})();
</script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv);
  const country = args.country.toLowerCase();

  console.error(`[1/4] Loading blocklist…`);
  const { channelIds, handles } = await loadBlocklist();

  console.error(`[2/4] Scraping Social Blade top-${args.limit} ${country.toUpperCase()}…`);
  const scraped = await discoverSocialBlade(country, args.limit);
  console.error(`      ${scraped.length} channels scraped`);

  const fresh = scraped.filter((row) => {
    if (channelIds.has(row.channelId)) return false;
    if (row.handle && handles.has(row.handle.toLowerCase())) return false;
    return true;
  });
  const blockedCount = scraped.length - fresh.length;
  console.error(`      ${fresh.length} fresh / ${blockedCount} already in blocklist`);

  if (fresh.length === 0) {
    console.error('Nothing to review.');
    return;
  }

  console.error(`[3/4] Enriching ${fresh.length} channels (concurrency ${args.concurrency})…`);
  let done = 0;
  const enriched = await pool(fresh, args.concurrency, async (row) => {
    const r = await research(row.channelId).catch((e) => ({ __error: e.message }));
    done++;
    process.stderr.write(`\r      ${done}/${fresh.length}`);
    return r;
  });
  process.stderr.write('\n');

  await mkdir(OUTPUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = resolve(OUTPUT_DIR, `${country}-${date}.html`);
  const html = renderHtml(country, fresh, enriched, blockedCount, scraped.length);
  await writeFile(outPath, html);

  console.error(`[4/4] Wrote ${outPath}`);
  console.log(outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
