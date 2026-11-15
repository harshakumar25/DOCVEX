import fs from 'node:fs/promises';
import path from 'node:path';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const providerError = (message, statusCode = 502, code = 'GNANI_ERROR') => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export class GnaniProvider {
  static cacheKey(options = {}) {
    return JSON.stringify([
      options.GNANI_API_KEY || '',
      options.GNANI_BASE_URL || 'https://api.vachana.ai',
      options.GNANI_MODEL || 'timbre-v2.5',
      options.GNANI_VOICE || 'Deepak',
      options.GNANI_LANGUAGE || 'en-IN',
      options.GNANI_SPEED ?? 1.0,
      options.GNANI_TARGET_SR ?? 24000,
      options.CHATTERBOX_TEMP_DIR || '.docvex-audio',
    ]);
  }

  static fromConfig(options = {}) {
    return new GnaniProvider({
      apiKey: options.GNANI_API_KEY,
      baseUrl: options.GNANI_BASE_URL,
      model: options.GNANI_MODEL,
      voice: options.GNANI_VOICE,
      language: options.GNANI_LANGUAGE,
      speed: options.GNANI_SPEED,
      targetSampleRate: options.GNANI_TARGET_SR ?? 24000,
      tempDir: options.CHATTERBOX_TEMP_DIR || path.resolve(process.cwd(), '.docvex-audio'),
      timeoutMs: options.GNANI_TIMEOUT_MS ?? 15000,
      fetchFn: options.fetchFn || globalThis.fetch,
    });
  }

  constructor({
    apiKey,
    baseUrl = 'https://api.vachana.ai',
    model = 'timbre-v2.5',
    voice = 'Deepak',
    language = 'en-IN',
    speed = 1.0,
    targetSampleRate = 24000,
    tempDir = '.docvex-audio',
    timeoutMs = 15000,
    fetchFn = globalThis.fetch,
  } = {}) {
    const cleanKey = (apiKey || '').trim();
    if (!cleanKey) {
      throw providerError('Gnani API key is required.', 500, 'GNANI_CONFIG');
    }

    this.apiKey = cleanKey;
    this.baseUrl = (baseUrl || 'https://api.vachana.ai').replace(/\/+$/, '');
    this.model = (model || 'timbre-v2.5').trim();
    this.voice = (voice || 'Deepak').trim();
    this.language = (language || 'en-IN').trim();
    this.speed = typeof speed === 'number' && Number.isFinite(speed) ? speed : 1.0;
    this.targetSampleRate = typeof targetSampleRate === 'number' && targetSampleRate > 0 ? targetSampleRate : 24000;
    this.tempDir = path.resolve(tempDir);
    this.timeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 15000;
    this.fetchFn = fetchFn;
    this.providerName = 'gnani';
    this.jobs = [];
    this.active = false;
    this.lastRequestTime = 0;
    this.minIntervalMs = 120;
    this.maxRetries = 2;
  }

  get modelString() {
    return `gnani:${this.model}:${this.voice}`;
  }

  isReady() {
    return Boolean(this.apiKey && this.apiKey.length > 0);
  }

  async start() {
    await fs.mkdir(this.tempDir, { recursive: true });
    return true;
  }

  stop() {
    // Stateless HTTP provider; nothing to terminate
  }

  safeAudioPath(fileName) {
    if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) {
      throw providerError('Gnani returned an invalid audio filename.', 502, 'GNANI_PROTOCOL');
    }
    const filePath = path.resolve(this.tempDir, fileName);
    if (path.dirname(filePath) !== this.tempDir) {
      throw providerError('Gnani audio path is outside temporary directory.', 502, 'GNANI_PROTOCOL');
    }
    return filePath;
  }

  async cleanupAudio(fileNameOrPath) {
    let filePath;
    try {
      filePath = fileNameOrPath.startsWith(this.tempDir) ? path.resolve(fileNameOrPath) : this.safeAudioPath(fileNameOrPath);
    } catch {
      return;
    }
    if (path.dirname(filePath) !== this.tempDir) return;
    await fs.rm(filePath, { force: true }).catch(() => {});
  }

  async synthesize(text, { requestId, signal } = {}) {
    if (!REQUEST_ID_PATTERN.test(requestId || '')) {
      throw providerError('Gnani requestId is invalid.', 400, 'GNANI_REQUEST');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      throw providerError('Gnani text must be a non-empty string of at most 2000 characters.', 400, 'GNANI_REQUEST');
    }

    await this.start();

    return new Promise((resolve, reject) => {
      const job = {
        requestId,
        text: text.trim(),
        signal,
        resolve,
        reject,
        cancelled: false,
      };

      if (signal) {
        if (signal.aborted) {
          job.cancelled = true;
          reject(signal.reason || providerError('Gnani synthesis cancelled.', 499, 'GNANI_CANCELLED'));
          return;
        }
        signal.addEventListener('abort', () => {
          job.cancelled = true;
          reject(signal.reason || providerError('Gnani synthesis cancelled.', 499, 'GNANI_CANCELLED'));
        }, { once: true });
      }

      this.jobs.push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.active || this.jobs.length === 0) return;
    const job = this.jobs.shift();
    if (!job) return;
    if (job.cancelled) {
      this.pump();
      return;
    }

    this.active = true;
    try {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
      }
      this.lastRequestTime = Date.now();
      const result = await this._executeJobWithRetry(job);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      this.active = false;
      this.pump();
    }
  }

  async _executeJobWithRetry(job, attempt = 0) {
    try {
      return await this._executeSingleRequest(job);
    } catch (err) {
      if (err.code === 'GNANI_RATE_LIMITED' && attempt < this.maxRetries && !job.cancelled) {
        const isTestEnv = Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' || (process.execArgv && process.execArgv.includes('--test')));
        const backoff = (isTestEnv ? 2 : 350) * (attempt + 1);
        await new Promise((r) => setTimeout(r, backoff));
        return this._executeJobWithRetry(job, attempt + 1);
      }
      throw err;
    }
  }

  async _executeSingleRequest({ text, requestId, signal }) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(providerError(`Gnani TTS request timed out after ${this.timeoutMs}ms`, 504, 'GNANI_TIMEOUT'));
    }, this.timeoutMs);

    const onAbort = () => controller.abort(signal.reason || providerError('Gnani synthesis cancelled.', 499, 'GNANI_CANCELLED'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const payload = {
        text: text.trim(),
        model: this.model,
        voice: this.voice,
        language: this.language,
        speed: this.speed,
        audio_config: {
          container: 'wav',
          sample_rate: this.targetSampleRate,
        },
      };

      const endpoint = `${this.baseUrl}/api/v1/tts/inference`;
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key-ID': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errMessage = `Gnani TTS failed with HTTP ${response.status}`;
        try {
          const errData = await response.json();
          if (errData?.message) errMessage = errData.message;
          else if (errData?.error) errMessage = errData.error;
        } catch {
          // Non-JSON error body
        }

        if (response.status === 401 || response.status === 403) {
          throw providerError(`Gnani authentication error: ${errMessage}`, 502, 'GNANI_AUTH_FAILED');
        }
        if (response.status === 429) {
          throw providerError(`Gnani rate limit exceeded: ${errMessage}`, 429, 'GNANI_RATE_LIMITED');
        }
        throw providerError(errMessage, response.status >= 500 ? 502 : response.status, 'GNANI_SYNTHESIS_FAILED');
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length < 44 || buffer.toString('utf8', 0, 4) !== 'RIFF' || buffer.toString('utf8', 8, 12) !== 'WAVE') {
        throw providerError('Gnani returned malformed or non-WAV audio data.', 502, 'GNANI_INVALID_AUDIO');
      }

      // Fix streaming 0xFFFFFFFF RIFF header sizes if present so browser AudioContext/Audio elements get clean metadata
      const totalLen = buffer.length;
      const riffSize = totalLen - 8;
      if (buffer.readUInt32LE(4) === 0xFFFFFFFF) {
        buffer.writeUInt32LE(riffSize, 4);
      }
      const dataOffset = buffer.indexOf('data', 12);
      if (dataOffset !== -1 && dataOffset + 8 <= buffer.length) {
        if (buffer.readUInt32LE(dataOffset + 4) === 0xFFFFFFFF) {
          const actualDataSize = buffer.length - (dataOffset + 8);
          buffer.writeUInt32LE(actualDataSize, dataOffset + 4);
        }
      }

      const durationSeconds = Number(((totalLen - 44) / (this.targetSampleRate * 2)).toFixed(2));
      const safeId = requestId.replace(/[^A-Za-z0-9_-]/g, '_');
      const fileName = `gnani-${safeId}-${Date.now()}.wav`;
      const filePath = this.safeAudioPath(fileName);

      await fs.writeFile(filePath, buffer);

      return {
        fileName,
        filePath,
        sampleRate: this.targetSampleRate,
        durationSeconds,
        generatedAudioAvailableSeconds: durationSeconds,
        model: this.modelString,
        provider: 'gnani',
      };
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        throw controller.signal.reason || providerError('Gnani synthesis cancelled.', 499, 'GNANI_CANCELLED');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
