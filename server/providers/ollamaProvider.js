import { TEACHER_SYSTEM_PROMPT } from '../prompt/teacherPrompt.js';

export const callOllama = async ({
  prompt,
  systemPrompt = TEACHER_SYSTEM_PROMPT,
  host = 'http://127.0.0.1:11434',
  model = 'qwen3:4b',
  timeoutMs = 60000,
}) => {
  const cleanHost = host.replace(/\/+$/, '');
  const endpoint = `${cleanHost}/api/chat`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 404) {
      const error = new Error(`Model ${model} is unavailable. Run: ollama pull ${model}`);
      error.statusCode = 502;
      throw error;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (errText.toLowerCase().includes('not found') || errText.toLowerCase().includes('model')) {
        const error = new Error(`Model ${model} is unavailable. Run: ollama pull ${model}`);
        error.statusCode = 502;
        throw error;
      }
      const error = new Error(`Ollama API error (${response.status}): ${errText || response.statusText}`);
      error.statusCode = 502;
      throw error;
    }

    const data = await response.json();
    const explanation = data?.message?.content?.trim();

    if (!explanation) {
      const error = new Error('Ollama returned an empty response.');
      error.statusCode = 502;
      throw error;
    }

    return {
      explanation,
      provider: 'ollama',
      model,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      const timeoutError = new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed')) {
      const connError = new Error('Ollama is not running. Start Ollama and try again.');
      connError.statusCode = 503;
      throw connError;
    }

    throw err;
  }
};
