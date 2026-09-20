import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { SentenceBuffer } from '../prompt/sentenceBuffer.js';

const startTestServer = async (options = {}) => {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, close };
};

test('Server actively aborts upstream model fetch when a newer request supersedes it', async () => {
  let requestAAborted = false;
  let requestBCompleted = false;

  const dummyStreamHandler = async (data, { signal, onToken, onDone }) => {
    if (data.requestId === 'req_A') {
      signal.addEventListener('abort', () => {
        requestAAborted = true;
      });
      // Simulate long model generation
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!signal.aborted) {
        onDone({ explanation: 'Done A' });
      }
    } else if (data.requestId === 'req_B') {
      requestBCompleted = true;
      onToken('B output');
      onDone({ explanation: 'Done B' });
    }
  };

  const { baseUrl, close } = await startTestServer({ streamTeachHandler: dummyStreamHandler });
  try {
    // 1. Fire Request A
    const reqAPromise = fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Long text A for teaching',
        stream: true,
        requestId: 'req_A',
      }),
    });

    // Small delay to ensure A is received and active on server
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requestAAborted, false, 'Request A should be running initially');

    // 2. Fire Request B while A is still in flight
    const resB = await fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Newer text B for teaching',
        stream: true,
        requestId: 'req_B',
      }),
    });

    assert.equal(resB.status, 200);
    assert.equal(requestBCompleted, true, 'Request B should complete successfully');

    // Request A must be actively aborted by server supersession
    assert.equal(requestAAborted, true, 'Request A upstream signal must have been aborted by supersession');

    const resA = await reqAPromise;
    assert.equal(resA.status, 200);
    const rawTextA = await resA.text();
    assert.ok(rawTextA.toLowerCase().includes('superseded') || rawTextA.toLowerCase().includes('aborted'));
  } finally {
    await close();
  }
});

test('SentenceBuffer clamps long sentences to <= maxUtteranceLength at clause boundaries', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    minSentenceLength: 10,
    maxUtteranceLength: 160,
    onSentence: (sentence) => emitted.push(sentence),
  });

  // A 280-character sentence with clause boundaries
  const longSentence =
    'Kubernetes pods represent the fundamental execution unit in a cluster, encapsulating one or more tightly coupled containers that share storage and network resources, while the kubelet agent ensures that all declared container specifications remain running continuously across worker nodes.';

  assert.ok(longSentence.length > 200, 'Test sentence must be over 200 chars to test clamping');

  buffer.addToken(longSentence);
  buffer.flush();

  assert.ok(emitted.length >= 2, 'Must be split into multiple safe chunks');

  // Verify that EVERY single emitted utterance is strictly <= 160 characters
  for (const utterance of emitted) {
    assert.ok(
      utterance.length <= 160,
      `Utterance length (${utterance.length}) must not exceed 160 chars: "${utterance}"`
    );
  }

  // Verify text continuity
  const joined = emitted.join(' ');
  assert.ok(joined.includes('Kubernetes pods represent'));
  assert.ok(joined.includes('remain running continuously'));
});
