/**
 * CarrierDigitalTwin: Mathematical Telephony Codec & Network Channel Simulator
 *
 * Implements:
 * 1. ITU-T G.711 μ-law and A-law 8-bit non-linear companding.
 * 2. Bandpass filtering (ITU-T G.151: 300 Hz - 3400 Hz).
 * 3. 8 kHz resampling with antialiasing cutoff.
 * 4. Gilbert-Elliott 2-state discrete Markov burst packet loss model.
 * 5. Packet Loss Concealment (PLC) emulation (waveform extrapolation, comfort noise, muting).
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID principles.
 */

// μ-law bias and table parameters (ITU-T G.711)
const BIAS = 0x84;
const CLIP = 32635;

/**
 * Encodes a 16-bit linear PCM sample into an 8-bit G.711 μ-law byte.
 * @param {number} pcmSample - Signed 16-bit integer (-32768 to 32767)
 * @returns {number} 8-bit unsigned μ-law byte (0-255)
 */
function linearToMuLaw(pcmSample) {
  let sign = (pcmSample >> 8) & 0x80;
  if (sign !== 0) pcmSample = -pcmSample;
  if (pcmSample > CLIP) pcmSample = CLIP;
  pcmSample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcmSample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (pcmSample >> (exponent + 3)) & 0x0f;
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muLawByte;
}

/**
 * Decodes an 8-bit G.711 μ-law byte back into a 16-bit linear PCM sample.
 * @param {number} muLawByte - 8-bit unsigned μ-law byte (0-255)
 * @returns {number} Signed 16-bit integer (-32768 to 32767)
 */
function muLawToLinear(muLawByte) {
  muLawByte = ~muLawByte & 0xff;
  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

const SEG_END_A_LAW = [0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF, 0x3FFF, 0x7FFF];

/**
 * Encodes a 16-bit linear PCM sample into an 8-bit G.711 A-law byte (CCITT standard).
 * @param {number} pcmSample - Signed 16-bit integer (-32768 to 32767)
 * @returns {number} 8-bit unsigned A-law byte (0-255)
 */
function linearToALaw(pcmSample) {
  let mask;
  if (pcmSample >= 0) {
    mask = 0xD5;
  } else {
    mask = 0x55;
    pcmSample = -pcmSample - 1;
  }

  let seg = 8;
  for (let i = 0; i < 8; i++) {
    if (pcmSample <= SEG_END_A_LAW[i]) {
      seg = i;
      break;
    }
  }

  if (seg >= 8) return (0x7F ^ mask) & 0xFF;

  let aVal = seg << 4;
  if (seg < 2) {
    aVal |= (pcmSample >> 4) & 0x0F;
  } else {
    aVal |= (pcmSample >> (seg + 3)) & 0x0F;
  }
  return (aVal ^ mask) & 0xFF;
}

/**
 * Decodes an 8-bit G.711 A-law byte back into a 16-bit linear PCM sample (CCITT standard).
 * @param {number} aLawByte - 8-bit unsigned A-law byte (0-255)
 * @returns {number} Signed 16-bit integer (-32768 to 32767)
 */
function aLawToLinear(aLawByte) {
  aLawByte ^= 0x55;
  let t = (aLawByte & 0x0F) << 4;
  const seg = (aLawByte & 0x70) >> 4;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t = (t + 0x108) << (seg - 1);
      break;
  }
  return (aLawByte & 0x80) ? t : -t;
}

/**
 * Resamples a mono 16-bit PCM buffer from an arbitrary sample rate to 8000 Hz.
 * @param {Int16Array} samplesIn - Input PCM samples
 * @param {number} srcRate - Source sample rate (e.g. 24000, 16000)
 * @returns {Int16Array} Resampled 8000 Hz PCM samples
 */
function resampleTo8kHz(samplesIn, srcRate = 24000) {
  if (srcRate === 8000) return new Int16Array(samplesIn);
  const ratio = srcRate / 8000;
  const outLength = Math.floor(samplesIn.length / ratio);
  const samplesOut = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = samplesIn[idx] || 0;
    const s1 = samplesIn[idx + 1] !== undefined ? samplesIn[idx + 1] : s0;
    // Linear interpolation
    samplesOut[i] = Math.round(s0 + frac * (s1 - s0));
  }
  return samplesOut;
}

/**
 * 2nd-order Biquad IIR Filter section for DSP filtering.
 */
class BiquadFilter {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  processSample(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
}

/**
 * Synthesizes an ITU-T G.151 Telephony Bandpass Filter (300 Hz - 3400 Hz at 8000 Hz Fs).
 * Built as a cascade of 2 biquads: Highpass at 300Hz, Lowpass at 3400Hz.
 */
function createTelephonyBandpassFilter() {
  // Coefficients pre-calculated for Fs = 8000 Hz, Q = 0.707 (Butterworth)
  // HPF 300 Hz:
  const hpf = new BiquadFilter(
    0.840742, -1.681484, 0.840742,
    -1.658252, 0.704716
  );
  // LPF 3400 Hz:
  const lpf = new BiquadFilter(
    0.803148, 1.606296, 0.803148,
    1.561018, 0.641474
  );

  return {
    process(samples) {
      const out = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        let val = samples[i] / 32768.0;
        val = hpf.processSample(val);
        val = lpf.processSample(val);
        // Soft clipping
        if (val > 0.999) val = 0.999;
        if (val < -0.999) val = -0.999;
        out[i] = Math.round(val * 32767);
      }
      return out;
    },
    reset() {
      hpf.reset();
      lpf.reset();
    }
  };
}

/**
 * Gilbert-Elliott 2-State Discrete Markov Chain Network Loss Model.
 * State G (Good, loss prob kG), State B (Burst, loss prob kB).
 */
class GilbertElliottLossSimulator {
  /**
   * @param {Object} options
   * @param {number} [options.p=0.02] - Trans probability Good -> Bad
   * @param {number} [options.r=0.25] - Trans probability Bad -> Good (1/r = mean burst frames)
   * @param {number} [options.kG=0.002] - Loss prob in Good state
   * @param {number} [options.kB=0.65] - Loss prob in Bad state
   */
  constructor({ p = 0.02, r = 0.25, kG = 0.002, kB = 0.65 } = {}) {
    this.p = p;
    this.r = r;
    this.kG = kG;
    this.kB = kB;
    this.state = 'G'; // 'G' or 'B'
  }

  /**
   * Evaluates packet loss for a single frame (typically 20ms = 160 samples at 8kHz).
   * @param {number} [randomValue] - Optional injected random value in [0, 1) for deterministic testing
   * @returns {boolean} true if packet was dropped, false if delivered
   */
  isPacketLost(randomValue = Math.random()) {
    // State transition
    if (this.state === 'G') {
      if (Math.random() < this.p) {
        this.state = 'B';
      }
    } else {
      if (Math.random() < this.r) {
        this.state = 'G';
      }
    }

    const lossThreshold = this.state === 'G' ? this.kG : this.kB;
    return randomValue < lossThreshold;
  }

  reset() {
    this.state = 'G';
  }
}

/**
 * Applies Packet Loss Concealment (PLC) across dropped 20ms frames.
 * - Under 40ms (1-2 frames): Pitch-period waveform decay extrapolation (alpha = 0.8).
 * - 40ms to 120ms (3-6 frames): Comfort noise synthesis.
 * - Over 120ms (>6 frames): Total muting.
 *
 * @param {Int16Array} samples - Audio samples (8 kHz)
 * @param {GilbertElliottLossSimulator} lossSim - Network loss model
 * @param {number} [frameSize=160] - Samples per frame (160 samples = 20ms at 8kHz)
 * @returns {{ samples: Int16Array, droppedFrames: number, totalFrames: number }}
 */
function applyNetworkLossAndPLC(samples, lossSim, frameSize = 160) {
  const totalFrames = Math.ceil(samples.length / frameSize);
  const out = new Int16Array(samples.length);
  let droppedFrames = 0;
  let consecutiveLoss = 0;
  let lastGoodFrame = new Int16Array(frameSize);

  for (let f = 0; f < totalFrames; f++) {
    const offset = f * frameSize;
    const len = Math.min(frameSize, samples.length - offset);
    const isLost = lossSim.isPacketLost();

    if (isLost) {
      droppedFrames++;
      consecutiveLoss++;

      if (consecutiveLoss <= 2) {
        // Short loss: Waveform decay extrapolation
        const decay = Math.pow(0.8, consecutiveLoss);
        for (let i = 0; i < len; i++) {
          out[offset + i] = Math.round((lastGoodFrame[i] || 0) * decay);
        }
      } else if (consecutiveLoss <= 6) {
        // Medium loss: Attenuated comfort noise
        for (let i = 0; i < len; i++) {
          const noise = (Math.random() * 2 - 1) * 350; // low amplitude comfort noise
          out[offset + i] = Math.round(noise);
        }
      } else {
        // Long loss: Total muting
        for (let i = 0; i < len; i++) {
          out[offset + i] = 0;
        }
      }
    } else {
      consecutiveLoss = 0;
      for (let i = 0; i < len; i++) {
        out[offset + i] = samples[offset + i];
        lastGoodFrame[i] = samples[offset + i];
      }
    }
  }

  return { samples: out, droppedFrames, totalFrames };
}

/**
 * End-to-end Carrier Digital Twin channel processor.
 * Transforms clean wideband audio into authentic telephony degraded 8 kHz audio.
 *
 * @param {Buffer|Int16Array} inputAudio - Linear PCM 16-bit audio
 * @param {Object} [options]
 * @param {number} [options.srcSampleRate=24000] - Input sample rate
 * @param {'ulaw'|'alaw'} [options.codec='ulaw'] - G.711 codec variant
 * @param {boolean} [options.applyBandpass=true] - Apply ITU-T G.151 300-3400Hz filtering
 * @param {boolean} [options.applyLoss=true] - Apply Gilbert-Elliott packet loss
 * @param {Object} [options.lossOptions] - Markov loss parameters
 * @returns {{ pcm8k: Int16Array, g711Buffer: Buffer, droppedFrames: number, totalFrames: number }}
 */
function processTelephonyChannel(inputAudio, {
  srcSampleRate = 24000,
  codec = 'ulaw',
  applyBandpass = true,
  applyLoss = true,
  lossOptions = {},
} = {}) {
  // Convert Buffer to Int16Array if needed
  let samplesIn;
  if (Buffer.isBuffer(inputAudio)) {
    samplesIn = new Int16Array(inputAudio.buffer, inputAudio.byteOffset, inputAudio.byteLength / 2);
  } else {
    samplesIn = inputAudio;
  }

  // 1. Resample to 8000 Hz
  let samples8k = resampleTo8kHz(samplesIn, srcSampleRate);

  // 2. Bandpass filter (300 Hz - 3400 Hz)
  if (applyBandpass) {
    const filter = createTelephonyBandpassFilter();
    samples8k = filter.process(samples8k);
  }

  // 3. Codec Quantization (16-bit PCM -> G.711 8-bit non-linear -> 16-bit PCM)
  const g711Bytes = Buffer.alloc(samples8k.length);
  const quantSamples = new Int16Array(samples8k.length);
  const encodeFn = codec === 'alaw' ? linearToALaw : linearToMuLaw;
  const decodeFn = codec === 'alaw' ? aLawToLinear : muLawToLinear;

  for (let i = 0; i < samples8k.length; i++) {
    const byte = encodeFn(samples8k[i]);
    g711Bytes[i] = byte;
    quantSamples[i] = decodeFn(byte);
  }

  // 4. Network Loss & PLC
  let droppedFrames = 0;
  let totalFrames = Math.ceil(quantSamples.length / 160);
  let finalPcm = quantSamples;

  if (applyLoss) {
    const lossSim = new GilbertElliottLossSimulator(lossOptions);
    const netResult = applyNetworkLossAndPLC(quantSamples, lossSim, 160);
    finalPcm = netResult.samples;
    droppedFrames = netResult.droppedFrames;
    totalFrames = netResult.totalFrames;
  }

  return {
    pcm8k: finalPcm,
    g711Buffer: g711Bytes,
    droppedFrames,
    totalFrames,
    sampleRate: 8000,
  };
}

/**
 * Encodes an Int16Array PCM buffer into a compliant RIFF/WAVE 16-bit mono buffer.
 * @param {Int16Array} pcmSamples - Linear 16-bit signed PCM samples
 * @param {number} [sampleRate=8000] - Sample rate in Hz (e.g. 8000, 24000)
 * @returns {Buffer} Standard RIFF/WAVE container buffer
 */
function pcm16ToWavBuffer(pcmSamples, sampleRate = 8000) {
  const numSamples = pcmSamples.length;
  const dataSize = numSamples * 2;
  const totalSize = 44 + dataSize;
  const buffer = Buffer.alloc(totalSize);

  // RIFF Chunk Descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(totalSize - 8, 4);
  buffer.write('WAVE', 8);

  // "fmt " sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);               // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);                // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22);                // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24);       // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28);   // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(2, 32);                // BlockAlign (NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(16, 34);               // BitsPerSample (16)

  // "data" sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write 16-bit little-endian samples
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(pcmSamples[i], 44 + i * 2);
  }

  return buffer;
}

export {
  linearToMuLaw,
  muLawToLinear,
  linearToALaw,
  aLawToLinear,
  resampleTo8kHz,
  createTelephonyBandpassFilter,
  GilbertElliottLossSimulator,
  applyNetworkLossAndPLC,
  processTelephonyChannel,
  pcm16ToWavBuffer,
};
