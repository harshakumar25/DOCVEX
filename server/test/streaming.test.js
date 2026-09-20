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

test('POST /teach with stream: true emits SSE metadata, tokens, and done events', async () => {
  const dummyStreamHandler = async (data, { onMetadata, onToken, onDone }) => {
    onMetadata({
      requestId: data.requestId,
      sources: [{ title: 'Doc', url: 'https://kubernetes.io', domain: 'kubernetes.io' }],
      provider: 'test-provider',
      model: 'test-model',
    });

    onToken('First sentence here. ');
    onToken('Second sentence follows.');

    onDone({
      requestId: data.requestId,
      explanation: 'First sentence here. Second sentence follows.',
      speechFriendly: 'First sentence here. Second sentence follows.',
      sources: [{ title: 'Doc', url: 'https://kubernetes.io', domain: 'kubernetes.io' }],
      provider: 'test-provider',
      model: 'test-model',
    });
  };

  const { baseUrl, close } = await startTestServer({ streamTeachHandler: dummyStreamHandler });
  try {
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Explain Kubernetes pods in simple terms.',
        stream: true,
        requestId: 'req_test_123',
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const rawText = await res.text();
    assert.ok(rawText.includes('event: metadata'));
    assert.ok(rawText.includes('event: token'));
    assert.ok(rawText.includes('event: done'));
    assert.ok(rawText.includes('req_test_123'));
    assert.ok(rawText.includes('First sentence here. '));
    assert.ok(rawText.includes('Second sentence follows.'));
  } finally {
    await close();
  }
});

test('POST /teach streaming propagates error event cleanly', async () => {
  const errorStreamHandler = async (data, { onError }) => {
    const err = new Error('Model connection failed');
    err.statusCode = 502;
    onError(err);
  };

  const { baseUrl, close } = await startTestServer({ streamTeachHandler: errorStreamHandler });
  try {
    const res = await fetch(`${baseUrl}/teach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Explain Docker containers.',
        stream: true,
        requestId: 'req_err_999',
      }),
    });

    assert.equal(res.status, 200);
    const rawText = await res.text();
    assert.ok(rawText.includes('event: error'));
    assert.ok(rawText.includes('Model connection failed'));
    assert.ok(rawText.includes('req_err_999'));
  } finally {
    await close();
  }
});

test('SentenceBuffer handles malformed tokens and stream termination gracefully', () => {
  const received = [];
  const buffer = new SentenceBuffer({
    minSentenceLength: 5,
    onSentence: (s) => received.push(s),
  });

  // Pass malformed or non-string tokens
  buffer.addToken(null);
  buffer.addToken(undefined);
  buffer.addToken(123);
  buffer.addToken({});

  assert.equal(received.length, 0);

  // Add real text
  buffer.addToken('A container packages application code. ');
  assert.equal(received.length, 1);
  assert.equal(received[0], 'A container packages application code.');

  // Incomplete sentence before stream termination
  buffer.addToken('It ensures consistent execution across machines');
  assert.equal(received.length, 1); // Still buffered

  // Stream terminates -> flush
  buffer.flush();
  assert.equal(received.length, 2);
  assert.equal(received[1], 'It ensures consistent execution across machines');
});

test('Stale request protection drops out-of-order or late messages', () => {
  let activeRequestId = 'req_session_B';
  const acceptedSentences = [];

  const handleMessage = (msg) => {
    // Exact stale check used in content.js
    if (msg.requestId !== activeRequestId) {
      return; // Dropped
    }
    acceptedSentences.push(msg.data.sentence);
  };

  // Late message from previous session A
  handleMessage({ requestId: 'req_session_A', data: { sentence: 'Stale sentence from A' } });
  assert.equal(acceptedSentences.length, 0);

  // Message from current session B
  handleMessage({ requestId: 'req_session_B', data: { sentence: 'Active sentence from B' } });
  assert.equal(acceptedSentences.length, 1);
  assert.equal(acceptedSentences[0], 'Active sentence from B');

  // User starts new session C
  activeRequestId = 'req_session_C';
  handleMessage({ requestId: 'req_session_B', data: { sentence: 'Late sentence from B' } });
  assert.equal(acceptedSentences.length, 1); // Still only 1
});

test('Speech Queue correctly transitions through speaking, queued, paused, and stopped states', () => {
  const speechQueue = [];
  let isSpeaking = false;
  let isPaused = false;
  let currentSpeech = null;

  const mockSpeak = (sentence, index) => {
    speechQueue.push({ sentence, index });
    if (!isSpeaking) {
      isSpeaking = true;
      currentSpeech = speechQueue[0];
    }
  };

  const mockPause = () => {
    if (isSpeaking) {
      isPaused = true;
    }
  };

  const mockResume = () => {
    if (isPaused) {
      isPaused = false;
    }
  };

  const mockStop = () => {
    speechQueue.length = 0;
    isSpeaking = false;
    isPaused = false;
    currentSpeech = null;
  };

  // 1. Sentence 1 arrives -> starts speaking immediately
  mockSpeak('Sentence 1 begins speech.', 1);
  assert.equal(isSpeaking, true);
  assert.equal(isPaused, false);
  assert.equal(currentSpeech.sentence, 'Sentence 1 begins speech.');
  assert.equal(speechQueue.length, 1);

  // 2. Subsequent sentences arrive -> queued naturally
  mockSpeak('Sentence 2 is queued.', 2);
  mockSpeak('Sentence 3 is queued.', 3);
  assert.equal(speechQueue.length, 3);
  assert.equal(currentSpeech.sentence, 'Sentence 1 begins speech.');

  // 3. Pause
  mockPause();
  assert.equal(isPaused, true);
  assert.equal(isSpeaking, true);

  // 4. Resume
  mockResume();
  assert.equal(isPaused, false);

  // 5. Stop
  mockStop();
  assert.equal(isSpeaking, false);
  assert.equal(isPaused, false);
  assert.equal(speechQueue.length, 0);
  assert.equal(currentSpeech, null);
});

test('SSE chunk parser correctly reconstructs events split across TCP chunk boundaries', () => {
  const events = [];
  const parseSSE = (rawChunk, bufferRef) => {
    bufferRef.value += rawChunk;
    const parts = bufferRef.value.split('\n\n');
    bufferRef.value = parts.pop() || '';

    for (const part of parts) {
      const lines = part.split('\n');
      let event = 'message';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
      }
      if (dataStr) {
        events.push({ event, data: JSON.parse(dataStr) });
      }
    }
  };

  const buffer = { value: '' };

  // Packet 1: incomplete event
  parseSSE('event: token\nda', buffer);
  assert.equal(events.length, 0);

  // Packet 2: remainder of token event and start of next
  parseSSE('ta: {"token":"Hello "}\n\nevent: token\ndata: {"token":"World', buffer);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.token, 'Hello ');

  // Packet 3: end of World token and done event
  parseSSE('!"}\n\nevent: done\ndata: {"done":true}\n\n', buffer);
  assert.equal(events.length, 3);
  assert.equal(events[1].data.token, 'World!');
  assert.equal(events[2].event, 'done');
  assert.equal(events[2].data.done, true);
});
