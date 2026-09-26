import test from 'node:test';
import assert from 'node:assert/strict';
import { callGroq, streamGroq } from '../providers/groqProvider.js';
import { streamTeachPipeline } from '../pipeline.js';

// ---------------------------------------------------------------------------
// callGroq retry tests
// ---------------------------------------------------------------------------

test('callGroq retries on 429 and succeeds on 3rd attempt', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    if (callCount <= 2) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Rate limit exceeded' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Retry success.' } }] }),
    };
  };

  const result = await callGroq({
    prompt: 'test prompt',
    apiKey: 'test-key',
    model: 'test-model',
    fetchFn: mockFetch,
  });

  assert.equal(result.explanation, 'Retry success.');
  assert.equal(callCount, 3, 'Should have made exactly 3 attempts (2 retries)');
});

test('callGroq retries on 503 and succeeds on 2nd attempt', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: { message: 'Service Unavailable' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Recovered.' } }] }),
    };
  };

  const result = await callGroq({
    prompt: 'test prompt',
    apiKey: 'test-key',
    model: 'test-model',
    fetchFn: mockFetch,
  });

  assert.equal(result.explanation, 'Recovered.');
  assert.equal(callCount, 2);
});

test('callGroq throws after exhausting all retries on persistent 503', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'Service Unavailable' } }),
    };
  };

  await assert.rejects(
    () => callGroq({ prompt: 'test', apiKey: 'test-key', model: 'test-model', fetchFn: mockFetch }),
    (err) => {
      assert.ok(err.message.includes('503') || err.message.toLowerCase().includes('overloaded') || err.message.includes('Groq API'));
      return true;
    }
  );

  assert.equal(callCount, 3, 'Should try 3 times (initial + 2 retries)');
});

test('callGroq does not retry on 401 unauthorized', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return { ok: false, status: 401, json: async () => ({}) };
  };

  await assert.rejects(
    () => callGroq({ prompt: 'test', apiKey: 'bad-key', model: 'test-model', fetchFn: mockFetch }),
    /Invalid Groq API key/
  );
  assert.equal(callCount, 1, 'Should not retry on 401');
});

// ---------------------------------------------------------------------------
// streamGroq retry tests
// ---------------------------------------------------------------------------

test('streamGroq retries on 429 and streams successfully on 2nd attempt', async () => {
  let callCount = 0;
  const tokens = [];

  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Rate limit' } }),
      };
    }
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Stream "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"success."}}]}\n\n',
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
  };

  const result = await streamGroq({
    prompt: 'test',
    apiKey: 'test-key',
    model: 'test-model',
    fetchFn: mockFetch,
    onToken: (t) => tokens.push(t),
  });

  assert.deepEqual(tokens, ['Stream ', 'success.']);
  assert.equal(result.explanation, 'Stream success.');
  assert.equal(callCount, 2);
});

// ---------------------------------------------------------------------------
// streamTeachPipeline Ollama fallback tests
// ---------------------------------------------------------------------------

test('streamTeachPipeline falls back to Ollama voice stream when Groq is overloaded', async () => {
  const tokens = [];
  let doneData = null;
  let onErrorCalled = false;

  const mockFetch = async (url) => {
    const urlStr = String(url);

    // Groq always returns 503 (exhausts all retries)
    if (urlStr.includes('groq.com')) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: { message: 'Service unavailable' } }),
      };
    }

    // Ollama provides the fallback voice explanation
    if (urlStr.includes('11434')) {
      const chunks = [
        '{"message":{"content":"Ollama fallback "},"done":false}\n',
        '{"message":{"content":"voice response."},"done":false}\n',
        '{"message":{"content":""},"done":true}\n',
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

    return { ok: true, status: 200 };
  };

  await streamTeachPipeline(
    { text: 'Explain event loops in Node.js.', provider: 'hybrid', requestId: 'fallback-test' },
    {
      options: {
        GROQ_API_KEY: 'test-key',
        fetchFn: mockFetch,
        retrieveVerifiedReferences: async () => [],
      },
      onToken: (t) => tokens.push(t),
      onDone: (data) => { doneData = data; },
      onError: () => { onErrorCalled = true; },
    }
  );

  // Should have received tokens from Ollama fallback
  assert.ok(tokens.length > 0, 'Should have received tokens from Ollama fallback');
  assert.ok(tokens.join('').includes('Ollama fallback'), 'Tokens should be from Ollama');

  // onDone must fire with fallback model identifier
  assert.ok(doneData, 'onDone must fire');
  assert.ok(doneData.model.includes('groq-fallback'), 'Model name should indicate groq-fallback');

  // onError must NOT fire — fallback is transparent to the user
  assert.equal(onErrorCalled, false, 'onError must not be called when Ollama fallback succeeds');
});
