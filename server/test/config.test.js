import test from 'node:test';
import assert from 'node:assert/strict';
import { config, helpers } from '../config.js';

test('config has valid default values', () => {
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(typeof config.PORT, 'number');
  assert.ok(config.PORT >= 1 && config.PORT <= 65535);
  assert.equal(typeof config.OLLAMA_HOST, 'string');
  assert.ok(config.OLLAMA_HOST.startsWith('http'));
  assert.equal(typeof config.OLLAMA_MODEL, 'string');
  assert.ok(config.OLLAMA_MODEL.length > 0);
  assert.equal(config.GROQ_MODEL, 'openai/gpt-oss-20b');
  assert.ok(['ollama', 'groq', 'hybrid'].includes(config.DEFAULT_PROVIDER));
  assert.ok(config.MAX_SELECTION_LENGTH > 0);
  assert.equal(config.CHATTERBOX_MAX_QUEUE, 30);
});

test('helpers.parsePort handles valid and invalid ports', () => {
  assert.equal(helpers.parsePort('8080'), 8080);
  assert.equal(helpers.parsePort('invalid', 3000), 3000);
  assert.equal(helpers.parsePort('-1', 3000), 3000);
  assert.equal(helpers.parsePort('99999', 3000), 3000);
});

test('helpers.parsePositiveInteger validates positive integers', () => {
  assert.equal(helpers.parsePositiveInteger('500', 100), 500);
  assert.equal(helpers.parsePositiveInteger('-5', 100), 100);
  assert.equal(helpers.parsePositiveInteger('abc', 100), 100);
  assert.equal(helpers.parsePositiveInteger('0', 100), 100);
});

test('helpers.parseProvider validates supported providers', () => {
  assert.equal(helpers.parseProvider('groq'), 'groq');
  assert.equal(helpers.parseProvider('GROQ'), 'groq');
  assert.equal(helpers.parseProvider('hybrid'), 'hybrid');
  assert.equal(helpers.parseProvider('HYBRID'), 'hybrid');
  assert.equal(helpers.parseProvider('ollama'), 'ollama');
  assert.equal(helpers.parseProvider('unknown', 'ollama'), 'ollama');
});
