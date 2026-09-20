import test from 'node:test';
import assert from 'node:assert/strict';
import { teachPipeline, streamTeachPipeline } from '../pipeline.js';
import { validateTeachInput } from '../server.js';
import { helpers } from '../config.js';

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

  // 1. Metadata emitted with isHybrid flag
  assert.equal(metadataEvents.length, 1);
  assert.equal(metadataEvents[0].isHybrid, true);
  assert.equal(metadataEvents[0].provider, 'hybrid');

  // 2. Tokens streamed in real-time from Groq
  assert.deepEqual(tokens, ['This ', 'is ', 'Groq ', 'voice.']);

  // 3. SpeechReady emitted once voice explanation finishes
  assert.equal(speechReadyEvents.length, 1);
  assert.equal(speechReadyEvents[0].explanation, 'This is Groq voice.');

  // 4. Background insights received from Ollama
  assert.equal(insightsEvents.length, 1);
  assert.ok(insightsEvents[0].insights.includes('Mental Model'));

  // 5. Done event contains both explanation and insights
  assert.ok(doneData);
  assert.equal(doneData.explanation, 'This is Groq voice.');
  assert.ok(doneData.insights.includes('Mental Model'));
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
  // Insights skipped gracefully with no uncaught errors
  assert.equal(insightsEvents.length, 0);
  assert.equal(doneData.insights, null);
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
