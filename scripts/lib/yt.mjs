/**
 * YouTube channel resolution.
 *
 * Resolves @handle (or any channel URL) to its canonical UCxxxxxxxxxxxxxxxxxxxxxx
 * by parsing ytInitialData.metadata.channelMetadataRenderer.externalId — the
 * page-subject ID YouTube embeds for crawlers/RSS.
 *
 * Why not regex-match `"channelId":"UC..."` directly?
 * That string appears dozens of times per page (sidebar suggestions, related
 * creators, comment authors, recent collabs). The first hit is rarely the
 * page subject. ytInitialData.metadata is canonical and singular.
 *
 * Verification: cross-checks the resolved channel's vanityChannelUrl matches
 * the input handle. Mismatch → reject with explicit error so silent
 * misresolution becomes a loud failure.
 *
 * Verification limits: only catches *technical* misresolution (script returned
 * a channel with a different handle than input). It cannot detect handle
 * *squatting* — when YouTube's handle @x is legitimately registered to a
 * different person than the one the user wanted (e.g. @StableRonaldo → 1-sub
 * "Drizzy" account, while real StableRonaldo uses some other handle). The
 * caller must visually verify name + sub-count before adding to the blocklist.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function fetchYoutubeHtml(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

export function extractYtInitialData(html) {
  const m = html.match(/var ytInitialData = (\{.+?\});<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function getChannelMetadata(ytInitialData) {
  const meta = ytInitialData?.metadata?.channelMetadataRenderer;
  if (!meta) return null;
  return {
    channelId: meta.externalId ?? null,
    vanityChannelUrl: meta.vanityChannelUrl ?? null,
    title: meta.title ?? null,
    description: meta.description ?? null,
    keywords: meta.keywords ?? null,
  };
}

function extractHandleFromVanityUrl(vanityUrl) {
  if (!vanityUrl) return null;
  const m = vanityUrl.match(/\/(@[\w.-]+)$/);
  return m ? m[1] : null;
}

function normaliseHandle(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

/**
 * Resolve a handle (or channel URL) to its canonical channelId, with handle
 * verification.
 *
 * Returns: { channelId, vanityHandle, title } on success
 *          { error: string } on failure
 *
 * options.skipVerification — set true when the input is a channelId (no handle
 * to verify against) or when the caller intentionally wants the resolved page
 * regardless of handle drift.
 */
export async function resolveYouTubeChannel(input, options = {}) {
  const { skipVerification = false } = options;

  let url;
  let expectedHandle = null;
  if (/^https?:\/\//.test(input)) {
    url = input.replace(/\/+$/, '');
    const m = url.match(/\/(@[\w.-]+)(\/|$)/);
    if (m) expectedHandle = m[1];
  } else if (/^UC[\w-]{22}$/.test(input)) {
    url = `https://www.youtube.com/channel/${input}`;
  } else {
    const handle = normaliseHandle(input);
    if (!handle) return { error: 'empty input' };
    expectedHandle = handle;
    url = `https://www.youtube.com/${encodeURIComponent(handle)}`;
  }

  // /videos has a cleaner layout than /featured (less sidebar cross-promo)
  // and reliably emits ytInitialData.metadata.channelMetadataRenderer for
  // the page subject.
  const targetUrl = /\/videos$/.test(url) ? url : `${url}/videos`;

  let html;
  try {
    ({ html } = await fetchYoutubeHtml(targetUrl));
  } catch (e) {
    return { error: `fetch failed: ${(e && e.message) || e}` };
  }

  const data = extractYtInitialData(html);
  if (!data) return { error: 'ytInitialData missing — page layout changed?' };

  const meta = getChannelMetadata(data);
  if (!meta || !meta.channelId) {
    return { error: 'channelMetadataRenderer.externalId missing' };
  }
  if (!/^UC[\w-]{22}$/.test(meta.channelId)) {
    return { error: `unexpected externalId format: ${meta.channelId}` };
  }

  const vanityHandle = extractHandleFromVanityUrl(meta.vanityChannelUrl);

  if (!skipVerification && expectedHandle && vanityHandle) {
    if (expectedHandle.toLowerCase() !== vanityHandle.toLowerCase()) {
      return {
        error:
          `handle verification failed: input ${expectedHandle} resolved to ${vanityHandle} ` +
          `(externalId ${meta.channelId}). YouTube redirected to a different channel.`,
        suspectedChannelId: meta.channelId,
        actualHandle: vanityHandle,
      };
    }
  }

  return {
    channelId: meta.channelId,
    vanityHandle,
    title: meta.title,
    html, // expose so callers can do further parsing without re-fetching
    ytInitialData: data,
  };
}
