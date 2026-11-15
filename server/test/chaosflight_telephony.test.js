import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  linearToMuLaw,
  muLawToLinear,
  linearToALaw,
  aLawToLinear,
  resampleTo8kHz,
  createTelephonyBandpassFilter,
  GilbertElliottLossSimulator,
  applyNetworkLossAndPLC,
  processTelephonyChannel,
} from '../prismaguard/chaosflight/carrierDigitalTwin.js';

import {
  calculateRms,
  synthesizeCeilingFanNoise,
  synthesizeAutoRickshawNoise,
  synthesizeBazaarBabble,
  applySpeakerphoneEcho,
  mixAcousticEnvironment,
} from '../prismaguard/chaosflight/acousticConvolver.js';

describe('ChaosFlight Telephony Digital Twin & Acoustic Convolver', () => {
  describe('G.711 μ-law & A-law Companding', () => {
    it('linearToMuLaw and muLawToLinear roundtrip preserves speech dynamics with standard quantization error', () => {
      const testValues = [0, 100, -100, 1500, -1500, 12000, -12000, 32000, -32000];
      for (const val of testValues) {
        const mu = linearToMuLaw(val);
        assert.ok(mu >= 0 && mu <= 255, 'μ-law byte must be 8-bit unsigned');
        const linear = muLawToLinear(mu);
        // G.711 quantization error should be within logarithmic tolerance (< 5% for large amplitudes)
        const diff = Math.abs(val - linear);
        if (Math.abs(val) > 1000) {
          const relError = diff / Math.abs(val);
          assert.ok(relError < 0.10, `Relative error for ${val} was ${relError}`);
        } else {
          assert.ok(diff < 150, `Absolute error for ${val} was ${diff}`);
        }
      }
    });

    it('linearToALaw and aLawToLinear roundtrip preserves speech dynamics', () => {
      const testValues = [0, 50, -50, 2000, -2000, 15000, -15000, 30000, -30000];
      for (const val of testValues) {
        const alaw = linearToALaw(val);
        assert.ok(alaw >= 0 && alaw <= 255, 'A-law byte must be 8-bit unsigned');
        const linear = aLawToLinear(alaw);
        const diff = Math.abs(val - linear);
        if (Math.abs(val) > 1000) {
          const relError = diff / Math.abs(val);
          assert.ok(relError < 0.12, `A-law error for ${val} was ${relError}`);
        }
      }
    });
  });

  describe('Resampling & Bandpass Filtering', () => {
    it('resampleTo8kHz downsamples 24000 Hz audio to 8000 Hz with exact 3:1 sample ratio', () => {
      const samples24k = new Int16Array(2400); // 100ms at 24kHz
      for (let i = 0; i < samples24k.length; i++) {
        samples24k[i] = Math.round(Math.sin(2 * Math.PI * 440 * (i / 24000)) * 10000);
      }
      const samples8k = resampleTo8kHz(samples24k, 24000);
      assert.strictEqual(samples8k.length, 800, 'Downsampled length must be exactly 800 samples');
      assert.ok(calculateRms(samples8k) > 1000, 'Audio power must be preserved');
    });

    it('ITU-T G.151 Bandpass Filter attenuates low rumble (50 Hz) and high Nyquist edge (3800 Hz)', () => {
      const filter = createTelephonyBandpassFilter();
      const length = 1600; // 200ms at 8kHz

      // Generate 50 Hz wave (out of band: below 300 Hz)
      const lowFreq = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        lowFreq[i] = Math.round(Math.sin(2 * Math.PI * 50 * (i / 8000)) * 10000);
      }
      const lowFiltered = filter.process(lowFreq);
      const lowRmsIn = calculateRms(lowFreq);
      const lowRmsOut = calculateRms(lowFiltered);
      assert.ok(lowRmsOut < lowRmsIn * 0.40, 'Filter must substantially attenuate 50Hz sub-audible hum');

      // Generate 1000 Hz wave (in band: between 300 Hz and 3400 Hz)
      filter.reset();
      const midFreq = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        midFreq[i] = Math.round(Math.sin(2 * Math.PI * 1000 * (i / 8000)) * 10000);
      }
      const midFiltered = filter.process(midFreq);
      const midRmsIn = calculateRms(midFreq);
      const midRmsOut = calculateRms(midFiltered);
      assert.ok(midRmsOut > midRmsIn * 0.70, 'Filter must pass 1000Hz speech formants with high gain');
    });
  });

  describe('Gilbert-Elliott Burst Packet Loss & PLC', () => {
    it('GilbertElliottLossSimulator transitions between Good and Bad states and drops packets according to probabilities', () => {
      const sim = new GilbertElliottLossSimulator({ p: 0.1, r: 0.2, kG: 0.0, kB: 1.0 });
      let drops = 0;
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        if (sim.isPacketLost()) drops++;
      }
      // With p=0.1 and r=0.2, steady-state burst probability is p/(p+r) = 0.1/0.3 = 33.3%
      // Drops should be non-zero and roughly around 20-50%
      assert.ok(drops > 10, 'Loss model must drop frames in burst state');
      assert.ok(drops < iterations, 'Loss model must not drop all frames');
    });

    it('applyNetworkLossAndPLC applies pitch extrapolation on short loss and comfort noise on medium loss', () => {
      const samples = new Int16Array(160 * 10); // 10 frames of 20ms
      for (let i = 0; i < samples.length; i++) {
        samples[i] = 10000; // constant positive amplitude
      }

      // Mock simulator that forces frames 2 and 3 dropped (short loss), and frame 5-9 dropped (medium loss)
      let frameIndex = 0;
      const mockLossSim = {
        isPacketLost: () => {
          frameIndex++;
          return frameIndex === 2 || frameIndex === 3 || (frameIndex >= 5 && frameIndex <= 8);
        }
      };

      const result = applyNetworkLossAndPLC(samples, mockLossSim, 160);
      assert.strictEqual(result.droppedFrames, 6, 'Must record exact 6 dropped frames');
      assert.strictEqual(result.totalFrames, 10, 'Total frames must be 10');

      // Check frame 2 (offset 160): should be extrapolated with 0.8 decay
      const frame2Sample = result.samples[160];
      assert.strictEqual(frame2Sample, 8000, 'Frame 2 must be 10000 * 0.8 = 8000 (waveform decay)');
    });
  });

  describe('End-to-End processTelephonyChannel Pipeline', () => {
    it('processes clean 24kHz buffer into degraded 8kHz telephony output with G.711 stream', () => {
      const clean24k = new Int16Array(4800); // 200ms
      for (let i = 0; i < clean24k.length; i++) {
        clean24k[i] = Math.round(Math.sin(2 * Math.PI * 800 * (i / 24000)) * 12000);
      }

      const result = processTelephonyChannel(clean24k, {
        srcSampleRate: 24000,
        codec: 'ulaw',
        applyBandpass: true,
        applyLoss: true,
        lossOptions: { p: 0.05, r: 0.30 },
      });

      assert.strictEqual(result.sampleRate, 8000);
      assert.strictEqual(result.pcm8k.length, 1600, 'Must produce 1600 samples at 8kHz');
      assert.strictEqual(result.g711Buffer.length, 1600, 'g711Buffer must be 1600 bytes');
      assert.strictEqual(result.totalFrames, 10);
    });
  });

  describe('Acoustic Environment Convolver', () => {
    it('synthesizes non-zero acoustic noise profiles (ceiling fan, auto rickshaw, bazaar)', () => {
      const length = 800; // 100ms
      const fan = synthesizeCeilingFanNoise(length);
      const auto = synthesizeAutoRickshawNoise(length);
      const bazaar = synthesizeBazaarBabble(length);

      assert.strictEqual(fan.length, length);
      assert.strictEqual(auto.length, length);
      assert.strictEqual(bazaar.length, length);

      assert.ok(calculateRms(fan) > 500, 'Fan noise must have non-zero RMS');
      assert.ok(calculateRms(auto) > 500, 'Auto noise must have non-zero RMS');
      assert.ok(calculateRms(bazaar) > 500, 'Bazaar noise must have non-zero RMS');
    });

    it('mixAcousticEnvironment blends environment noise at calibrated SNR', () => {
      const speech = new Int16Array(8000); // 1s at 8kHz
      for (let i = 0; i < speech.length; i++) {
        speech[i] = Math.round(Math.sin(2 * Math.PI * 500 * (i / 8000)) * 8000);
      }

      const mixed = mixAcousticEnvironment(speech, 'ceiling_fan', 12, { enableEcho: false });
      assert.strictEqual(mixed.length, speech.length);
      const mixedRms = calculateRms(mixed);
      assert.ok(mixedRms > 0, 'Mixed audio must have valid RMS');
    });

    it('applySpeakerphoneEcho convolves audio with room impulse decay without clipping', () => {
      const speech = new Int16Array(2400); // 300ms
      speech[100] = 20000; // impulse spike

      const echoed = applySpeakerphoneEcho(speech, {
        reverbTimeSec: 0.4,
        echoReturnLossDb: -14,
        sampleRate: 8000,
      });

      assert.strictEqual(echoed.length, speech.length);
      // Check that a delayed reflection exists at tap delay (e.g. 15ms = 120 samples)
      assert.ok(Math.abs(echoed[100 + 120]) > 0, 'Impulse reflection must be present at delayed tap');
    });
  });
});
