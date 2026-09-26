import test from 'node:test';
import assert from 'node:assert/strict';
import { SentenceBuffer } from '../prompt/sentenceBuffer.js';

test('SentenceBuffer emits complete sentence on boundary', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s) => emitted.push(s),
  });

  buffer.addToken('Kubernetes ');
  buffer.addToken('is an open ');
  buffer.addToken('source system. ');

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], 'Kubernetes is an open source system.');
});

test('SentenceBuffer buffers incomplete sentence and flushes on end', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s) => emitted.push(s),
  });

  buffer.addToken('First complete sentence. ');
  assert.equal(emitted.length, 1);

  buffer.addToken('Second sentence without period');
  assert.equal(emitted.length, 1); // Still 1 because no punctuation

  buffer.flush();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1], 'Second sentence without period');
});

test('SentenceBuffer avoids false splits on decimals and abbreviations', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s) => emitted.push(s),
  });

  // e.g. and 3.14 should not split early
  buffer.addToken('The constant pi is approx 3.14 e.g. for math. ');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], 'The constant pi is approx 3.14 e.g. for math.');
});

test('SentenceBuffer handles multiple sentences emitted in a single large chunk', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s) => emitted.push(s),
  });

  buffer.addToken('Sentence one is here. Sentence two follows it! And sentence three? ');
  assert.equal(emitted.length, 3);
  assert.equal(emitted[0], 'Sentence one is here.');
  assert.equal(emitted[1], 'Sentence two follows it!');
  assert.equal(emitted[2], 'And sentence three?');
});

test('SentenceBuffer preserves natural complete sentences up to default 360 chars without chopping', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s) => emitted.push(s),
  });

  const naturalSentence =
    'Kubernetes manages your containerized applications across a cluster by continuously comparing desired state against actual state and self-healing when containers fail. ';
  assert.ok(naturalSentence.length > 160 && naturalSentence.length < 360);

  buffer.addToken(naturalSentence);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], naturalSentence.trim());
});

test('SentenceBuffer emits pauseAfterMs=0 for intra-paragraph sentences', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s, idx, pauseAfterMs) => emitted.push({ s, pauseAfterMs }),
  });

  // Two sentences separated by a single space — no paragraph break
  buffer.addToken('First sentence here. Second sentence follows. ');

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].pauseAfterMs, 0);
  assert.equal(emitted[1].pauseAfterMs, 0);
});

test('SentenceBuffer emits pauseAfterMs=1000 when paragraph break follows sentence', () => {
  const emitted = [];
  const buffer = new SentenceBuffer({
    onSentence: (s, idx, pauseAfterMs) => emitted.push({ s, pauseAfterMs }),
  });

  // Sentence followed by a double newline (paragraph break), then a second sentence
  buffer.addToken('End of paragraph one.\n\nStart of paragraph two. ');

  assert.equal(emitted.length, 2);
  // First sentence has a paragraph break after it (1 sec pause)
  assert.equal(emitted[0].pauseAfterMs, 1000);
  // Second sentence has no break after it (0ms pause)
  assert.equal(emitted[1].pauseAfterMs, 0);
});

