#!/usr/bin/env node
/**
 * Research a candidate URL for the dev blocklist.
 *
 * Usage:
 *   node scripts/research.mjs <url>
 *
 * Validates the URL (must be a YouTube channel or Instagram profile),
 * fetches the page, extracts metadata, suggests a category. Emits a
 * single JSON object to stdout.
 *
 * Output shape:
 * {
 *   "valid": boolean,
 *   "platform": "youtube" | "instagram" | null,
 *   "handle": string | null,
 *   "channelId": string | null,    // YT only
 *   "userId": string | null,        // IG only
 *   "name": string | null,
 *   "subs": string | null,
 *   "videoCount": number | null,
 *   "description": string | null,
 *   "avatar": string | null,
 *   "banner": string | null,
 *   "recent": [ { "title": string, "thumb": string, "views": string } ],
 *   "channelUrl": string,
 *   "suggestedCategory": "scam" | "spam" | "ai-slop" | "rage-bait" | "onlyfans" | null,
 *   "reasoning": string,
 *   "errors": [ string ]
 * }
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CATEGORIES = ['scam', 'spam', 'ai-slop', 'rage-bait', 'onlyfans'];

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitError(url, msg) {
  emit({
    valid: false,
    platform: null,
    handle: null,
    channelId: null,
    userId: null,
    name: null,
    subs: null,
    videoCount: null,
    description: null,
    avatar: null,
    banner: null,
    recent: [],
    channelUrl: url,
    suggestedCategory: null,
    reasoning: '',
    errors: [msg],
  });
}

function classifyUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'malformed URL' };
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const path = u.pathname;
  if (host === 'youtube.com' || host === 'youtu.be') {
    if (host === 'youtu.be') return { ok: false, error: 'youtu.be is a video link, not a channel' };
    if (path.startsWith('/watch') || path.startsWith('/shorts/')) {
      return { ok: false, error: 'video URL — paste the channel URL instead' };
    }
    if (path.startsWith('/@')) return { ok: true, platform: 'youtube', kind: 'handle' };
    if (path.startsWith('/channel/')) return { ok: true, platform: 'youtube', kind: 'channelId' };
    if (path.startsWith('/c/')) return { ok: true, platform: 'youtube', kind: 'customUrl' };
    if (path.startsWith('/user/')) return { ok: true, platform: 'youtube', kind: 'legacyUser' };
    return { ok: false, error: 'unrecognised YouTube URL form' };
  }
  if (host === 'instagram.com') {
    const reserved = new Set([
      'explore', 'reels', 'reel', 'p', 'stories', 'accounts',
      'direct', 'tv', 'about', 'developer', 'legal', 'press', 'blog',
    ]);
    const m =
      path.match(/^\/([\w.]+)\/?$/) ||
      path.match(/^\/([\w.]+)\/(?:tagged|saved|reels)\/?$/);
    if (!m) return { ok: false, error: 'instagram URL must point to a profile' };
    if (reserved.has(m[1].toLowerCase())) {
      return { ok: false, error: `'${m[1]}' is a reserved IG path, not a profile` };
    }
    return { ok: true, platform: 'instagram', kind: 'username', username: m[1] };
  }
  return { ok: false, error: `unsupported host: ${host}` };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

function extractYtInitialData(html) {
  const m = html.match(/var ytInitialData = (\{.+?\});<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function deepFind(obj, predicate, depth = 0) {
  if (depth > 10) return null;
  if (!obj || typeof obj !== 'object') return null;
  if (predicate(obj)) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFind(item, predicate, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(obj)) {
    const found = deepFind(obj[key], predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

function deepFindAll(obj, predicate, out = [], depth = 0) {
  if (depth > 12) return out;
  if (!obj || typeof obj !== 'object') return out;
  if (predicate(obj)) out.push(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) deepFindAll(item, predicate, out, depth + 1);
    return out;
  }
  for (const key of Object.keys(obj)) {
    deepFindAll(obj[key], predicate, out, depth + 1);
  }
  return out;
}

function suggestYoutubeCategory({ name, description, recent }) {
  const haystack = (
    (name || '') + ' ' + (description || '') + ' ' +
    recent.map((r) => r.title).join(' ')
  ).toLowerCase();

  // Order matters — most specific first.
  const rules = [
    {
      cat: 'scam',
      patterns: [
        /crypto|bitcoin|altcoin/, /\bnft\b/, /pump|10x|100x|moon shot/,
        /guaranteed (returns?|profit)/, /passive income/, /get rich/,
        /forex (signals|trading bot)/, /\bmlm\b|matrix scheme/,
      ],
      reason: 'Title/description signals: crypto pump, "passive income", "guaranteed returns", or MLM language.',
    },
    {
      cat: 'rage-bait',
      patterns: [
        /react(s|ing) to|tier list|hot takes?/, /\bvs\b.*\bvs\b/,
        /destroyed|exposed|owned|cringe compilation/,
        /you won.?t believe|shocking truth/,
      ],
      reason: 'Reaction / hot-take / "you won\'t believe" framing dominates recent titles.',
    },
    {
      cat: 'ai-slop',
      patterns: [
        /\bai (history|facts?|stories|narrat)/, /\b(top|best) \d+\b/,
        /amazing facts/, /life hacks/, /unsolved myster/,
        /weird (history|facts)/, /did you know\?\?/,
      ],
      reason: 'Templated TTS-explainer pattern: "Top N", "Amazing Facts", "Life Hacks", history/mystery loops.',
    },
    {
      cat: 'onlyfans',
      patterns: [
        /\bof\b.*link/, /onlyfans|fansly/, /spicy site/, /link in bio.*18\+/,
      ],
      reason: 'Channel funnels viewers to OnlyFans / paywalled adult content.',
    },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((re) => re.test(haystack))) {
      return { category: rule.cat, reasoning: rule.reason };
    }
  }
  return {
    category: null,
    reasoning: 'No strong signal — review channel manually before assigning a category.',
  };
}

async function researchYoutube(rawUrl, info) {
  const targetUrl = info.kind === 'channelId'
    ? rawUrl
    : info.kind === 'handle'
    ? rawUrl
    : rawUrl; // /c/ and /user/ also work directly

  const { html, finalUrl } = await fetchHtml(targetUrl);

  // channelId — try multiple patterns
  let channelId = null;
  for (const re of [
    /"channelId":"(UC[\w-]{22})"/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
  ]) {
    const m = html.match(re);
    if (m) { channelId = m[1]; break; }
  }
  if (!channelId) {
    return { errors: ['could not extract channelId from page'] };
  }

  // handle — from canonical url or initial-data
  let handle = null;
  const handleMatch =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/(@[\w.-]+)"/) ||
    html.match(/"canonicalChannelUrl":"http:\\\/\\\/www\.youtube\.com\\\/(@[\w.-]+)"/) ||
    html.match(/"webCommandMetadata":\{"url":"\\?\/(@[\w.-]+)"/);
  if (handleMatch) handle = handleMatch[1];

  // ytInitialData
  const data = extractYtInitialData(html);

  let name = null;
  let description = null;
  let subs = null;
  let videoCount = null;
  let avatar = null;
  let banner = null;

  if (data) {
    // Channel header / metadata blocks shift between layouts; deep-search.
    const header = deepFind(data, (o) => o && (o.c4TabbedHeaderRenderer || o.pageHeaderRenderer || o.cinematicContainerRenderer));
    if (header?.c4TabbedHeaderRenderer) {
      const h = header.c4TabbedHeaderRenderer;
      name = pickFirst(h.title);
      subs = pickFirst(h.subscriberCountText?.simpleText, h.subscriberCountText?.runs?.[0]?.text);
      videoCount = pickFirst(h.videosCountText?.runs?.[0]?.text);
      avatar = pickFirst(h.avatar?.thumbnails?.slice(-1)?.[0]?.url);
      banner = pickFirst(h.banner?.thumbnails?.slice(-1)?.[0]?.url);
    } else if (header?.pageHeaderRenderer) {
      const h = header.pageHeaderRenderer;
      name = pickFirst(h.pageTitle);
      const view = h.content?.pageHeaderViewModel;
      avatar = pickFirst(view?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.[0]?.url);
      banner = pickFirst(view?.banner?.imageBannerViewModel?.image?.sources?.[0]?.url);
      const meta = view?.metadata?.contentMetadataViewModel?.metadataRows;
      if (Array.isArray(meta)) {
        for (const row of meta) {
          const parts = row?.metadataParts;
          if (!Array.isArray(parts)) continue;
          for (const p of parts) {
            const t = p?.text?.content;
            if (typeof t !== 'string') continue;
            if (/subscriber/i.test(t)) subs = t;
            else if (/video/i.test(t)) videoCount = t;
          }
        }
      }
    }

    // Description — meta tag fallback
    const descMatch = html.match(/<meta name="description" content="([^"]+)"/);
    if (descMatch) description = descMatch[1];

    // Recent videos — find videoRenderer blocks
    const recentBlocks = deepFindAll(data, (o) => o && (o.gridVideoRenderer || o.videoRenderer || o.richItemRenderer?.content?.videoRenderer));
    const recent = [];
    for (const block of recentBlocks) {
      const v = block.gridVideoRenderer || block.videoRenderer || block.richItemRenderer?.content?.videoRenderer;
      if (!v) continue;
      const title = pickFirst(v.title?.simpleText, v.title?.runs?.[0]?.text);
      const thumb = pickFirst(v.thumbnail?.thumbnails?.slice(-1)?.[0]?.url);
      const views = pickFirst(v.viewCountText?.simpleText, v.shortViewCountText?.simpleText, v.viewCountText?.runs?.[0]?.text);
      if (title) recent.push({ title, thumb: thumb ?? null, views: views ?? null });
      if (recent.length >= 3) break;
    }

    // og:image as avatar fallback
    if (!avatar) {
      const og = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (og) avatar = og[1];
    }

    // Numeric video count
    if (typeof videoCount === 'string') {
      const m = videoCount.match(/[\d,]+/);
      if (m) videoCount = parseInt(m[0].replace(/,/g, ''), 10);
    }

    const suggested = suggestYoutubeCategory({ name, description, recent });

    return {
      valid: true,
      platform: 'youtube',
      handle: handle ?? null,
      channelId,
      userId: null,
      name: name ?? null,
      subs: typeof subs === 'string' ? subs : null,
      videoCount: typeof videoCount === 'number' ? videoCount : null,
      description: description ?? null,
      avatar: avatar ?? null,
      banner: banner ?? null,
      recent,
      channelUrl: handle
        ? `https://www.youtube.com/${handle}`
        : `https://www.youtube.com/channel/${channelId}`,
      suggestedCategory: suggested.category,
      reasoning: suggested.reasoning,
      errors: [],
    };
  }

  // No initial-data parsable — return what we have
  return {
    valid: true,
    platform: 'youtube',
    handle: handle ?? null,
    channelId,
    userId: null,
    name: null,
    subs: null,
    videoCount: null,
    description: null,
    avatar: null,
    banner: null,
    recent: [],
    channelUrl: finalUrl,
    suggestedCategory: null,
    reasoning: 'Could not parse channel metadata — review manually.',
    errors: ['ytInitialData missing'],
  };
}

async function researchInstagram(rawUrl, info) {
  const username = info.username;
  const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  let userId = null;
  let name = null;
  let description = null;
  let avatar = null;
  let recent = [];
  const errors = [];

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': UA,
        'X-IG-App-ID': '936619743392459',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.ok) {
      const json = await res.json();
      const u = json?.data?.user;
      if (u) {
        userId = typeof u.id === 'string' ? u.id : null;
        name = pickFirst(u.full_name, username);
        description = pickFirst(u.biography);
        avatar = pickFirst(u.profile_pic_url_hd, u.profile_pic_url);
        const edges = u.edge_owner_to_timeline_media?.edges;
        if (Array.isArray(edges)) {
          for (const edge of edges.slice(0, 3)) {
            const node = edge?.node;
            if (!node) continue;
            const caption = pickFirst(
              node.edge_media_to_caption?.edges?.[0]?.node?.text,
            );
            recent.push({
              title: caption ? caption.slice(0, 80) : '(no caption)',
              thumb: pickFirst(node.thumbnail_src, node.display_url) ?? null,
              views: pickFirst(
                node.edge_liked_by?.count ? `${node.edge_liked_by.count} likes` : null,
              ),
            });
          }
        }
      } else {
        errors.push('IG profile JSON missing data.user');
      }
    } else {
      errors.push(`IG api → HTTP ${res.status}`);
    }
  } catch (e) {
    errors.push(`IG api fetch error: ${(e && e.message) || e}`);
  }

  // suggested category — IG signal is weaker; use bio + caption text
  const haystack = (
    (name || '') + ' ' + (description || '') + ' ' +
    recent.map((r) => r.title).join(' ')
  ).toLowerCase();
  let suggestedCategory = null;
  let reasoning = 'No strong signal from bio + recent captions.';
  if (/onlyfans|fansly|link in bio.*18\+|link in bio.*nsfw|spicy/i.test(haystack)) {
    suggestedCategory = 'onlyfans';
    reasoning = 'Bio or captions reference OnlyFans / link-in-bio-NSFW funnel.';
  } else if (/crypto|forex|guaranteed.*returns|10x|passive income/i.test(haystack)) {
    suggestedCategory = 'scam';
    reasoning = 'Bio or captions mention crypto / forex / "guaranteed returns".';
  } else if (errors.length === 0 && /^[\w\s.]+$/.test(name || '') && (description?.length ?? 0) < 30) {
    suggestedCategory = 'spam';
    reasoning = 'Bare bio + plain name suggests spam-bot account (low-confidence — verify manually).';
  }

  return {
    valid: true,
    platform: 'instagram',
    handle: username,
    channelId: null,
    userId,
    name,
    subs: null,
    videoCount: null,
    description,
    avatar,
    banner: null,
    recent,
    channelUrl: `https://www.instagram.com/${username}/`,
    suggestedCategory,
    reasoning,
    errors,
  };
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    emitError('', 'usage: node scripts/research.mjs <url>');
    process.exit(1);
  }

  const info = classifyUrl(url);
  if (!info.ok) {
    emitError(url, info.error);
    process.exit(0); // not a hard failure — just an invalid candidate
  }

  try {
    const result = info.platform === 'youtube'
      ? await researchYoutube(url, info)
      : await researchInstagram(url, info);
    if (!CATEGORIES.includes(result.suggestedCategory) && result.suggestedCategory !== null) {
      result.suggestedCategory = null;
    }
    emit(result);
  } catch (e) {
    emitError(url, `fetch failed: ${(e && e.message) || e}`);
  }
}

main();
