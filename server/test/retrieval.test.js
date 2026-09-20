import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedDomain, DEFAULT_TRUSTED_DOMAINS } from '../retrieval/trustedSources.js';
import {
  extractSearchQuery,
  sanitizeHtmlToText,
  shouldRetrieveReferences,
  retrieveVerifiedReferences,
} from '../retrieval/referenceEngine.js';

test('isTrustedDomain correctly identifies allowlisted and non-allowlisted domains', () => {
  assert.equal(isTrustedDomain('https://kubernetes.io/docs/concepts/'), true);
  assert.equal(isTrustedDomain('https://developer.mozilla.org/en-US/docs/Web/API'), true);
  assert.equal(isTrustedDomain('https://docs.python.org/3/library/asyncio.html'), true);
  assert.equal(isTrustedDomain('https://subdomain.docs.docker.com/'), true);

  // Non-allowlisted domains must be rejected
  assert.equal(isTrustedDomain('https://medium.com/@user/article'), false);
  assert.equal(isTrustedDomain('https://reddit.com/r/programming'), false);
  assert.equal(isTrustedDomain('https://random-unverified-blog.org'), false);
  assert.equal(isTrustedDomain('not-a-valid-url'), false);
  assert.equal(isTrustedDomain(''), false);
});

test('extractSearchQuery extracts concise keywords and discards stop words', () => {
  const query = extractSearchQuery(
    'Kubernetes uses a declarative approach to reconcile desired state with actual state.',
    'Kubernetes Overview'
  );
  assert.ok(query.includes('kubernetes'));
  assert.ok(!query.includes('with'));
  assert.ok(!query.includes('the'));
});

test('sanitizeHtmlToText strips tags, scripts, and entities', () => {
  const rawHtml = `
    <div>
      <script>console.log('danger')</script>
      <style>body { color: red; }</style>
      <h1>Kubernetes &amp; Containers</h1>
      <p>Continuous &lt;reconciliation&gt; loop.</p>
    </div>
  `;
  const clean = sanitizeHtmlToText(rawHtml);
  assert.ok(!clean.includes('<script>'));
  assert.ok(!clean.includes('danger'));
  assert.ok(!clean.includes('color: red'));
  assert.ok(clean.includes('Kubernetes & Containers'));
  assert.ok(clean.includes('Continuous <reconciliation> loop.'));
});

test('shouldRetrieveReferences filters out trivial selections', () => {
  assert.equal(shouldRetrieveReferences(''), false);
  assert.equal(shouldRetrieveReferences('hello'), false);
  assert.equal(shouldRetrieveReferences('short note'), false);
  assert.equal(
    shouldRetrieveReferences('TCP provides reliable and ordered delivery using sequence numbers.'),
    true
  );
});

test('retrieveVerifiedReferences handles current authoritative page URL and network gracefully', async () => {
  const references = await retrieveVerifiedReferences({
    text: 'A Pod is the smallest execution unit in Kubernetes.',
    title: 'Pod Lifecycle',
    url: 'https://kubernetes.io/docs/concepts/workloads/pods/',
    timeoutMs: 500, // Short timeout to test graceful completion
  });

  assert.ok(Array.isArray(references));
  // Since the user URL was an allowlisted domain, it should be captured as an authoritative source
  const hasK8sSource = references.some((r) => r.domain === 'kubernetes.io');
  assert.ok(hasK8sSource);
});
