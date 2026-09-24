import fs from 'node:fs';
import path from 'node:path';

// Attempt to load .env file natively if it exists
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
} catch {
  // Gracefully fallback to existing process.env variables
}

const parsePositiveInteger = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePort = (value, fallback = 3000) => {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
};

const parseProvider = (value, fallback = 'ollama') => {
  const normalized = (value || '').toLowerCase().trim();
  if (normalized === 'groq') return 'groq';
  if (normalized === 'hybrid') return 'hybrid';
  if (normalized === 'ollama') return 'ollama';
  return fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

export const config = Object.freeze({
  HOST: (process.env.HOST || '127.0.0.1').trim(),
  PORT: parsePort(process.env.PORT, 3000),
  OLLAMA_HOST: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen3:4b',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_MODEL: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
  DEFAULT_PROVIDER: parseProvider(process.env.DEFAULT_PROVIDER, 'ollama'),
  MAX_SELECTION_LENGTH: parsePositiveInteger(process.env.MAX_SELECTION_LENGTH, 12000),
  CHATTERBOX_ENABLED: parseBoolean(process.env.CHATTERBOX_ENABLED, false),
  CHATTERBOX_PYTHON: process.env.CHATTERBOX_PYTHON || path.resolve(process.cwd(), 'chatterbox/.venv/bin/python'),
  CHATTERBOX_WORKER: process.env.CHATTERBOX_WORKER || path.resolve(process.cwd(), 'chatterbox/docvex_worker.py'),
  CHATTERBOX_MODEL: (process.env.CHATTERBOX_MODEL || '').trim(),
  CHATTERBOX_DEVICE: (process.env.CHATTERBOX_DEVICE || 'auto').trim(),
  CHATTERBOX_TEMP_DIR: process.env.CHATTERBOX_TEMP_DIR || path.resolve(process.cwd(), '.docvex-audio'),
  CHATTERBOX_VOICE_PROMPT: (process.env.CHATTERBOX_VOICE_PROMPT || '').trim(),
  EXTENSION_ORIGIN: (process.env.EXTENSION_ORIGIN || '').trim(),
  CHATTERBOX_STARTUP_TIMEOUT_MS: parsePositiveInteger(process.env.CHATTERBOX_STARTUP_TIMEOUT_MS, 120000),
  CHATTERBOX_REQUEST_TIMEOUT_MS: parsePositiveInteger(process.env.CHATTERBOX_REQUEST_TIMEOUT_MS, 120000),
  CHATTERBOX_MAX_QUEUE: parsePositiveInteger(process.env.CHATTERBOX_MAX_QUEUE, 30),
});

export const helpers = {
  parsePort,
  parsePositiveInteger,
  parseProvider,
  parseBoolean,
};
