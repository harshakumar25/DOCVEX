import { TEACHER_SYSTEM_PROMPT } from '../prompt/teacherPrompt.js';

export const callGroq = async ({
  prompt,
  systemPrompt = TEACHER_SYSTEM_PROMPT,
  apiKey,
  model = 'openai/gpt-oss-20b',
  timeoutMs = 30000,
}) => {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    const error = new Error('Groq API key is missing. Set GROQ_API_KEY in the backend environment.');
    error.statusCode = 400;
    throw error;
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 401) {
      const error = new Error('Invalid Groq API key. Check GROQ_API_KEY in your .env file.');
      error.statusCode = 401;
      throw error;
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const message = errBody?.error?.message || response.statusText;
      const error = new Error(`Groq API error (${response.status}): ${message}`);
      error.statusCode = 502;
      throw error;
    }

    const data = await response.json();
    const explanation = data?.choices?.[0]?.message?.content?.trim();

    if (!explanation) {
      const error = new Error('Groq returned an empty response.');
      error.statusCode = 502;
      throw error;
    }

    return {
      explanation,
      provider: 'groq',
      model,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      const timeoutError = new Error(`Groq request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    throw err;
  }
};
