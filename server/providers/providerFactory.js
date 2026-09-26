import { callOllama, streamOllama } from './ollamaProvider.js';
import { callGroq, streamGroq } from './groqProvider.js';

export const generateExplanation = async ({
  prompt,
  systemPrompt,
  provider = 'ollama',
  options = {},
}) => {
  const chosenProvider = (provider || 'ollama').toLowerCase().trim();

  if (chosenProvider === 'ollama') {
    return callOllama({
      prompt,
      systemPrompt,
      host: options.OLLAMA_HOST,
      model: options.OLLAMA_MODEL,
      timeoutMs: options.OLLAMA_TIMEOUT_MS,
      maxTokens: options.OLLAMA_MAX_TOKENS,
      fetchFn: options.fetchFn,
    });
  }

  if (chosenProvider === 'groq') {
    return callGroq({
      prompt,
      systemPrompt,
      apiKey: options.GROQ_API_KEY,
      model: options.GROQ_MODEL,
      fetchFn: options.fetchFn,
    });
  }

  const error = new Error(`Unsupported model provider: '${provider}'. Supported providers are 'ollama' and 'groq'.`);
  error.statusCode = 400;
  throw error;
};

export const streamExplanation = async ({
  prompt,
  systemPrompt,
  provider = 'ollama',
  options = {},
  signal,
  onToken,
}) => {
  const chosenProvider = (provider || 'ollama').toLowerCase().trim();

  if (chosenProvider === 'ollama') {
    return streamOllama({
      prompt,
      systemPrompt,
      host: options.OLLAMA_HOST,
      model: options.OLLAMA_MODEL,
      timeoutMs: options.OLLAMA_TIMEOUT_MS,
      maxTokens: options.OLLAMA_MAX_TOKENS,
      signal,
      onToken,
      fetchFn: options.fetchFn,
    });
  }

  if (chosenProvider === 'groq') {
    return streamGroq({
      prompt,
      systemPrompt,
      apiKey: options.GROQ_API_KEY,
      model: options.GROQ_MODEL,
      signal,
      onToken,
      fetchFn: options.fetchFn,
    });
  }

  const error = new Error(`Unsupported model provider: '${provider}'. Supported providers are 'ollama' and 'groq'.`);
  error.statusCode = 400;
  throw error;
};

