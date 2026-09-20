import { TEACHER_SYSTEM_PROMPT } from '../prompt/teacherPrompt.js';

export const callOllama = async ({
  prompt,
  systemPrompt = TEACHER_SYSTEM_PROMPT,
  host = 'http://127.0.0.1:11434',
  model = 'qwen3:4b',
  timeoutMs = 60000,
  fetchFn = fetch,
}) => {
  const cleanHost = host.replace(/\/+$/, '');
  const endpoint = `${cleanHost}/api/chat`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (fetchFn || fetch)(endpoint, {
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

export const streamOllama = async ({
  prompt,
  systemPrompt = TEACHER_SYSTEM_PROMPT,
  host = 'http://127.0.0.1:11434',
  model = 'qwen3:4b',
  timeoutMs = 60000,
  signal,
  onToken,
  fetchFn = fetch,
}) => {
  const cleanHost = host.replace(/\/+$/, '');
  const endpoint = `${cleanHost}/api/chat`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await (fetchFn || fetch)(endpoint, {
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
        stream: true,
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

    let fullExplanation = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const token = parsed?.message?.content;
          if (token) {
            fullExplanation += token;
            if (typeof onToken === 'function') {
              onToken(token);
            }
          }
          if (parsed.done) {
            break;
          }
        } catch {
          // Ignore malformed chunk
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        const token = parsed?.message?.content;
        if (token) {
          fullExplanation += token;
          if (typeof onToken === 'function') {
            onToken(token);
          }
        }
      } catch {
        // Ignore
      }
    }

    return {
      explanation: fullExplanation.trim(),
      provider: 'ollama',
      model,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      if (signal?.aborted) {
        const abortError = new Error('Ollama generation aborted by client.');
        abortError.statusCode = 499;
        throw abortError;
      }
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
