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
