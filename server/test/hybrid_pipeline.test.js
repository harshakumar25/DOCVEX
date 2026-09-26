import test from 'node:test';
import assert from 'node:assert/strict';
import { teachPipeline, streamTeachPipeline } from '../pipeline.js';
import { validateTeachInput } from '../server.js';
import { helpers } from '../config.js';
import { buildReasoningPrompt } from '../prompt/reasoningPrompt.js';
import { buildTeachingPrompt } from '../prompt/teacherPrompt.js';

test('validateTeachInput accepts hybrid provider', () => {
  const res = validateTeachInput({ text: 'Test code explanation', provider: 'hybrid' });
  assert.equal(res.valid, true);
  assert.equal(res.data.provider, 'hybrid');
});

test('helpers.parseProvider parses hybrid correctly', () => {
  assert.equal(helpers.parseProvider('hybrid'), 'hybrid');
  assert.equal(helpers.parseProvider('HYBRID'), 'hybrid');
});

test('streamTeachPipeline in hybrid mode coordinates voice streaming and background insights', async () => {
  const metadataEvents = [];
  const tokens = [];
  const speechReadyEvents = [];
  const insightsEvents = [];
  let doneData = null;

  const createMockFetch = () => {
    return async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('groq.com')) {
        const sseChunks = [
          'data: {"choices":[{"delta":{"content":"This "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"is "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Groq "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"voice."}}]}\n\n',
          'data: [DONE]\n\n',
        ];
        let idx = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (idx < sseChunks.length) {
              controller.enqueue(new TextEncoder().encode(sseChunks[idx++]));
            } else {
              controller.close();
            }
          },
        });
        return {
          ok: true,
          status: 200,
          body: stream,
        };
      }

      if (urlStr.includes('11434')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: '### 🧠 Mental Model\nIntuitive abstraction.\n\n### ⚠️ Critical Gotchas\nWatch out for race conditions.\n\n### 📋 Executive Summary\n- Bullet 1\n- Bullet 2',
            },
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({}) };
    };
  };

  const mockOptions = {
    GROQ_API_KEY: 'test-groq-api-key',
    GROQ_MODEL: 'test-groq-model',
    OLLAMA_MODEL: 'test-ollama-model',
    fetchFn: createMockFetch(),
    retrieveVerifiedReferences: async () => [
      { title: 'Node.js Docs', url: 'https://nodejs.org/docs', domain: 'nodejs.org' },
    ],
  };

  const result = await streamTeachPipeline(
    {
      text: 'Synchronous execution blocks the event loop.',
      title: 'Node.js Docs',
      url: 'https://nodejs.org/docs',
      provider: 'hybrid',
      requestId: 'req_test_123',
    },
    {
      onMetadata: (data) => metadataEvents.push(data),
      onToken: (t) => tokens.push(t),
      onSpeechReady: (data) => speechReadyEvents.push(data),
      onInsights: (data) => insightsEvents.push(data),
      onDone: (data) => {
        doneData = data;
      },
      options: mockOptions,
    }
  );

  // Since onInsights fires asynchronously after onDone (fire-and-forget), wait for it
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 1. Metadata emitted with isHybrid flag
  assert.equal(metadataEvents.length, 1);
  assert.equal(metadataEvents[0].isHybrid, true);
  assert.equal(metadataEvents[0].provider, 'hybrid');

  // 2. Tokens streamed in real-time from Groq
  assert.deepEqual(tokens, ['This ', 'is ', 'Groq ', 'voice.']);

  // 3. SpeechReady emitted once voice explanation finishes
  assert.equal(speechReadyEvents.length, 1);
  assert.equal(speechReadyEvents[0].explanation, 'This is Groq voice.');

  // 4. Background insights received from Ollama (async, arrives after done)
  assert.equal(insightsEvents.length, 1);
  assert.ok(insightsEvents[0].insights.includes('Mental Model'));

  // 5. Done fires immediately after Groq — insights no longer bundled in done
  assert.ok(doneData);
  assert.equal(doneData.explanation, 'This is Groq voice.');
  assert.equal(result.provider, 'hybrid');
});

test('streamTeachPipeline in hybrid mode gracefully succeeds if Ollama is offline', async () => {
  const tokens = [];
  const speechReadyEvents = [];
  const insightsEvents = [];
  let doneData = null;

  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('groq.com')) {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Resilient "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"audio."}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      let idx = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (idx < sseChunks.length) {
            controller.enqueue(new TextEncoder().encode(sseChunks[idx++]));
          } else {
            controller.close();
          }
        },
      });
      return {
        ok: true,
        status: 200,
        body: stream,
      };
    }

    if (urlStr.includes('11434')) {
      const err = new Error('ECONNREFUSED 127.0.0.1:11434');
      err.code = 'ECONNREFUSED';
      throw err;
    }

    return { ok: true, status: 200 };
  };

  const mockOptions = {
    GROQ_API_KEY: 'test-groq-api-key',
    fetchFn: mockFetch,
    retrieveVerifiedReferences: async () => [],
  };

  const result = await streamTeachPipeline(
    {
      text: 'Resilience test snippet',
      provider: 'hybrid',
      requestId: 'req_resilience_456',
    },
    {
      onMetadata: () => {},
      onToken: (t) => tokens.push(t),
      onSpeechReady: (data) => speechReadyEvents.push(data),
      onInsights: (data) => insightsEvents.push(data),
      onDone: (data) => {
        doneData = data;
      },
      options: mockOptions,
    }
  );

  // Groq speech still succeeded completely
  assert.deepEqual(tokens, ['Resilient ', 'audio.']);
  assert.equal(speechReadyEvents.length, 1);
  // Insights skipped gracefully with no uncaught errors; onInsights never fired
  assert.equal(insightsEvents.length, 0);
  // onDone no longer includes insights — it fires immediately after Groq completes
  assert.equal(doneData.insights, undefined);
  assert.equal(result.explanation, 'Resilient audio.');
});

test('teachPipeline executes complete flow in hybrid mode', async () => {
  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('groq.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Groq explanation of concepts.' } }],
        }),
      };
    }

    if (urlStr.includes('11434')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '### 🧠 Mental Model\nOllama deep mental model.' },
        }),
      };
    }

    return { ok: true, status: 200 };
  };

  const mockOptions = {
    GROQ_API_KEY: 'test-groq-api-key',
    fetchFn: mockFetch,
    retrieveVerifiedReferences: async () => [],
  };

  const result = await teachPipeline(
    {
      text: 'Understanding event loops',
      provider: 'hybrid',
    },
    mockOptions
  );

  assert.equal(result.provider, 'hybrid');
  assert.ok(result.explanation.includes('Groq explanation'));
  assert.ok(result.insights.includes('Ollama deep mental model'));
});

test('streamTeachPipeline sends meaningful sentences through the optional Chatterbox provider', async () => {
  const audioEvents = [];
  const fakeChatterbox = {
    start: async () => {},
    synthesize: async (speechText, { requestId }) => ({
      fileName: `${requestId}.wav`,
      filePath: `/tmp/${requestId}.wav`,
      sampleRate: 24000,
      durationSeconds: 2,
      generatedAudioAvailableSeconds: 0.2,
      model: 'test-nano',
      speechText,
    }),
  };

  const mockFetch = async (url) => {
    if (String(url).includes('groq.com')) {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"The main idea is that Kubernetes keeps the running system aligned with the desired state. "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"It repeatedly compares reality with the declaration and makes corrective changes."}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      let index = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
          else controller.close();
        },
      });
      return { ok: true, status: 200, body: stream };
    }
    if (String(url).includes('11434')) {
      return { ok: true, status: 200, json: async () => ({ message: { content: 'Background insight.' } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await streamTeachPipeline(
    { text: 'Kubernetes desired state', provider: 'hybrid', requestId: 'audio-test' },
    {
      options: {
        GROQ_API_KEY: 'test-key',
        fetchFn: mockFetch,
        retrieveVerifiedReferences: async () => [],
        chatterboxProvider: fakeChatterbox,
      },
      onToken: () => {},
      onAudioReady: (data) => audioEvents.push(data),
      onAudioError: (data) => audioEvents.push({ error: data.error }),
    }
  );

  assert.equal(audioEvents.length, 2);
  assert.equal(audioEvents[0].model, 'test-nano');
  assert.match(audioEvents[0].speechText, /Kubernetes/);
  assert.ok(audioEvents.every((event) => !event.error));
});

test('buildReasoningPrompt caps input text and evidence to prevent Ollama CoT hang on large text', () => {
  const hugeText = 'A'.repeat(5000);
  const prompt = buildReasoningPrompt({
    selectedText: hugeText,
    pageTitle: 'Test Page',
    evidence: [{ domain: 'docs.test', content: 'E'.repeat(2000) }],
  });

  // Must truncate with head + tail marker
  assert.ok(prompt.includes('[... truncated ...]'));
  // Must cap evidence to 500 chars per source
  assert.ok(!prompt.includes('E'.repeat(600)));
  // The selected technical passage portion should be significantly smaller than 5000 chars
  const passageMatch = prompt.match(/Selected Technical Passage:\n"""\n([\s\S]*?)\n"""/);
  assert.ok(passageMatch);
  assert.ok(passageMatch[1].length < 1300);
});

test('buildTeachingPrompt caps selectedText at MAX_TEACH_CHARS for fast Groq streaming', () => {
  const hugeText = 'B'.repeat(8000);
  const prompt = buildTeachingPrompt({
    selectedText: hugeText,
    pageUrl: 'https://example.com',
    pageTitle: 'Example',
    evidence: [],
  });

  assert.ok(prompt.userPrompt.includes('[...text truncated for response speed...]'));
  assert.ok(!prompt.userPrompt.includes('B'.repeat(5000)));
});

test('streamTeachPipeline fires onDone immediately without waiting for slow Ollama background task', async () => {
  let ollamaResolved = false;
  let onDoneFired = false;
  let onDoneFiredBeforeOllama = false;

  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('groq.com')) {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Groq fast response."}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      let i = 0;
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          pull(controller) {
            if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]));
            else controller.close();
          },
        }),
      };
    }

    if (urlStr.includes('11434')) {
      // Simulate slow Ollama (e.g. 150ms delay)
      await new Promise((resolve) => setTimeout(resolve, 150));
      ollamaResolved = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '### 🧠 Mental Model\nSlow background insight.' },
        }),
      };
    }

    return { ok: true, status: 200 };
  };

  const insightsEvents = [];

  await streamTeachPipeline(
    {
      text: 'Technical text with enough characters to trigger Ollama background reasoning.',
      provider: 'hybrid',
      requestId: 'test_slow_ollama',
    },
    {
      options: {
        GROQ_API_KEY: 'test-key',
        fetchFn: mockFetch,
        retrieveVerifiedReferences: async () => [],
      },
      onToken: () => {},
      onDone: () => {
        onDoneFired = true;
        if (!ollamaResolved) {
          onDoneFiredBeforeOllama = true;
        }
      },
      onInsights: (data) => {
        insightsEvents.push(data);
      },
    }
  );

  // onDone must have fired while Ollama was still in progress
  assert.equal(onDoneFired, true);
  assert.equal(onDoneFiredBeforeOllama, true);

  // Wait for the background Ollama to complete
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ollamaResolved, true);
  assert.equal(insightsEvents.length, 1);
  assert.ok(insightsEvents[0].insights.includes('Slow background insight'));
});
