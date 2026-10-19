import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ChatterboxProvider } from '../providers/chatterboxProvider.js';
import { getChatterboxProvider } from '../pipeline.js';

const createFakeWorker = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.say = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  return child;
};

const createProvider = (overrides = {}) => {
  const spawned = [];
  const clock = { t: 0 };
  const provider = new ChatterboxProvider({
    pythonPath: '/fake/python',
    workerPath: '/fake/docvex_worker.py',
    model: 'nano',
    tempDir: '/tmp/docvex-audio-test',
    startupTimeoutMs: 50,
    startupRetryCooldownMs: 60000,
    now: () => clock.t,
    spawnFn: () => {
      const child = createFakeWorker();
      spawned.push(child);
      return child;
    },
    ...overrides,
  });
  return { provider, spawned, clock };
};

test('a startup timeout reports the worker\'s last stderr lines and the cloud-sync hint', async () => {
  const { provider, spawned } = createProvider();
  const starting = provider.start();
  spawned[0].stderr.write('Loading torch...\nFetching 12 files: 0%|          | 0/12\n');
  await assert.rejects(starting, (error) => {
    assert.equal(error.code, 'CHATTERBOX_STARTUP_TIMEOUT');
    assert.match(error.message, /timed out after 0s/);
    assert.match(error.message, /cloud-synced folder/);
    assert.match(error.message, /Last worker output:\nLoading torch\.\.\.\nFetching 12 files/);
    return true;
  });
});

test('a model load failure fails startup at once with the worker\'s reason', async () => {
  const { provider, spawned } = createProvider({ startupTimeoutMs: 60000 });
  const starting = provider.start();
  spawned[0].stderr.write('Traceback (most recent call last):\nRuntimeError: MPS backend out of memory\n');
  spawned[0].say({ type: 'error', id: 'startup', code: 'LOAD_FAILED', error: 'MPS backend out of memory' });
  await assert.rejects(starting, (error) => {
    assert.equal(error.code, 'LOAD_FAILED');
    assert.match(error.message, /^Chatterbox model failed to load: MPS backend out of memory/);
    assert.match(error.message, /RuntimeError: MPS backend out of memory/);
    return true;
  });
});

test('after a failed start, synthesis fails fast during the cooldown instead of respawning per sentence', async () => {
  const { provider, spawned, clock } = createProvider();
  await assert.rejects(provider.start(), /timed out/);
  assert.equal(spawned.length, 1);

  for (const id of ['s1', 's2', 's3']) {
    await assert.rejects(provider.synthesize('A sentence.', { requestId: id }), /timed out/);
  }
  assert.equal(spawned.length, 1, 'no new worker per sentence while cooling down');

  clock.t = 60001;
  const retry = provider.start();
  assert.equal(spawned.length, 2, 'retries once the cooldown has passed');
  spawned[1].say({ type: 'ready', model: 'nano' });
  await retry;
  assert.equal(provider.isReady(), true);
});

test('a stale worker exiting late does not tear down its replacement', async () => {
  const { provider, spawned, clock } = createProvider();
  await assert.rejects(provider.start(), /timed out/);
  clock.t = 60001;

  const retry = provider.start();
  spawned[1].say({ type: 'ready', model: 'nano' });
  await retry;

  spawned[0].emit('exit', null, 'SIGTERM'); // the first worker finally dies after SIGTERM
  assert.equal(provider.isReady(), true, 'replacement worker is still current');

  const synthesis = provider.synthesize('Article twenty-one protects life.', { requestId: 'req-1' });
  await new Promise((resolve) => setImmediate(resolve));
  spawned[1].say({ type: 'audio', id: 'req-1', file: 'req-1.wav', sample_rate: 24000, duration_seconds: 1.2 });
  const audio = await synthesis;
  assert.equal(audio.fileName, 'req-1.wav');
  provider.stop();
});

test('getChatterboxProvider shares one worker per configuration across per-request option objects', () => {
  const settings = {
    CHATTERBOX_ENABLED: true,
    CHATTERBOX_PYTHON: '/fake/python',
    CHATTERBOX_WORKER: '/fake/docvex_worker.py',
    CHATTERBOX_MODEL: 'nano',
    CHATTERBOX_DEVICE: 'mps',
    CHATTERBOX_TEMP_DIR: '/tmp/docvex-audio-share-test',
  };
  const atBoot = getChatterboxProvider(settings);
  const perRequest = getChatterboxProvider({ ...settings, isFollowUp: false, mode: 'law' });
  assert.equal(perRequest, atBoot, 'a fresh options object per request must not spawn a new worker');

  assert.notEqual(getChatterboxProvider({ ...settings, CHATTERBOX_MODEL: 'turbo' }), atBoot, 'different model, different worker');
  assert.equal(getChatterboxProvider({ ...settings, CHATTERBOX_ENABLED: false }), null);
  const injected = {};
  assert.equal(getChatterboxProvider({ ...settings, chatterboxProvider: injected }), injected);
});
