import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeSpeechText, buildTeachingUserPrompt, TEACHER_SYSTEM_PROMPT } from '../prompt/teacherPrompt.js';
import { normalizeSpeechText } from '../prompt/speechNormalization.js';
import { callGroq } from '../providers/groqProvider.js';
import { callOllama } from '../providers/ollamaProvider.js';
import { generateExplanation } from '../providers/providerFactory.js';

test('shapeSpeechText strips URLs and cleans markdown formatting', () => {
  const raw = `
### Kubernetes Reconciliation
Here is the official documentation: https://kubernetes.io/docs/concepts/
- **Desired state**: Declared in YAML.
- *Actual state*: Running in cluster.
\`kubectl get pods\`
`;
  const spoken = shapeSpeechText(raw);

  assert.ok(!spoken.includes('https://'));
  assert.ok(!spoken.includes('###'));
  assert.ok(!spoken.includes('**'));
  assert.ok(!spoken.includes('`'));
  assert.ok(spoken.includes('Desired state'));
  assert.ok(spoken.includes('Actual state'));
});

test('buildTeachingUserPrompt builds comprehensive context', () => {
  const prompt = buildTeachingUserPrompt({
    text: 'A goroutine is a lightweight thread managed by the Go runtime.',
    title: 'Effective Go',
    url: 'https://go.dev/doc/effective_go',
    references: [
      { domain: 'go.dev', content: 'Goroutines run concurrently with other goroutines.' },
    ],
  });

  assert.ok(prompt.includes('A goroutine is a lightweight thread'));
  assert.ok(prompt.includes('Effective Go'));
  assert.ok(prompt.includes('https://go.dev/doc/effective_go'));
  assert.ok(prompt.includes('go.dev'));
  assert.ok(prompt.includes('Goroutines run concurrently'));
});

test('callGroq rejects missing API key with clear message', async () => {
  await assert.rejects(
    async () => {
      await callGroq({ prompt: 'Hello', apiKey: '' });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes('Groq API key is missing'));
      return true;
    }
  );
});

test('callOllama returns actionable error when host is unreachable', async () => {
  await assert.rejects(
    async () => {
      await callOllama({
        prompt: 'Test',
        host: 'http://127.0.0.1:59999', // Non-existent port
        timeoutMs: 1000,
      });
    },
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.ok(err.message.includes('Ollama is not running'));
      return true;
    }
  );
});

test('generateExplanation rejects unsupported providers', async () => {
  await assert.rejects(
    async () => {
      await generateExplanation({ prompt: 'Test', provider: 'unsupported-provider' });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes('Unsupported model provider'));
      return true;
    }
  );
});

test('normalizeSpeechText makes technical notation speakable without changing display text', () => {
  const displayText = 'Use O(n log n) with kubectl over HTTPS at C:\\Users\\dev.';
  const speechText = normalizeSpeechText(displayText);

  assert.equal(displayText, 'Use O(n log n) with kubectl over HTTPS at C:\\Users\\dev.');
  assert.match(speechText, /order of n log n/);
  assert.match(speechText, /kube control/);
  assert.match(speechText, /H T T P S/);
  assert.doesNotMatch(speechText, /C:\\Users/);
});
