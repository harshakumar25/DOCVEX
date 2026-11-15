/**
 * AcousticConvolver: Indian Acoustic Environment Synthesizer & Echo Path Convolver
 *
 * Implements:
 * 1. 50 Hz Ceiling Fan Aerodynamic Turbulence (VAD Stressor).
 * 2. 2-Stroke Auto-Rickshaw Engine Harmonics & Pressure Horn Pulses.
 * 3. Multi-Speaker Bazaar Babble Noise.
 * 4. Speakerphone Acoustic Room Impulse Response (RT60 = 0.55s, ERL = -14 dB).
 * 5. Calibrated SNR Mixing (in dB).
 *
 * Zero external NPM dependencies. Pure mathematical DSP implementation.
 */

/**
 * Calculates the Root-Mean-Square (RMS) amplitude of audio samples.
 * @param {Int16Array} samples
 * @returns {number} RMS power
 */
function calculateRms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

/**
 * Synthesizes 50 Hz ceiling fan noise with aerodynamic turbulence.
 * @param {number} length - Number of samples (at 8000 Hz)
 * @param {number} [sampleRate=8000]
 * @returns {Int16Array}
 */
function synthesizeCeilingFanNoise(length, sampleRate = 8000) {
  const noise = new Int16Array(length);
  let b0 = 0, b1 = 0, b2 = 0; // Pink noise state

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // 50 Hz mains hum with 100 Hz harmonic
    const hum = Math.sin(2 * Math.PI * 50 * t) * 0.4 + Math.sin(2 * Math.PI * 100 * t) * 0.15;

    // Pink turbulence (1/f filter approximation)
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    const turbulence = b0 + b1 + b2;

    // Amplitude modulation (vortex rotation ~4 Hz)
    const rotorModulation = 0.8 + 0.2 * Math.sin(2 * Math.PI * 4 * t);
    const combined = (hum + turbulence * 0.6) * rotorModulation;

    noise[i] = Math.round(combined * 4000);
  }
  return noise;
}

/**
 * Synthesizes 2-stroke auto-rickshaw engine rumble and horn spikes.
 * @param {number} length
 * @param {number} [sampleRate=8000]
 * @returns {Int16Array}
 */
function synthesizeAutoRickshawNoise(length, sampleRate = 8000) {
  const noise = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // 2-stroke engine combustion pulses: 120Hz fundamental + 240Hz, 360Hz harmonics
    const engine =
      Math.sin(2 * Math.PI * 120 * t) * 0.5 +
      Math.sin(2 * Math.PI * 240 * t) * 0.3 +
      Math.sin(2 * Math.PI * 360 * t) * 0.2;

    // Intermittent pressure horn spike (e.g. at intervals)
    let horn = 0;
    const hornCycle = t % 3.0; // horn every 3 seconds for 300ms
    if (hornCycle < 0.3) {
      horn = (Math.sin(2 * Math.PI * 2800 * t) + Math.sin(2 * Math.PI * 3400 * t)) * 0.7;
    }

    const combined = engine * 0.7 + horn * 0.5;
    noise[i] = Math.round(combined * 5000);
  }
  return noise;
}

/**
 * Synthesizes multi-talker bazaar babble noise.
 * @param {number} length
 * @param {number} [sampleRate=8000]
 * @returns {Int16Array}
 */
function synthesizeBazaarBabble(length, sampleRate = 8000) {
  const noise = new Int16Array(length);
  // Superposition of 4 incoherent pseudo-speech frequency formants
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const babble =
      Math.sin(2 * Math.PI * 500 * t + Math.sin(t * 12)) * 0.3 +
      Math.sin(2 * Math.PI * 1200 * t + Math.cos(t * 8)) * 0.25 +
      Math.sin(2 * Math.PI * 1800 * t) * 0.2 +
      (Math.random() * 2 - 1) * 0.15;

    noise[i] = Math.round(babble * 3500);
  }
  return noise;
}

/**
 * Simulates speakerphone acoustic coupling and room reverberation (RT60 ~ 0.55s, ERL ~ -14dB).
 * Convolves the audio with an exponentially decaying room impulse response.
 *
 * @param {Int16Array} samples - Audio samples
 * @param {Object} [options]
 * @param {number} [options.reverbTimeSec=0.55] - RT60 reverberation time in seconds
 * @param {number} [options.echoReturnLossDb=-14] - ERL in dB
 * @param {number} [options.sampleRate=8000]
 * @returns {Int16Array} Echo-convolved audio
 */
function applySpeakerphoneEcho(samples, {
  reverbTimeSec = 0.55,
  echoReturnLossDb = -14,
  sampleRate = 8000,
} = {}) {
  const out = new Int16Array(samples.length);
  const decayRate = 6.91 / (reverbTimeSec * sampleRate); // ln(1000) ~ 6.91 for 60dB decay
  const echoGain = Math.pow(10, echoReturnLossDb / 20); // -14dB ~ 0.20 gain

  // Multi-tap room delay reflections (early reflections at 15ms, 35ms, 65ms, 120ms)
  const taps = [
    { delay: Math.round(0.015 * sampleRate), gain: 0.6 },
    { delay: Math.round(0.035 * sampleRate), gain: 0.4 },
    { delay: Math.round(0.065 * sampleRate), gain: 0.25 },
    { delay: Math.round(0.120 * sampleRate), gain: 0.15 },
  ];

  for (let i = 0; i < samples.length; i++) {
    let echo = 0;
    for (const tap of taps) {
      if (i >= tap.delay) {
        const delayedSample = samples[i - tap.delay];
        const decay = Math.exp(-decayRate * tap.delay);
        echo += delayedSample * tap.gain * decay;
      }
    }

    const mixed = samples[i] + echo * echoGain;
    // Soft clipping
    out[i] = Math.max(-32767, Math.min(32767, Math.round(mixed)));
  }

  return out;
}

/**
 * Mixes background noise into speech at a calibrated Signal-to-Noise Ratio (SNR).
 *
 * @param {Int16Array} speechSamples - Primary speech
 * @param {'ceiling_fan'|'auto_rickshaw'|'bazaar'|'none'} profile - Environment profile
 * @param {number} [snrDb=12] - Target Signal-to-Noise Ratio in dB
 * @param {Object} [options]
 * @param {boolean} [options.enableEcho=false] - Apply speakerphone echo
 * @returns {Int16Array} Degraded audio
 */
function mixAcousticEnvironment(speechSamples, profile = 'ceiling_fan', snrDb = 12, {
  enableEcho = false,
  echoOptions = {},
} = {}) {
  if (profile === 'none' && !enableEcho) {
    return new Int16Array(speechSamples);
  }

  let baseSamples = speechSamples;
  if (enableEcho) {
    baseSamples = applySpeakerphoneEcho(baseSamples, echoOptions);
  }

  if (profile === 'none') {
    return baseSamples;
  }

  // 1. Generate noise profile
  let noise;
  if (profile === 'auto_rickshaw') {
    noise = synthesizeAutoRickshawNoise(baseSamples.length);
  } else if (profile === 'bazaar') {
    noise = synthesizeBazaarBabble(baseSamples.length);
  } else {
    // default: ceiling_fan
    noise = synthesizeCeilingFanNoise(baseSamples.length);
  }

  // 2. Measure speech and noise RMS
  const speechRms = calculateRms(baseSamples) || 1000;
  const noiseRms = calculateRms(noise) || 1;

  // 3. Compute target noise scaling: SNR = 20 * log10(speechRms / targetNoiseRms)
  // targetNoiseRms = speechRms / (10^(SNR/20))
  const targetNoiseRms = speechRms / Math.pow(10, snrDb / 20);
  const scale = targetNoiseRms / noiseRms;

  const out = new Int16Array(baseSamples.length);
  for (let i = 0; i < baseSamples.length; i++) {
    const combined = baseSamples[i] + noise[i] * scale;
    // Hard limiter clamp
    out[i] = Math.max(-32767, Math.min(32767, Math.round(combined)));
  }

  return out;
}

export {
  calculateRms,
  synthesizeCeilingFanNoise,
  synthesizeAutoRickshawNoise,
  synthesizeBazaarBabble,
  applySpeakerphoneEcho,
  mixAcousticEnvironment,
};
