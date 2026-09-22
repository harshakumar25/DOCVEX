import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

const MODEL_NAMES = new Set(['standard', 'turbo', 'nano']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const providerError = (message, statusCode = 502, code = 'CHATTERBOX_ERROR') => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export class ChatterboxProvider {
  constructor({
    pythonPath,
    workerPath,
    model,
    device = 'auto',
    tempDir,
    startupTimeoutMs = 120000,
    requestTimeoutMs = 120000,
    maxQueue = 2,
    spawnFn = spawn,
  }) {
    if (!pythonPath || !workerPath || !model || !tempDir) {
      throw providerError('Chatterbox requires explicit Python, worker, model, and temp directory configuration.', 500, 'CHATTERBOX_CONFIG');
    }
    if (!MODEL_NAMES.has(model)) {
      throw providerError(`Unsupported Chatterbox model: ${model}`, 500, 'CHATTERBOX_CONFIG');
    }

    this.pythonPath = pythonPath;
    this.workerPath = workerPath;
    this.model = model;
    this.device = device;
    this.tempDir = path.resolve(tempDir);
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxQueue = maxQueue;
    this.spawnFn = spawnFn;
    this.child = null;
    this.readyPromise = null;
    this.inputClosed = false;
    this.lineBuffer = '';
    this.jobs = [];
    this.activeJob = null;
    this.jobsById = new Map();
  }

  async start() {
    if (this.readyPromise) return this.readyPromise;

    this.inputClosed = false;
    this.readyPromise = new Promise((resolve, reject) => {
      const child = this.spawnFn(this.pythonPath, [
        this.workerPath,
        '--model',
        this.model,
        '--device',
        this.device,
        '--temp-dir',
        this.tempDir,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;

      let settled = false;
      const startupTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.failAll(providerError('Chatterbox worker readiness timed out.', 504, 'CHATTERBOX_STARTUP_TIMEOUT'));
          reject(providerError('Chatterbox worker readiness timed out.', 504, 'CHATTERBOX_STARTUP_TIMEOUT'));
          this.stop();
        }
      }, this.startupTimeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.handleStdout(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', () => {});
      child.once('error', (error) => {
        const workerError = providerError(`Chatterbox worker failed to start: ${error.message}`, 503, 'CHATTERBOX_START_FAILED');
        this.failAll(workerError);
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(workerError);
        }
      });
      child.once('exit', (code, signal) => {
        if (!settled) {
          const workerError = providerError(`Chatterbox worker exited before readiness (code=${code}, signal=${signal || 'none'}).`, 503, 'CHATTERBOX_EXITED');
          settled = true;
          clearTimeout(startupTimer);
          reject(workerError);
        }
        this.failAll(providerError('Chatterbox worker exited.', 503, 'CHATTERBOX_EXITED'));
        this.child = null;
        this.readyPromise = null;
      });

      this.onReady = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        resolve(message);
        this.pump();
      };
    });

    return this.readyPromise;
  }

  handleStdout(chunk) {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(providerError('Chatterbox worker returned invalid control output.', 502, 'CHATTERBOX_PROTOCOL'));
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.type === 'ready') {
      this.onReady?.(message);
      return;
    }
    const job = this.jobsById.get(message.id);
    if (!job) return;

    if (message.type === 'audio') {
      this.jobsById.delete(message.id);
      if (this.activeJob === job) this.activeJob = null;
      if (job.cancelled) {
        this.cleanupAudio(message.file).finally(() => this.pump());
        return;
      }
      try {
        job.resolve({
          fileName: message.file,
          filePath: this.safeAudioPath(message.file),
          sampleRate: message.sample_rate,
          durationSeconds: message.duration_seconds,
          generatedAudioAvailableSeconds: message.generated_audio_available_seconds,
          model: this.model,
        });
      } catch (error) {
        job.reject(error);
      }
      this.pump();
      return;
    }

    if (message.type === 'error') {
      this.jobsById.delete(message.id);
      if (this.activeJob === job) this.activeJob = null;
      if (!job.cancelled) job.reject(providerError(message.error || 'Chatterbox synthesis failed.', 502, message.code || 'SYNTHESIS_FAILED'));
      this.pump();
    }
  }

  safeAudioPath(fileName) {
    if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) {
      throw providerError('Chatterbox returned an invalid audio filename.', 502, 'CHATTERBOX_PROTOCOL');
    }
    const filePath = path.resolve(this.tempDir, fileName);
    if (path.dirname(filePath) !== this.tempDir) {
      throw providerError('Chatterbox returned an audio path outside its temporary directory.', 502, 'CHATTERBOX_PROTOCOL');
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
    await fs.rm(filePath, { force: true });
  }

  async synthesize(text, { requestId, signal } = {}) {
    if (!REQUEST_ID_PATTERN.test(requestId || '')) {
      throw providerError('Chatterbox requestId is invalid.', 400, 'CHATTERBOX_REQUEST');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      throw providerError('Chatterbox text must be a non-empty string of at most 2000 characters.', 400, 'CHATTERBOX_REQUEST');
    }
    if (this.jobs.length >= this.maxQueue) {
      throw providerError('Chatterbox queue is full.', 429, 'CHATTERBOX_QUEUE_FULL');
    }

    await this.start();
    return new Promise((resolve, reject) => {
      const job = {
        id: requestId,
        text: text.trim(),
        resolve,
        reject,
        cancelled: false,
        timer: null,
        abortHandler: null,
      };
      this.jobs.push(job);
      this.jobsById.set(requestId, job);
      if (signal) {
        job.abortHandler = () => this.cancel(requestId);
        if (signal.aborted) job.abortHandler();
        else signal.addEventListener('abort', job.abortHandler, { once: true });
      }
      this.pump();
    });
  }

  pump() {
    if (this.activeJob || !this.child || this.child.killed) return;
    const job = this.jobs.shift();
    if (!job) return;
    if (job.cancelled) {
      this.jobsById.delete(job.id);
      this.pump();
      return;
    }
    this.activeJob = job;
    job.timer = setTimeout(() => {
      this.cancel(job.id, providerError('Chatterbox synthesis timed out.', 504, 'CHATTERBOX_TIMEOUT'));
    }, this.requestTimeoutMs);
    this.child.stdin.write(`${JSON.stringify({ type: 'synthesize', id: job.id, text: job.text })}\n`);
  }

  cancel(requestId, reason = providerError('Chatterbox synthesis cancelled.', 499, 'CHATTERBOX_CANCELLED')) {
    const job = this.jobsById.get(requestId);
    if (!job) return false;
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    job.reject(reason);
    if (this.activeJob === job && this.child && !this.inputClosed) {
      this.child.stdin.write(`${JSON.stringify({ type: 'cancel', id: requestId })}\n`);
      return true;
    }
    this.jobs = this.jobs.filter((queued) => queued !== job);
    this.jobsById.delete(requestId);
    this.pump();
    return true;
  }

  failAll(error) {
    for (const job of this.jobsById.values()) {
      if (job.timer) clearTimeout(job.timer);
      if (!job.cancelled) job.reject(error);
    }
    this.jobs = [];
    this.jobsById.clear();
    this.activeJob = null;
  }

  stop() {
    this.inputClosed = true;
    this.failAll(providerError('Chatterbox worker stopped.', 503, 'CHATTERBOX_STOPPED'));
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.write(`${JSON.stringify({ type: 'shutdown', id: `shutdown-${Date.now()}` })}\n`);
        this.child.stdin.end();
      } catch {
        this.child.kill('SIGTERM');
      }
      const child = this.child;
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM');
      }, 3000);
      killTimer.unref();
    }
    this.child = null;
    this.readyPromise = null;
  }
}
