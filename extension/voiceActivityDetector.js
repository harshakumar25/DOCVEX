/**
 * Canonical Adaptive Spectral Voice Activity Detector (VAD) for DocVex / Docy.
 * Pure ES module (zero DOM, zero chrome.* APIs).
 *
 * Filters out ambient room/fan noise, electrical hum (50/60Hz), impulsive
 * keyboard clicks, pure-tone coil whine, and gradual browser AGC creep while
 * reliably activating on genuine human speech (even through WebRTC AEC/NS).
 */

export const VAD_STATES = Object.freeze({
  IDLE: 'IDLE',
  CANDIDATE: 'CANDIDATE',
  SPEAKING: 'SPEAKING',
});

export const DEFAULT_VAD_CONFIG = Object.freeze({
  fftSize: 1024,
  sampleIntervalMs: 45,
  smoothingTimeConstant: 0.2,

  // Noise floor calibration & adaptive tracking
  calibrationMinFrames: 6,
  minValidSignalDb: -105,
  minNoiseFloorRmsDb: -72,
  maxNoiseFloorRmsDb: -32,
  noiseAlphaUp: 0.08,
  noiseAlphaDown: 0.25,
  stationaryCeilingMarginDb: 12,

  // Minimum acoustic signal & dynamic SNR over ambient noise floor
  minRms: 0.002,
  minSnrRmsDb: 6.0,
  minSnrBandDb: 5.5,
  strictSnrBoostDb: 1.5,

  // Sample-rate-invariant frequency bands (Hz)
  subBassLowHz: 25,
  subBassHighHz: 110,
  speechBandLowHz: 130,
  speechBandHighHz: 3400,
  highNoiseLowHz: 3800,
  highNoiseHighHz: 10000,

  // Spectral & time-domain speech classifiers
  minSpeechRatio: 0.4,
  maxSubBassRatio: 0.56,
  maxHighNoiseRatio: 0.56,
  maxSpectralFlatness: 0.54,
  maxPeakDominance: 0.9,
  minZcrHz: 75,
  maxZcrHz: 5500,

  // Temporal sustain & hysteresis
  confirmScore: 3,
  maxScore: 6,
  hangoverMinScore: 1.2,
  minConfirmDurationMs: 120,
  candidateWindowMs: 4000,
  speechWindowMs: 4500,
});

export function hzToBin(hz, sampleRate = 48000, fftSize = 1024) {
  if (!Number.isFinite(hz) || !Number.isFinite(sampleRate) || !Number.isFinite(fftSize) || sampleRate <= 0 || fftSize <= 0) {
    return 0;
  }
  const nyquist = sampleRate / 2;
  const maxBin = Math.floor(fftSize / 2) - 1;
  const clampedHz = Math.max(0, Math.min(nyquist, hz));
  const raw = Math.round((clampedHz / sampleRate) * fftSize);
  return Math.max(0, Math.min(maxBin, raw));
}

export function computeSpectrumDbFromTimeDomain(timeDomain, fftSize = 1024) {
  const N = Math.min(fftSize, timeDomain?.length || 0);
  const binCount = Math.floor(fftSize / 2);
  const out = new Float32Array(binCount).fill(-120);
  if (N < 16) return out;

  // Lightweight Goertzel-style DFT across speech-relevant bins (0..10kHz capped at binCount)
  for (let k = 0; k < binCount; k++) {
    let re = 0;
    let im = 0;
    const omega = (2 * Math.PI * k) / N;
    for (let n = 0; n < N; n++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
      const s = timeDomain[n] * hann;
      re += s * Math.cos(omega * n);
      im -= s * Math.sin(omega * n);
    }
    const mag = Math.sqrt(re * re + im * im) / (N * 0.5);
    out[k] = mag > 1e-9 ? 20 * Math.log10(mag) : -120;
  }
  return out;
}

export function extractAcousticFeatures({
  frequencyDb,
  timeDomain,
  sampleRate = 48000,
  fftSize = 1024,
  config = DEFAULT_VAD_CONFIG,
}) {
  const cfg = { ...DEFAULT_VAD_CONFIG, ...config };

  // Compute RMS & Zero-Crossing Rate from time domain
  let rms = 0;
  let zcrHz = 0;
  if (timeDomain && timeDomain.length > 1) {
    let sumSq = 0;
    let zeroCrossings = 0;
    let prev = timeDomain[0];
    sumSq += prev * prev;
    for (let i = 1; i < timeDomain.length; i++) {
      const cur = timeDomain[i];
      sumSq += cur * cur;
      if ((cur >= 0 && prev < 0) || (cur < 0 && prev >= 0)) {
        zeroCrossings++;
      }
      prev = cur;
    }
    rms = Math.sqrt(sumSq / timeDomain.length);
    const durationSec = timeDomain.length / sampleRate;
    zcrHz = durationSec > 0 ? zeroCrossings / (2 * durationSec) : 0;
  }

  let spectrumDb = frequencyDb;
  if ((!spectrumDb || spectrumDb.length === 0) && timeDomain && timeDomain.length > 0) {
    spectrumDb = computeSpectrumDbFromTimeDomain(timeDomain, fftSize);
  }

  let subBassPower = 0;
  let speechPower = 0;
  let highNoisePower = 0;
  let totalPower = 0;
  let speechBandSumLog = 0;
  let speechBandPeakPower = 0;
  let speechBandBinCount = 0;

  if (spectrumDb && spectrumDb.length > 0) {
    const subLow = hzToBin(cfg.subBassLowHz, sampleRate, fftSize);
    const subHigh = Math.max(subLow, hzToBin(cfg.subBassHighHz, sampleRate, fftSize));
    const spLow = Math.max(subHigh + 1, hzToBin(cfg.speechBandLowHz, sampleRate, fftSize));
    const spHigh = Math.max(spLow, hzToBin(cfg.speechBandHighHz, sampleRate, fftSize));
    const hiLow = Math.max(spHigh + 1, hzToBin(cfg.highNoiseLowHz, sampleRate, fftSize));
    const hiHigh = Math.min(spectrumDb.length - 1, hzToBin(cfg.highNoiseHighHz, sampleRate, fftSize));

    for (let b = 0; b < spectrumDb.length; b++) {
      const db = Number.isFinite(spectrumDb[b]) ? Math.max(-140, Math.min(0, spectrumDb[b])) : -140;
      const p = Math.pow(10, db / 10);
      totalPower += p;
      if (b >= subLow && b <= subHigh) subBassPower += p;
      if (b >= spLow && b <= spHigh) {
        speechPower += p;
        speechBandSumLog += Math.log(Math.max(p, 1e-18));
        if (p > speechBandPeakPower) speechBandPeakPower = p;
        speechBandBinCount++;
      }
      if (b >= hiLow && b <= hiHigh) highNoisePower += p;
    }
  }

  // Fallback RMS from spectral power if timeDomain not provided
  if (rms === 0 && totalPower > 0) {
    rms = Math.sqrt(totalPower);
  }

  const rmsDb = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
  const speechBandDb = speechPower > 1e-14 ? 10 * Math.log10(speechPower) : -120;
  const denom = totalPower > 1e-18 ? totalPower : 1;
  const speechRatio = speechPower / denom;
  const subBassRatio = subBassPower / denom;
  const highNoiseRatio = highNoisePower / denom;

  let spectralFlatness = 1;
  let peakDominance = 0;
  if (speechBandBinCount > 0 && speechPower > 1e-16) {
    const geomMean = Math.exp(speechBandSumLog / speechBandBinCount);
    const arithMean = speechPower / speechBandBinCount;
    spectralFlatness = Math.max(0, Math.min(1, geomMean / Math.max(arithMean, 1e-18)));
    peakDominance = Math.max(0, Math.min(1, speechBandPeakPower / speechPower));
  }

  return {
    rms,
    rmsDb,
    speechBandDb,
    speechRatio,
    subBassRatio,
    highNoiseRatio,
    spectralFlatness,
    peakDominance,
    zcrHz,
    hasValidSignal: rmsDb >= cfg.minValidSignalDb,
  };
}

export function classifySpeechFrame(features, noiseState, { strictMode = false, config = DEFAULT_VAD_CONFIG } = {}) {
  const cfg = { ...DEFAULT_VAD_CONFIG, ...config };
  const boost = strictMode ? cfg.strictSnrBoostDb : 0;

  if (!features || !features.hasValidSignal || features.rms < cfg.minRms) {
    return { isSpeechLike: false, scoreDelta: -1, reasons: ['below_min_rms'] };
  }

  const snrRmsDb = features.rmsDb - (noiseState?.rmsDb ?? cfg.maxNoiseFloorRmsDb);
  const snrBandDb = features.speechBandDb - (noiseState?.speechBandDb ?? cfg.maxNoiseFloorRmsDb);

  const reasons = [];
  if (snrRmsDb < cfg.minSnrRmsDb + boost) reasons.push('low_snr_rms');
  if (snrBandDb < cfg.minSnrBandDb + boost) reasons.push('low_snr_band');
  if (features.speechRatio < cfg.minSpeechRatio) reasons.push('low_speech_ratio');
  if (features.subBassRatio > cfg.maxSubBassRatio) reasons.push('sub_bass_dominant');
  if (features.highNoiseRatio > cfg.maxHighNoiseRatio) reasons.push('high_freq_noise');
  if (features.spectralFlatness > cfg.maxSpectralFlatness) reasons.push('noise_flatness');
  if (features.peakDominance > cfg.maxPeakDominance) reasons.push('pure_tone_whine');
  if (features.zcrHz > 0 && (features.zcrHz < cfg.minZcrHz || features.zcrHz > cfg.maxZcrHz)) {
    reasons.push('zcr_out_of_range');
  }

  const isSpeechLike = reasons.length === 0;
  return {
    isSpeechLike,
    scoreDelta: isSpeechLike ? 1 : -0.75,
    snrRmsDb,
    snrBandDb,
    reasons,
  };
}

export class AdaptiveSpeechDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.state = VAD_STATES.IDLE;
    this.score = 0;
    this.noiseRmsDb = null;
    this.noiseSpeechBandDb = null;
    this.calibrationFrames = 0;
    this.candidateStartMs = null;
    this.speechStartMs = null;
    this.hadSpeech = false;
  }

  _updateNoiseFloor(features, isSpeechCandidate) {
    const cfg = this.config;
    if (!features.hasValidSignal) return;

    const clampedRmsDb = Math.max(cfg.minNoiseFloorRmsDb, Math.min(cfg.maxNoiseFloorRmsDb, features.rmsDb));
    const clampedBandDb = Math.max(-100, Math.min(cfg.maxNoiseFloorRmsDb, features.speechBandDb));

    if (this.calibrationFrames === 0 || this.noiseRmsDb === null) {
      this.noiseRmsDb = clampedRmsDb;
      this.noiseSpeechBandDb = clampedBandDb;
      this.calibrationFrames = 1;
      return;
    }

    if (this.calibrationFrames < cfg.calibrationMinFrames) {
      this.calibrationFrames++;
      const k = 1 / this.calibrationFrames;
      this.noiseRmsDb = this.noiseRmsDb * (1 - k) + clampedRmsDb * k;
      this.noiseSpeechBandDb = this.noiseSpeechBandDb * (1 - k) + clampedBandDb * k;
      return;
    }

    // Do not raise noise floor quickly on confirmed speech
    if (this.state === VAD_STATES.SPEAKING || isSpeechCandidate) {
      if (features.rmsDb < this.noiseRmsDb) {
        this.noiseRmsDb += cfg.noiseAlphaDown * (clampedRmsDb - this.noiseRmsDb);
        this.noiseSpeechBandDb += cfg.noiseAlphaDown * (clampedBandDb - this.noiseSpeechBandDb);
      }
      return;
    }

    const alpha = features.rmsDb > this.noiseRmsDb ? cfg.noiseAlphaUp : cfg.noiseAlphaDown;
    const ceiling = this.noiseRmsDb + cfg.stationaryCeilingMarginDb;
    const boundedRms = Math.min(clampedRmsDb, ceiling);
    this.noiseRmsDb += alpha * (boundedRms - this.noiseRmsDb);
    this.noiseSpeechBandDb += alpha * (clampedBandDb - this.noiseSpeechBandDb);
  }

  update(features, { strictMode = false, nowMs = Date.now() } = {}) {
    const cfg = this.config;
    const frame = classifySpeechFrame(
      features,
      {
        rmsDb: this.noiseRmsDb ?? cfg.maxNoiseFloorRmsDb,
        speechBandDb: this.noiseSpeechBandDb ?? cfg.maxNoiseFloorRmsDb,
      },
      { strictMode, config: cfg }
    );

    if (this.calibrationFrames < cfg.calibrationMinFrames) {
      this._updateNoiseFloor(features, false);
      return { state: this.state, event: null, score: 0, frame, calibrated: false };
    }

    this._updateNoiseFloor(features, frame.isSpeechLike);
    this.score = Math.max(0, Math.min(cfg.maxScore, this.score + frame.scoreDelta));

    let event = null;

    if (this.state === VAD_STATES.IDLE) {
      if (this.score > 0 && frame.isSpeechLike) {
        this.state = VAD_STATES.CANDIDATE;
        this.candidateStartMs = nowMs;
      }
    } else if (this.state === VAD_STATES.CANDIDATE) {
      const elapsed = nowMs - (this.candidateStartMs ?? nowMs);
      if (this.score >= cfg.confirmScore && elapsed >= cfg.minConfirmDurationMs) {
        this.state = VAD_STATES.SPEAKING;
        this.speechStartMs = nowMs;
        this.hadSpeech = true;
        event = 'speech_start';
      } else if (this.score <= 0 || elapsed > cfg.candidateWindowMs) {
        this.state = VAD_STATES.IDLE;
        this.candidateStartMs = null;
        this.score = 0;
      }
    } else if (this.state === VAD_STATES.SPEAKING) {
      const speechElapsed = nowMs - (this.speechStartMs ?? nowMs);
      if (this.score < cfg.hangoverMinScore || speechElapsed > cfg.speechWindowMs) {
        this.state = VAD_STATES.IDLE;
        this.candidateStartMs = null;
        this.speechStartMs = null;
        this.score = 0;
        event = 'speech_end';
      }
    }

    return {
      state: this.state,
      event,
      score: this.score,
      frame,
      calibrated: true,
      hadSpeech: this.hadSpeech,
    };
  }
}
