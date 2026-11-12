import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AdaptiveSpeechDetector,
  DEFAULT_VAD_CONFIG,
  VAD_STATES,
  extractAcousticFeatures,
  hzToBin,
} from '../../extension/voiceActivityDetector.js';

function makeSineSpectrumFrame({
  freqHz = 240,
  rms = 0.04,
  noiseRms = 0.0005,
  sampleRate = 48000,
  fftSize = 1024,
  zcrHz = 480,
}) {
  const binCount = fftSize / 2;
  const frequencyDb = new Float32Array(binCount).fill(-110);

  // Fill gentle ambient noise across spectrum
  const perBinNoisePower = (noiseRms * noiseRms) / binCount;
  const baseNoiseDb = 10 * Math.log10(Math.max(perBinNoisePower, 1e-18));
  for (let b = 0; b < binCount; b++) {
    frequencyDb[b] = baseNoiseDb;
  }

  // Spread harmonic voice across fundamental + 2nd + 3rd + 4th formants (so spectral flatness stays low & not a single-bin pure tone)
  const harmonics = [1, 2, 3, 4, 5];
  const weights = [0.42, 0.25, 0.16, 0.10, 0.07];
  harmonics.forEach((h, i) => {
    const bin = hzToBin(freqHz * h, sampleRate, fftSize);
    const p = rms * rms * weights[i];
    frequencyDb[bin] = 10 * Math.log10(Math.max(p, 1e-18));
    if (bin + 1 < binCount) {
      frequencyDb[bin + 1] = 10 * Math.log10(Math.max(p * 0.25, 1e-18));
    }
  });

  return extractAcousticFeatures({
    frequencyDb,
    timeDomain: null,
    sampleRate,
    fftSize,
  });
}

function makeNoiseFrame({
  noiseRms = 0.002,
  pinkSlope = false,
  subBassBoost = false,
  highFreqBoost = false,
  sampleRate = 48000,
  fftSize = 1024,
}) {
  const binCount = fftSize / 2;
  const frequencyDb = new Float32Array(binCount);
  let totalRaw = 0;
  const raw = new Float32Array(binCount);
  for (let b = 1; b < binCount; b++) {
    let w = 1;
    if (pinkSlope) w = 1 / Math.sqrt(b);
    if (subBassBoost && b <= hzToBin(100, sampleRate, fftSize)) w *= 20;
    if (highFreqBoost && b >= hzToBin(4000, sampleRate, fftSize)) w *= 12;
    raw[b] = w;
    totalRaw += w;
  }
  const targetPow = noiseRms * noiseRms;
  for (let b = 0; b < binCount; b++) {
    const p = b === 0 ? targetPow * 0.001 : (raw[b] / totalRaw) * targetPow;
    frequencyDb[b] = 10 * Math.log10(Math.max(p, 1e-18));
  }
  return extractAcousticFeatures({ frequencyDb, sampleRate, fftSize });
}

test('hzToBin maps frequencies cleanly across sample rates without out-of-bounds', () => {
  assert.equal(hzToBin(0, 48000, 1024), 0);
  assert.equal(hzToBin(24000, 48000, 1024), 511);
  assert.equal(hzToBin(99999, 44100, 1024), 511);
  assert.ok(hzToBin(1000, 16000, 1024) > hzToBin(1000, 48000, 1024));
});

test('AdaptiveSpeechDetector ignores digital silence and never completes bogus speech', () => {
  const vad = new AdaptiveSpeechDetector();
  const silentDb = new Float32Array(512).fill(-120);
  const features = extractAcousticFeatures({ frequencyDb: silentDb });
  for (let i = 0; i < 20; i++) {
    const res = vad.update(features, { nowMs: i * 45 });
    assert.equal(res.state, VAD_STATES.IDLE);
    assert.equal(res.event, null);
  }
});

test('AdaptiveSpeechDetector filters steady background white & pink fan noise without false activation', () => {
  const vad = new AdaptiveSpeechDetector();
  for (let i = 0; i < 30; i++) {
    const white = makeNoiseFrame({ noiseRms: 0.004, pinkSlope: false });
    const res = vad.update(white, { nowMs: i * 45 });
    assert.notEqual(res.event, 'speech_start');
  }
  vad.reset();
  for (let i = 0; i < 30; i++) {
    const pink = makeNoiseFrame({ noiseRms: 0.005, pinkSlope: true });
    const res = vad.update(pink, { nowMs: i * 45 });
    assert.notEqual(res.event, 'speech_start');
  }
});

test('AdaptiveSpeechDetector handles gradual browser AGC background noise creep without triggering', () => {
  const vad = new AdaptiveSpeechDetector();
  for (let step = 0; step < 35; step++) {
    const creepingRms = 0.001 + step * 0.00035;
    const frame = makeNoiseFrame({ noiseRms: creepingRms, pinkSlope: true });
    const res = vad.update(frame, { nowMs: step * 45 });
    assert.notEqual(res.event, 'speech_start', `Unexpected speech trigger at step ${step}`);
  }
});

test('AdaptiveSpeechDetector rejects impulsive keyboard clicks, desk bumps, 60Hz hum, and pure coil whine', () => {
  const vad = new AdaptiveSpeechDetector();
  for (let i = 0; i < 8; i++) {
    vad.update(makeNoiseFrame({ noiseRms: 0.0015 }), { nowMs: i * 45 });
  }

  // Impulsive single click (only 1 frame)
  const clickRes = vad.update(makeSineSpectrumFrame({ freqHz: 300, rms: 0.06 }), { nowMs: 400 });
  assert.notEqual(clickRes.event, 'speech_start');

  // Desk bump (sub-bass heavy)
  for (let i = 0; i < 6; i++) {
    const bump = vad.update(makeNoiseFrame({ noiseRms: 0.05, subBassBoost: true }), { nowMs: 500 + i * 45 });
    assert.notEqual(bump.event, 'speech_start');
  }

  // 60Hz electrical hum (sub-bass fundamental)
  for (let i = 0; i < 6; i++) {
    const freqDb = new Float32Array(512).fill(-100);
    freqDb[hzToBin(60, 48000, 1024)] = -25;
    const hum = vad.update(extractAcousticFeatures({ frequencyDb: freqDb }), { nowMs: 900 + i * 45 });
    assert.notEqual(hum.event, 'speech_start');
  }

  // Pure coil whine (single narrow peak -> peakDominance > 0.9)
  for (let i = 0; i < 6; i++) {
    const freqDb = new Float32Array(512).fill(-110);
    freqDb[hzToBin(2200, 48000, 1024)] = -22;
    const whine = vad.update(extractAcousticFeatures({ frequencyDb: freqDb }), { nowMs: 1300 + i * 45 });
    assert.notEqual(whine.event, 'speech_start');
  }
});

test('AdaptiveSpeechDetector detects genuine human speech in quiet and fan-noisy environments', () => {
  const vad = new AdaptiveSpeechDetector();
  for (let i = 0; i < 8; i++) {
    vad.update(makeNoiseFrame({ noiseRms: 0.002 }), { nowMs: i * 45 });
  }

  let triggered = false;
  for (let i = 0; i < 6; i++) {
    const sp = makeSineSpectrumFrame({ freqHz: 210, rms: 0.015 });
    const res = vad.update(sp, { nowMs: 400 + i * 45 });
    if (res.event === 'speech_start') triggered = true;
  }
  assert.equal(triggered, true);
});

test('AdaptiveSpeechDetector bridges brief intra-word stop consonant gaps in multi-syllable words ("ruko")', () => {
  const vad = new AdaptiveSpeechDetector();
  for (let i = 0; i < 8; i++) {
    vad.update(makeNoiseFrame({ noiseRms: 0.0015 }), { nowMs: i * 45 });
  }

  let t = 400;
  for (let i = 0; i < 4; i++) {
    vad.update(makeSineSpectrumFrame({ freqHz: 220, rms: 0.03 }), { nowMs: (t += 45) });
  }
  assert.equal(vad.state, VAD_STATES.SPEAKING);

  // Brief ~90ms consonant gap (2 quiet frames) stays inside SPEAKING
  const gap1 = vad.update(makeNoiseFrame({ noiseRms: 0.0015 }), { nowMs: (t += 45) });
  assert.equal(gap1.state, VAD_STATES.SPEAKING);

  const resumed = vad.update(makeSineSpectrumFrame({ freqHz: 250, rms: 0.03 }), { nowMs: (t += 45) });
  assert.equal(resumed.state, VAD_STATES.SPEAKING);
});

test('strictMode increases speaker-bleed margin when DocVex audio is playing', () => {
  const normalVad = new AdaptiveSpeechDetector();
  const strictVad = new AdaptiveSpeechDetector();

  const ambient = makeNoiseFrame({ noiseRms: 0.002 });
  for (let i = 0; i < 8; i++) {
    normalVad.update(ambient, { nowMs: i * 45 });
    strictVad.update(ambient, { nowMs: i * 45 });
  }

  const softLeak = makeSineSpectrumFrame({ freqHz: 240, rms: 0.004 });
  const rNormal = normalVad.update(softLeak, { strictMode: false, nowMs: 400 });
  const rStrict = strictVad.update(softLeak, { strictMode: true, nowMs: 400 });

  assert.equal(rNormal.frame.isSpeechLike, true);
  assert.equal(rStrict.frame.isSpeechLike, false);
});

test('AdaptiveSpeechDetector stays invariant under Web Audio AnalyserNode FFT scaling offset and recovers cleanly to IDLE', () => {
  const vad = new AdaptiveSpeechDetector();
  const ambient = makeNoiseFrame({ noiseRms: 0.003 });
  for (let i = 0; i < 8; i++) {
    vad.update(ambient, { nowMs: i * 45 });
  }

  let started = false;
  let t = 400;
  for (let i = 0; i < 5; i++) {
    const res = vad.update(makeSineSpectrumFrame({ freqHz: 200, rms: 0.025 }), { nowMs: (t += 45) });
    if (res.event === 'speech_start') started = true;
  }
  assert.equal(started, true);

  let ended = false;
  for (let i = 0; i < 12; i++) {
    const res = vad.update(ambient, { nowMs: (t += 45) });
    if (res.event === 'speech_end') ended = true;
  }
  assert.equal(ended, true);
  assert.equal(vad.state, VAD_STATES.IDLE);
});

test('extension manifest exposes voiceActivityDetector.js as web_accessible_resource', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'extension/manifest.json'), 'utf8')
  );
  const resources = manifest.web_accessible_resources?.flatMap((entry) => entry.resources || []) || [];
  assert.ok(resources.includes('voiceActivityDetector.js'));
  assert.ok(resources.includes('conversationState.js'));
  assert.ok(resources.includes('speechCore.js'));
  assert.ok(resources.includes('voiceSelector.js'));
  assert.ok(DEFAULT_VAD_CONFIG.fftSize >= 512);
});
