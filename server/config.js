import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// Attempt to load .env file natively if it exists
try {
  const localEnv = path.resolve(process.cwd(), '.env');
  const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
  const envPath = fs.existsSync(localEnv) ? localEnv : (fs.existsSync(rootEnv) ? rootEnv : null);
  if (envPath) {
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
  RETRIEVAL_TIMEOUT_MS: parsePositiveInteger(process.env.RETRIEVAL_TIMEOUT_MS, 2500),
  OLLAMA_BACKGROUND_TIMEOUT_MS: parsePositiveInteger(process.env.OLLAMA_BACKGROUND_TIMEOUT_MS, 25000),
  OLLAMA_BACKGROUND_MAX_TOKENS: parsePositiveInteger(process.env.OLLAMA_BACKGROUND_MAX_TOKENS, 512),
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
  LEGAL_DB_PATH: process.env.LEGAL_DB_PATH || path.resolve(process.cwd(), '.lawbuddy/lawbuddy.db'),
  LEGAL_RAW_DIR: process.env.LEGAL_RAW_DIR || path.resolve(process.cwd(), '.lawbuddy/raw'),
  LEGAL_USER_AGENT: (process.env.LEGAL_USER_AGENT || 'LawBuddyBot/0.1 (+educational legal research)').trim(),
  LEGAL_FETCH_MIN_INTERVAL_MS: parsePositiveInteger(process.env.LEGAL_FETCH_MIN_INTERVAL_MS, 3000),
  LEGAL_FETCH_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_FETCH_TIMEOUT_MS, 30000),
  LEGAL_FETCH_MAX_BYTES: parsePositiveInteger(process.env.LEGAL_FETCH_MAX_BYTES, 50 * 1024 * 1024),
  LEGAL_PYTHON: process.env.LEGAL_PYTHON || path.resolve(process.cwd(), 'workers/.venv/bin/python'),
  LEGAL_PDF_WORKER: process.env.LEGAL_PDF_WORKER || path.resolve(process.cwd(), 'workers/pdf_extract.py'),
  LEGAL_PDF_TIMEOUT_MS: parsePositiveInteger(process.env.LEGAL_PDF_TIMEOUT_MS, 300000),
});

export const helpers = {
  parsePort,
  parsePositiveInteger,
  parseProvider,
  parseBoolean,
};
