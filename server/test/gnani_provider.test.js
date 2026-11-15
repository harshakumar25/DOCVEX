import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { GnaniProvider } from '../providers/gnaniProvider.js';

const createValidWavBuffer = (sampleRate = 24000, numSamples = 24000) => {
  const dataSize = numSamples * 2;
  const totalSize = 44 + dataSize;
  const buf = Buffer.alloc(totalSize);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(0xFFFFFFFF, 4); // streaming flag to be patched
  buf.write('WAVE', 8);

  // fmt subchunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // subchunk1 size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample

  // data subchunk
  buf.write('data', 36);
  buf.writeUInt32LE(0xFFFFFFFF, 40); // streaming flag to be patched
  return buf;
};

test('GnaniProvider validates required API key on construction', () => {
  assert.throws(() => new GnaniProvider({ apiKey: '' }), {
    message: /Gnani API key is required/,
  });
  assert.throws(() => new GnaniProvider({ apiKey: '   ' }), {
    message: /Gnani API key is required/,
  });
});

test('GnaniProvider.fromConfig derives properties and cache keys cleanly', () => {
  const options = {
    GNANI_API_KEY: 'vach_test_key_123',
    GNANI_VOICE: 'Deepak',
    GNANI_MODEL: 'timbre-v2.5',
    GNANI_LANGUAGE: 'en-IN',
    GNANI_SPEED: 1.1,
    GNANI_TARGET_SR: 24000,
  };

  const provider = GnaniProvider.fromConfig(options);
  assert.equal(provider.apiKey, 'vach_test_key_123');
  assert.equal(provider.voice, 'Deepak');
  assert.equal(provider.model, 'timbre-v2.5');
  assert.equal(provider.language, 'en-IN');
  assert.equal(provider.speed, 1.1);
  assert.equal(provider.targetSampleRate, 24000);
  assert.equal(provider.modelString, 'gnani:timbre-v2.5:Deepak');
  assert.equal(provider.isReady(), true);

  const key1 = GnaniProvider.cacheKey(options);
  const key2 = GnaniProvider.cacheKey({ ...options, extraField: 'ignored' });
  assert.equal(key1, key2);

  const key3 = GnaniProvider.cacheKey({ ...options, GNANI_VOICE: 'Nalini' });
  assert.notEqual(key1, key3);
});

test('GnaniProvider synthesize succeeds, patches WAV headers, and calculates duration', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnani-test-'));
  const dummyWav = createValidWavBuffer(24000, 48000); // 2 seconds of 24kHz audio

  let receivedUrl = '';
  let receivedHeaders = {};
  let receivedBody = null;

  const mockFetch = async (url, init) => {
    receivedUrl = url;
    receivedHeaders = init.headers;
    receivedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => dummyWav.buffer.slice(dummyWav.byteOffset, dummyWav.byteOffset + dummyWav.byteLength),
    };
  };

  const provider = new GnaniProvider({
    apiKey: 'vach_test_key_123',
    tempDir,
    fetchFn: mockFetch,
    voice: 'Deepak',
  });

  const result = await provider.synthesize('Welcome to DocVex with high-speed voiceover.', {
    requestId: 'req-test-1',
  });

  assert.equal(receivedUrl, 'https://api.vachana.ai/api/v1/tts/inference');
  assert.equal(receivedHeaders['X-API-Key-ID'], 'vach_test_key_123');
  assert.equal(receivedBody.voice, 'Deepak');
  assert.equal(receivedBody.model, 'timbre-v2.5');
  assert.equal(receivedBody.audio_config?.container, 'wav');
  assert.equal(receivedBody.audio_config?.sample_rate, 24000);

  assert.ok(result.fileName.startsWith('gnani-req-test-1-'));
  assert.equal(result.sampleRate, 24000);
  assert.equal(result.durationSeconds, 2.0);
  assert.equal(result.provider, 'gnani');

  // Verify file was written and headers patched
  const writtenBuf = await fs.readFile(result.filePath);
  assert.equal(writtenBuf.readUInt32LE(4), dummyWav.length - 8);
  assert.equal(writtenBuf.readUInt32LE(40), dummyWav.length - 44);

  // Clean up
  await provider.cleanupAudio(result.fileName);
  await assert.rejects(async () => fs.stat(result.filePath));
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('GnaniProvider maps HTTP 401/403 and 429 into typed provider errors', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnani-err-'));

  const authFailFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: 'Invalid API Key' }),
  });

  const authProvider = new GnaniProvider({
    apiKey: 'invalid_key',
    tempDir,
    fetchFn: authFailFetch,
  });

  await assert.rejects(
    async () => authProvider.synthesize('Test text', { requestId: 'req-auth' }),
    (err) => {
      assert.equal(err.code, 'GNANI_AUTH_FAILED');
      assert.equal(err.statusCode, 502);
      assert.match(err.message, /authentication error/i);
      return true;
    }
  );

  const rateLimitFetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ message: 'Too many requests' }),
  });

  const rateProvider = new GnaniProvider({
    apiKey: 'rate_limited_key',
    tempDir,
    fetchFn: rateLimitFetch,
  });

  await assert.rejects(
    async () => rateProvider.synthesize('Test text', { requestId: 'req-rate' }),
    (err) => {
      assert.equal(err.code, 'GNANI_RATE_LIMITED');
      assert.equal(err.statusCode, 429);
      return true;
    }
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test('GnaniProvider safeAudioPath prevents directory traversal attacks', () => {
  const provider = new GnaniProvider({ apiKey: 'key_123', tempDir: '/tmp/docvex-audio' });
  assert.throws(() => provider.safeAudioPath('../secret.txt'), {
    code: 'GNANI_PROTOCOL',
  });
  assert.throws(() => provider.safeAudioPath('/etc/passwd'), {
    code: 'GNANI_PROTOCOL',
  });
  assert.equal(provider.safeAudioPath('speech.wav'), path.resolve('/tmp/docvex-audio/speech.wav'));
});

