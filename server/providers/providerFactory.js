import { callOllama } from './ollamaProvider.js';
import { callGroq } from './groqProvider.js';

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
    });
  }

  if (chosenProvider === 'groq') {
    return callGroq({
      prompt,
      systemPrompt,
      apiKey: options.GROQ_API_KEY,
      model: options.GROQ_MODEL,
    });
  }

  const error = new Error(`Unsupported model provider: '${provider}'. Supported providers are 'ollama' and 'groq'.`);
  error.statusCode = 400;
  throw error;
};
