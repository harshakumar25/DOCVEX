import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

const startTestServer = async (options = {}) => {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, close, port };
};

test('GET /api/system/stats returns complete system topology and telemetry', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/system/stats`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.status, 'ok');
    assert.equal(data.service, 'DocVex Local Tutor');
    assert.ok(typeof data.uptimeSeconds === 'number');
    assert.ok(typeof data.memoryMb === 'number');
    assert.ok(typeof data.config === 'object');
    assert.ok(typeof data.providers === 'object');
    assert.ok(typeof data.providers.ollama === 'object');
    assert.ok(typeof data.providers.groq === 'object');
  } finally {
    await close();
  }
});

test('GET /api/system/stats rejects forbidden external web origin with 403', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/system/stats`, {
      headers: { Origin: 'https://malicious-web-tracker.com' },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('GET /api/system/stats allows localhost origin and returns CORS headers', async () => {
  const { baseUrl, close, port } = await startTestServer();
  try {
    const localOrigin = `http://localhost:${port}`;
    const res = await fetch(`${baseUrl}/api/system/stats`, {
      headers: { Origin: localOrigin },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), localOrigin);
  } finally {
    await close();
  }
});

test('GET /api/retrieval/domains returns list of verified documentation domains', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/retrieval/domains`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.domains));
    assert.ok(data.count > 0);
    assert.ok(data.domains.includes('developer.mozilla.org'));
    assert.ok(data.domains.includes('kubernetes.io'));
    assert.ok(data.domains.includes('rust-lang.org'));
  } finally {
    await close();
  }
});

test('POST /api/cache/purge safely clears audio directory and reports stats', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'docvex-purge-test-'));
  const testWav1 = path.join(tempDir, 'sentence_1.wav');
  const testWav2 = path.join(tempDir, 'sentence_2.wav');
  await writeFile(testWav1, Buffer.from('RIFF_DUMMY_1'));
  await writeFile(testWav2, Buffer.from('RIFF_DUMMY_2'));

  const { baseUrl, close } = await startTestServer({
    CHATTERBOX_TEMP_DIR: tempDir,
  });

  try {
    const res = await fetch(`${baseUrl}/api/cache/purge`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.success, true);
    assert.equal(data.filesPurged, 2);
    assert.ok(data.bytesFreed > 0);
  } finally {
    await close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('GET /dashboard, /demo, and /demo.html serve HTML dashboard correctly', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/dashboard`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>'));

    const demoHtmlRes = await fetch(`${baseUrl}/demo.html`);
    assert.equal(demoHtmlRes.status, 200);
    assert.ok(demoHtmlRes.headers.get('content-type').includes('text/html'));

    const headRes = await fetch(`${baseUrl}/dashboard`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.ok(headRes.headers.get('content-type').includes('text/html'));
  } finally {
    await close();
  }
});

test('GET /api/system/stats allows IPv6 loopback [::1] origin with CORS headers', async () => {
  const { baseUrl, close, port } = await startTestServer();
  try {
    const ipv6Origin = `http://[::1]:${port}`;
    const res = await fetch(`${baseUrl}/api/system/stats`, {
      headers: { Origin: ipv6Origin },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ipv6Origin);
  } finally {
    await close();
  }
});

test('GET /manifest.webmanifest and /sw.js serve PWA offline assets', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.ok(manifestRes.headers.get('content-type').includes('application/manifest+json'));
    const manifest = await manifestRes.json();
    assert.equal(manifest.name, 'DocVex — Neumorphic Acoustic Tutor');
    assert.equal(manifest.display, 'standalone');

    const swRes = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.ok(swRes.headers.get('content-type').includes('application/javascript'));
    const swCode = await swRes.text();
    assert.ok(swCode.includes('docvex-shell-v1'));
  } finally {
    await close();
  }
});

