/**
 * Pre-fetch retrieval intelligence for DocVex.
 *
 * Decides HOW to get evidence before any fetch happens, so latency isn't
 * spent on selections that don't need it. Three outcomes instead of two:
 * - fast: use the current trusted page directly (zero external search calls).
 * - research: search allowlisted docs for substantial/technical off-allowlist text.
 * - none: skip retrieval for selections too trivial/ambiguous to justify a round trip.
 */

export function safeHostname(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Evaluates the retrieval strategy before making any network requests.
 *
 * @param {Object} params
 * @param {string} params.currentPageUrl
 * @param {string[]} params.allowlist - bare hostnames, e.g. "kubernetes.io"
 * @param {string} params.selectedText
 * @returns {{ path: 'fast'|'research'|'none', reason: string, searchExternally: boolean }}
 */
export function decideRetrievalPath({ currentPageUrl, allowlist = [], selectedText = '' }) {
  const currentDomain = safeHostname(currentPageUrl);
  const normalizedAllowlist = Array.isArray(allowlist) ? allowlist.map((d) => d.toLowerCase().replace(/^www\./, '')) : [];
  const onAllowlist = Boolean(currentDomain && normalizedAllowlist.some((allowed) => currentDomain === allowed || currentDomain.endsWith(`.${allowed}`)));

  // Fast path: already standing on a trusted page. Use it directly and
  // skip external search entirely — this is the path the 1-2s target
  // depends on, so nothing here touches external search.
  if (onAllowlist) {
    return {
      path: 'fast',
      reason: `current page (${currentDomain}) is on the allowlist`,
      searchExternally: false,
    };
  }

  // Off-allowlist: only search if the selection is substantial/technical
  // enough to be worth the latency and the risk of a low-quality result.
  const text = (selectedText || '').trim();
  const looksTechnical =
    /\b[A-Z]{2,}\b|\(\)|::|->|\.[a-z]+\(/.test(text) || text.length > 40;

  if (looksTechnical) {
    return {
      path: 'research',
      reason: 'off-allowlist page, selection looks technical enough to verify',
      searchExternally: true,
    };
  }

  return {
    path: 'none',
    reason: 'off-allowlist page, selection too short/ambiguous to justify a search',
    searchExternally: false,
  };
}
