import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validateTeachInput } from '../server.js';

const startTestServer = async (options = {}) => {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, close };
};

test('validateTeachInput validation rules', () => {
  assert.equal(validateTeachInput(null).valid, false);
  assert.equal(validateTeachInput({}).valid, false);
  assert.equal(validateTeachInput({ text: '   ' }).valid, false);
  assert.equal(validateTeachInput({ text: 'Valid snippet' }).valid, true);
  assert.equal(validateTeachInput({ text: 'x'.repeat(101) }, 100).valid, false);
  assert.equal(validateTeachInput({ text: 'Valid', provider: 'invalid' }).valid, false);
  assert.equal(validateTeachInput({ text: 'Valid', provider: 'groq' }).valid, true);
});

test('GET /health returns 200 without wildcard CORS header for direct/extension clients', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    // Wildcard CORS must be null (not present)
    assert.equal(res.headers.get('access-control-allow-origin'), null);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'DocVex Local Tutor');
    assert.ok(typeof body.ollama === 'object');
    assert.ok(typeof body.ollama.running === 'boolean');
    assert.ok(typeof body.groq === 'object');
    assert.equal(body.groq.model, 'openai/gpt-oss-20b');
  } finally {
    await close();
  }
});

test('server blocks cross-origin requests from web pages with 403', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil-website.com' },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes('Cross-origin requests from web pages are forbidden'));
  } finally {
    await close();
  }
});

test('OPTIONS preflight from web pages is rejected with 403', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil-website.com' },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('OPTIONS preflight from chrome-extension origin returns 204 with matching origin', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const extOrigin = 'chrome-extension://abcdefghijklmnop';
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'OPTIONS',
      headers: { Origin: extOrigin },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), extOrigin);
  } finally {
    await close();
  }
});

test('POST /teach rejects empty or missing text with 400', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Select some text first.');
  } finally {
    await close();
  }
});

test('POST /teach rejects oversized selections with 400', async () => {
  const { baseUrl, close } = await startTestServer({ MAX_SELECTION_LENGTH: 50 });
  try {
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(60) }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('exceeds maximum allowed length'));
  } finally {
    await close();
  }
});

test('POST /teach accepts valid input and returns 200 with teaching result', async () => {
  const dummyHandler = async (data) => ({
    explanation: 'Teaching explanation for ' + data.text,
    speechFriendly: 'Speech friendly explanation',
    sources: [{ title: data.title, url: data.url, domain: 'kubernetes.io' }],
    provider: 'ollama',
    model: 'qwen3:4b',
  });

  const { baseUrl, close } = await startTestServer({ teachHandler: dummyHandler });
  try {
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Kubernetes uses a declarative approach.',
        title: 'Kubernetes Overview',
        url: 'https://kubernetes.io/docs/concepts/overview/',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.explanation.includes('Teaching explanation'));
    assert.equal(body.speechFriendly, 'Speech friendly explanation');
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].domain, 'kubernetes.io');
  } finally {
    await close();
  }
});

test('GET /unknown returns 404', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
