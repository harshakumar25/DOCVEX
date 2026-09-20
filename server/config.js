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
  return normalized === 'groq' ? 'groq' : 'ollama';
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
});

export const helpers = {
  parsePort,
  parsePositiveInteger,
  parseProvider,
};
