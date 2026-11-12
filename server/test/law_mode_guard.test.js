import test from 'node:test';
import assert from 'node:assert/strict';
import { streamTeachPipeline, teachPipeline, LAW_NO_TEXT_REPLY } from '../pipeline.js';
import { rateLimitWaitMs, streamGroq } from '../providers/groqProvider.js';
import { buildTeachingPrompt } from '../prompt/teacherPrompt.js';

const ARTICLE_21 = {
  title: 'Constitution of India — Article 21',
  url: 'https://legislative.gov.in/coi.pdf',
  domain: 'legislative.gov.in',
  kind: 'statute',
  label: 'Art.21',
  content: 'Article 21. No person shall be deprived of his life or personal liberty except according to procedure established by law.',
};

const groqStream = (...pieces) => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: piece }] })}\n\n`));
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  }),
});

const run = async ({ references, mode = 'law', fetchFn }) => {
  const tokens = [];
  let metadata = null;
  let done = null;
  await streamTeachPipeline(
    { text: 'How do Kubernetes pods work?', provider: 'hybrid', requestId: 'r1' },
    {
      onMetadata: (data) => { metadata = data; },
      onToken: (token) => tokens.push(token),
      onDone: (data) => { done = data; },
      options: { mode, GROQ_API_KEY: 'test-key', fetchFn, retrieveVerifiedReferences: async () => references },
    },
  );
  return { tokens, metadata, done };
};

test('LawBuddy with no official text never asks a model, and streams the fixed decline instead', async () => {
  const calls = [];
  const { tokens, metadata, done } = await run({
    references: [],
    fetchFn: async (url) => { calls.push(String(url)); return groqStream({ content: 'Kubernetes pods are…' }); },
  });
  assert.deepEqual(calls, [], 'no Groq, no Ollama');
  assert.equal(tokens.join(''), LAW_NO_TEXT_REPLY);
  assert.equal(metadata.groundingStatus, 'ungrounded');
  assert.equal(metadata.provider, 'lawbuddy');
  assert.equal(metadata.isHybrid, false);
  assert.equal(done.explanation, LAW_NO_TEXT_REPLY);
  assert.equal(done.provider, 'lawbuddy');

  const plain = await teachPipeline(
    { text: 'How do Kubernetes pods work?', provider: 'groq' },
    { mode: 'law', GROQ_API_KEY: 'test-key', fetchFn: async () => assert.fail('no model call'), retrieveVerifiedReferences: async () => [] },
  );
  assert.equal(plain.explanation, LAW_NO_TEXT_REPLY);
  assert.equal(plain.provider, 'lawbuddy');
});

test('missing cyber-law text yields a cyber-specific decline without calling a model', async () => {
  const references = [];
  Object.defineProperty(references, 'analysis', { value: { concepts: [{ id: 'unauthorised-security-testing' }] } });
  const { tokens, metadata, done } = await run({
    references,
    fetchFn: async () => assert.fail('no model call without official text'),
  });
  assert.equal(metadata.groundingStatus, 'ungrounded');
  assert.match(tokens.join(''), /sections 43 and 66 of the Information Technology Act/);
  assert.doesNotMatch(done.explanation, /Article 21|Kubernetes/);
});

test('cyber decline names only the provision still missing after a partial import', async () => {
  const references = [];
  Object.defineProperty(references, 'analysis', {
    value: {
      concepts: [{ id: 'unauthorised-security-testing' }],
      coverage: { status: 'unavailable', missing: [{ act: 'IT2000', label: 's.66' }] },
    },
  });
  const { done } = await run({ references, fetchFn: async () => assert.fail('no model call') });
  assert.match(done.explanation, /needs section 66 of the Information Technology Act/);
  assert.doesNotMatch(done.explanation, /sections 43 and 66/);
});

test('LawBuddy with official text still teaches through the model; plain DocVex is unchanged', async () => {
  const grounded = await run({
    references: [ARTICLE_21],
    fetchFn: async (url) => (String(url).includes('groq.com') ? groqStream({ content: 'Article 21 protects life.' }) : { ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(grounded.tokens.join(''), 'Article 21 protects life.');
  assert.equal(grounded.metadata.groundingStatus, 'grounded');
  assert.notEqual(grounded.metadata.provider, 'lawbuddy');

  const docvex = await run({
    mode: 'general',
    references: [],
    fetchFn: async (url) => (String(url).includes('groq.com') ? groqStream({ content: 'Pods share a network namespace.' }) : { ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(docvex.tokens.join(''), 'Pods share a network namespace.', 'DocVex still explains from general knowledge');
});

test('streamGroq retries an answer that arrives empty, and reports an error rather than an empty success', async () => {
  let attempts = 0;
  const tokens = [];
  const result = await streamGroq({
    prompt: 'p', apiKey: 'k', model: 'openai/gpt-oss-20b',
    fetchFn: async () => {
      attempts += 1;
      // First turn: only hidden reasoning, no visible content.
      return attempts === 1 ? groqStream({ reasoning: 'thinking…' }) : groqStream({ content: 'Visible answer.' });
    },
    onToken: (token) => tokens.push(token),
  });
  assert.equal(attempts, 2);
  assert.equal(result.explanation, 'Visible answer.');
  assert.deepEqual(tokens, ['Visible answer.']);

  await assert.rejects(
    streamGroq({ prompt: 'p', apiKey: 'k', model: 'm', fetchFn: async () => groqStream({ reasoning: '…' }) }),
    (error) => error.statusCode === 502 && /empty answer/.test(error.message),
  );
});

test('LawBuddy\'s question analysis sets the answer format and system prompt; the pipeline reports the check and critique', async () => {
  const references = Object.defineProperty([ARTICLE_21], 'analysis', {
    value: { kind: 'permission', concepts: [{ id: 'life', name: 'Right to life' }], direction: 'Answer under: What the law allows:' },
    enumerable: false,
  });
  const { userPrompt } = buildTeachingPrompt({ selectedText: 'Can I…?', evidence: references, mode: 'law', analysis: references.analysis });
  assert.match(userPrompt, /Answer under: What the law allows:/);
  assert.match(userPrompt, /NOT IN FORCE/, 'the legal cautions stay');

  let systemSeen = null;
  let bodySeen = null;
  const fetchFn = async (url, init) => {
    bodySeen = JSON.parse(init.body);
    systemSeen = bodySeen.messages[0].content;
    return groqStream({ content: 'Short answer: yes, within limits [Article 21].' });
  };
  let metadata = null;
  let done = null;
  await streamTeachPipeline(
    { text: 'Can I…?', provider: 'groq', requestId: 'r2' },
    {
      onMetadata: (data) => { metadata = data; },
      onDone: (data) => { done = data; },
      options: {
        mode: 'law', GROQ_API_KEY: 'k', fetchFn, retrieveVerifiedReferences: async () => references,
        systemPrompt: 'You are LawBuddy.', GROQ_MAX_TOKENS: 1800, GROQ_REASONING_EFFORT: 'low', GROQ_MODEL: 'openai/gpt-oss-120b',
        checkAnswer: (answer, evidence) => ({ answerLength: answer.length, evidence: evidence.length }),
        critiqueAnswer: async () => ({ model: 'critic', claims: [], flagged: 0 }),
      },
    },
  );
  assert.equal(systemSeen, 'You are LawBuddy.');
  assert.equal(bodySeen.max_tokens, 1800);
  assert.equal(bodySeen.reasoning_effort, 'low');
  assert.deepEqual(metadata.analysis, { kind: 'permission', concepts: [{ id: 'life', name: 'Right to life' }] });
  assert.deepEqual(done.check, { answerLength: 'Short answer: yes, within limits [Article 21].'.length, evidence: 1 });
  assert.equal(done.critique.model, 'critic');
});

test('a tokens-per-minute limit is waited out when Groq names a short wait, and reported plainly when it is long', async () => {
  assert.equal(rateLimitWaitMs({ headers: new Headers({ 'retry-after': '7' }) }, ''), 7000);
  assert.equal(rateLimitWaitMs({ headers: new Headers() }, 'Please try again in 34.88s. Need more tokens?'), 34880);
  assert.equal(rateLimitWaitMs({ headers: new Headers() }, 'try again in 1m2.5s'), 62500);
  assert.equal(rateLimitWaitMs({ headers: new Headers() }, 'busy'), null);

  let calls = 0;
  const limited = (seconds) => ({
    ok: false, status: 429, headers: new Headers(), json: async () => ({ error: { message: `Rate limit reached. Please try again in ${seconds}s.` } }),
  });
  const result = await streamGroq({
    prompt: 'p', apiKey: 'k', maxRateLimitWaitMs: 1000,
    fetchFn: async () => (++calls === 1 ? limited(0.05) : groqStream({ content: 'answer' })),
  });
  assert.equal(result.explanation, 'answer');
  assert.equal(calls, 2);
  await assert.rejects(
    () => streamGroq({ prompt: 'p', apiKey: 'k', maxRateLimitWaitMs: 1000, fetchFn: async () => limited(45) }),
    (error) => error.statusCode === 429 && /try again in about 45 seconds/.test(error.message),
  );
});
