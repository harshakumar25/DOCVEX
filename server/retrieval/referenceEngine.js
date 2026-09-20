import { DEFAULT_TRUSTED_DOMAINS, isTrustedDomain } from './trustedSources.js';
import { decideRetrievalPath, safeHostname } from './retrievalIntelligence.js';

export { decideRetrievalPath, safeHostname };

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'let', 'me', 'more',
  'most', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your',
]);

/**
 * Extracts a concise technical search query (3 to 6 words) from selected text and title.
 */
export const extractSearchQuery = (text, title = '') => {
  const combined = `${title} ${text}`.toLowerCase();
  const words = combined
    .replace(/[^a-zA-Z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const uniqueWords = Array.from(new Set(words));
  const query = uniqueWords.slice(0, 5).join(' ');
  return query || 'technical documentation';
};

/**
 * Strips HTML tags, scripts, styles, and decodes basic entities into safe plain text.
 */
export const sanitizeHtmlToText = (html, maxLength = 1500) => {
  if (!html || typeof html !== 'string') return '';

  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Normalize spacing
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxLength) {
    return text.slice(0, maxLength) + '...';
  }

  return text;
};

/**
 * Determines whether the selection warrants external reference retrieval.
 */
export const shouldRetrieveReferences = (text) => {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  // Don't retrieve for trivial one-word or non-technical conversational phrases
  if (trimmed.length < 20) return false;
  return true;
};

/**
 * Searches and fetches authoritative references using pre-fetch retrieval triage.
 * - 'fast': Zero network calls; leverages current allowlisted page content.
 * - 'research': Scoped allowlist search with a strict 2.5s timeout.
 * - 'none': Immediate empty return with zero latency.
 */
export const retrieveVerifiedReferences = async ({
  text,
  title = '',
  url = '',
  pageContext = '',
  allowlist = DEFAULT_TRUSTED_DOMAINS,
  maxSources = 3,
  timeoutMs = 2500,
}) => {
  const decision = decideRetrievalPath({
    currentPageUrl: url,
    allowlist,
    selectedText: text,
  });

  if (decision.path === 'none') {
    return [];
  }

  if (decision.path === 'fast') {
    const domain = safeHostname(url);
    const content = pageContext && pageContext.trim()
      ? sanitizeHtmlToText(pageContext, 1500)
      : `Official documentation context from ${title || domain} (${url})`;

    return [
      {
        url,
        domain: domain || 'official-doc',
        title: title || domain || 'Current Authoritative Page',
        content,
        retrievedAt: new Date().toISOString(),
      },
    ];
  }

  // decision.path === 'research'
  const results = [];
  const query = extractSearchQuery(text, title);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!searchRes.ok) {
      return [];
    }

    const html = await searchRes.text();
    const linkRegex = /<a\s+(?:[^>]*?\s+)?href="([^"]*uddg=([^"&]+)[^"]*|https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null && results.length < maxSources) {
      let rawHref = match[2] ? decodeURIComponent(match[2]) : match[1];
      let linkTitle = sanitizeHtmlToText(match[3] || '');

      if (rawHref && isTrustedDomain(rawHref, allowlist)) {
        try {
          const parsed = new URL(rawHref);
          if (!results.some((r) => r.url === rawHref)) {
            results.push({
              url: rawHref,
              domain: parsed.hostname,
              title: linkTitle || parsed.hostname,
              content: `Official reference on ${parsed.hostname} regarding ${query}`,
              retrievedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Ignore invalid URL
        }
      }
    }
  } catch {
    // Graceful fallback on network failure or timeout
  }

  return results.slice(0, maxSources);
};
