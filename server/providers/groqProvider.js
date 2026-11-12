import { TEACHER_SYSTEM_PROMPT } from '../prompt/teacherPrompt.js';

/**
 * Statuses Groq returns when temporarily overloaded — safe to retry.
 */
const GROQ_RETRYABLE_STATUSES = new Set([429, 503]);

/**
 * Exponential backoff helper. Waits baseMs * 2^attempt ms before resolving.
 * Respects AbortSignal so retries stop immediately on request cancellation.
 */
const backoff = (attempt, baseMs = 1000, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const delay = baseMs * Math.pow(2, attempt);
    const id = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => { clearTimeout(id); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }, { once: true });
  });

export const callGroq = async ({
  prompt,
  systemPrompt = TEACHER_SYSTEM_PROMPT,
  apiKey,
  model = 'openai/gpt-oss-20b',
  timeoutMs = 30000,
  fetchFn = fetch,
}) => {
  const key = apiKey || process.env.GROQ_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    const error = new Error('Groq API key is missing. Set GROQ_API_KEY in the backend environment.');
    error.statusCode = 400;
    throw error;
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await (fetchFn || fetch)(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.trim()}`,
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

      if (GROQ_RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        // Groq is briefly overloaded — wait and retry
        const errBody = await response.json().catch(() => ({}));
        const message = errBody?.error?.message || response.statusText;
        console.warn(`[DocVex Groq] ${response.status} overload on attempt ${attempt + 1}/${maxRetries + 1}: ${message}. Retrying…`);
        await backoff(attempt, 1000, controller.signal);
        continue;
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
  }

  // Should never reach here, but safety net
  const err = new Error('Groq API overloaded after retries. Try again in a moment.');
  err.statusCode = 503;
  throw err;
};

const RATE_LIMIT_WAIT_MS = 40000;

/**
 * How long Groq asks a caller to wait after a 429: the Retry-After header, or "Please try again in 34.88s"
 * (or "1m2.5s") in the message. Null when it does not say.
 */
export const rateLimitWaitMs = (response, message) => {
  const header = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const match = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(String(message || ''));
  return match ? (Number(match[1] || 0) * 60 + Number(match[2])) * 1000 : null;
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }, { once: true });
});

export const streamGroq = async ({
  prompt,
  systemPrompt = TEACHER_SYSTEM_PROMPT,
  apiKey,
  model = 'openai/gpt-oss-20b',
  timeoutMs = 30000,
  maxTokens = null,
  reasoningEffort = null,
  maxRateLimitWaitMs = RATE_LIMIT_WAIT_MS,
  signal,
  onToken,
  fetchFn = fetch,
}) => {
  const key = apiKey || process.env.GROQ_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    const error = new Error('Groq API key is missing. Set GROQ_API_KEY in the backend environment.');
    error.statusCode = 400;
    throw error;
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await (fetchFn || fetch)(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.trim()}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          stream: true,
          // A smaller answer allowance keeps a request inside a tokens-per-minute quota; low reasoning effort
          // keeps a reasoning model's hidden reasoning from using the answer's share.
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(reasoningEffort && /gpt-oss/.test(model) ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        const error = new Error('Invalid Groq API key. Check GROQ_API_KEY in your .env file.');
        error.statusCode = 401;
        throw error;
      }

      if (GROQ_RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        const errBody = await response.json().catch(() => ({}));
        const message = errBody?.error?.message || response.statusText;
        // A tokens-per-minute limit names its own wait (often ~30 s): wait that long once, nothing has been
        // shown yet. A longer wait is reported plainly instead of leaving the student staring at a spinner.
        const wait = response.status === 429 ? rateLimitWaitMs(response, message) : null;
        if (wait !== null && wait > maxRateLimitWaitMs) {
          const error = new Error(`The model's free quota is used up for now; please try again in about ${Math.ceil(wait / 1000)} seconds.`);
          error.statusCode = 429;
          throw error;
        }
        console.warn(`[DocVex Groq Stream] ${response.status} on attempt ${attempt + 1}/${maxRetries + 1}: ${message}. Retrying${wait ? ` in ${Math.ceil(wait / 1000)} s` : ''}…`);
        if (wait !== null) await sleep(wait + 250, signal);
        else await backoff(attempt, 1000, controller.signal);
        continue;
      }

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const message = errBody?.error?.message || response.statusText;
        const error = new Error(`Groq API error (${response.status}): ${message}`);
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
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') break;
          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const token = data?.choices?.[0]?.delta?.content;
              if (token) {
                fullExplanation += token;
                if (typeof onToken === 'function') {
                  onToken(token);
                }
              }
            } catch {
              // Ignore malformed chunk
            }
          }
        }
      }

      // A reasoning model can end its turn with no visible answer (all of it spent on hidden reasoning).
      // Nothing has been shown yet, so ask again; never report an empty answer as finished.
      if (!fullExplanation.trim()) {
        if (attempt < maxRetries) {
          console.warn(`[DocVex Groq Stream] empty answer on attempt ${attempt + 1}/${maxRetries + 1}. Retrying…`);
          await backoff(attempt, 500, controller.signal);
          continue;
        }
        const error = new Error('Groq returned an empty answer. Please ask again.');
        error.statusCode = 502;
        throw error;
      }

      return {
        explanation: fullExplanation.trim(),
        provider: 'groq',
        model,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        if (signal?.aborted) {
          const abortError = new Error('Groq generation aborted by client.');
          abortError.statusCode = 499;
          throw abortError;
        }
        const timeoutError = new Error(`Groq request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        timeoutError.statusCode = 504;
        throw timeoutError;
      }

      throw err;
    }
  }

  // Should never reach here, but safety net
  const err = new Error('Groq API overloaded after retries. Try again in a moment.');
  err.statusCode = 503;
  throw err;
};

const AUDIO_EXTENSION_BY_MIME = Object.freeze({
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
});

function resolveAudioFilename(mimeType, explicitFileName) {
  if (explicitFileName && typeof explicitFileName === 'string' && explicitFileName.trim()) {
    return explicitFileName.trim();
  }
  const baseMime = String(mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
  const ext = AUDIO_EXTENSION_BY_MIME[baseMime] || 'webm';
  return `speech.${ext}`;
}

/**
 * Transcribe recorded user speech via Groq's OpenAI-compatible Whisper endpoint.
 * Used when browser-native SpeechRecognition is blocked (e.g., Brave browser) or offline.
 */
export const transcribeAudioWithGroq = async ({
  audioBuffer,
  mimeType = 'audio/webm',
  fileName = '',
  apiKey,
  model = 'whisper-large-v3-turbo',
  language = 'en',
  timeoutMs = 20000,
  fetchFn = fetch,
}) => {
  const key = apiKey || process.env.GROQ_API_KEY;
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    const error = new Error('Groq API key is missing. Set GROQ_API_KEY in the backend environment.');
    error.statusCode = 400;
    throw error;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    const error = new Error('Audio payload is empty.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedMime = String(mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  const resolvedName = resolveAudioFilename(normalizedMime, fileName);

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: normalizedMime }), resolvedName);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language && typeof language === 'string' && language.trim()) {
    form.append('language', language.trim());
  }

  const endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key.trim()}`,
      },
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const msg = errorData?.error?.message || `Groq transcription error (${response.status}).`;
      const error = new Error(msg);
      error.statusCode = response.status >= 500 ? 502 : response.status;
      throw error;
    }

    const data = await response.json();
    const text = String(data?.text || '').trim();
    return {
      text,
      provider: 'groq-whisper',
      model,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutError = new Error(`Groq transcription timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw err;
  }
};
