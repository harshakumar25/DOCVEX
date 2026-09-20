/**
 * Curated allowlist of authoritative technical documentation and specifications.
 * Non-allowlisted domains are strictly excluded from verified reference retrieval.
 */

export const DEFAULT_TRUSTED_DOMAINS = Object.freeze([
  // Web & Browser Standards
  'developer.mozilla.org',
  'w3.org',
  'tc39.es',
  'whatwg.org',

  // Cloud & Containers
  'kubernetes.io',
  'docs.docker.com',
  'docs.aws.amazon.com',
  'learn.microsoft.com',
  'cloud.google.com',
  'developer.hashicorp.com',

  // Protocols & Networking
  'ietf.org',
  'rfc-editor.org',
  'owasp.org',

  // Languages & Core Runtimes
  'docs.python.org',
  'nodejs.org',
  'dev.java',
  'docs.oracle.com',
  'go.dev',
  'rust-lang.org',
  'react.dev',
  'git-scm.com',
  'postgresql.org',
  'redis.io',
  'kernel.org',
]);

/**
 * Checks if a given URL or hostname belongs to the trusted domain allowlist.
 */
export const isTrustedDomain = (urlStringOrHost, customAllowlist = DEFAULT_TRUSTED_DOMAINS) => {
  if (!urlStringOrHost || typeof urlStringOrHost !== 'string') return false;

  let hostname = urlStringOrHost.trim().toLowerCase();

  try {
    if (hostname.includes('://')) {
      const parsed = new URL(hostname);
      hostname = parsed.hostname.toLowerCase();
    }
  } catch {
    return false;
  }

  // Remove port if present
  hostname = hostname.split(':')[0];

  return customAllowlist.some((trusted) => {
    const cleanTrusted = trusted.toLowerCase().trim();
    return hostname === cleanTrusted || hostname.endsWith(`.${cleanTrusted}`);
  });
};
