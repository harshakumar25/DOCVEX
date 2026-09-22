import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getChatterboxProvider, teachPipeline, streamTeachPipeline } from './pipeline.js';

// Origin security: Only allow requests from chrome-extension:// origins or non-browser clients (service worker, curl)
const applyOriginSecurity = (req, res) => {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DocVex-Extension-Origin');
    return true;
  }
  return false;
};

const sendJson = (res, statusCode, data, req = null) => {
  if (req) {
    applyOriginSecurity(req, res);
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const parseJsonBody = async (req) => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Safeguard against overly large payloads (e.g., max 1MB)
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
};

// Check Ollama service status and downloaded models
export const checkOllamaStatus = async (ollamaHost, targetModel) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${ollamaHost}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return { running: false, host: ollamaHost, modelAvailable: false, model: targetModel, models: [] };
    }

    const data = await response.json();
    const models = Array.isArray(data?.models) ? data.models.map((m) => m.name) : [];
    const modelAvailable = models.some(
      (name) => name === targetModel || name.startsWith(`${targetModel}:`) || targetModel.startsWith(`${name}:`)
    );

    return {
      running: true,
      host: ollamaHost,
      modelAvailable,
      model: targetModel,
      models,
    };
  } catch {
    return {
      running: false,
      host: ollamaHost,
      modelAvailable: false,
      model: targetModel,
      models: [],
    };
  }
};

// Validate request payload for /teach
export const validateTeachInput = (body, maxLength = config.MAX_SELECTION_LENGTH) => {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const { text, url, title, provider, pageContext } = body;

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { valid: false, error: 'Select some text first.' };
  }

  const trimmedText = text.trim();
  if (trimmedText.length > maxLength) {
    return {
      valid: false,
      error: `Selected text exceeds maximum allowed length of ${maxLength} characters.`,
    };
  }

  if (url !== undefined && typeof url !== 'string') {
    return { valid: false, error: 'URL must be a string if provided.' };
  }

  if (title !== undefined && typeof title !== 'string') {
    return { valid: false, error: 'Title must be a string if provided.' };
  }

  if (pageContext !== undefined && typeof pageContext !== 'string') {
    return { valid: false, error: 'pageContext must be a string if provided.' };
  }

  if (provider !== undefined && !['ollama', 'groq', 'hybrid'].includes(provider)) {
    return { valid: false, error: "Provider must be 'ollama', 'groq', or 'hybrid'." };
  }

  return {
    valid: true,
    data: {
      text: trimmedText,
      url: url?.trim() || '',
      title: title?.trim() || '',
      pageContext: pageContext?.trim() || '',
      provider: provider || config.DEFAULT_PROVIDER,
    },
  };
};

export const createServer = (options = {}) => {
  const serverConfig = { ...config, ...options };
  let activeUpstreamController = null;

  return http.createServer(async (req, res) => {
    const isOriginAllowed = applyOriginSecurity(req, res);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      if (!isOriginAllowed) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isOriginAllowed) {
      return sendJson(res, 403, { error: 'Cross-origin requests from web pages are forbidden.' }, req);
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Health Check Endpoint
    if (req.method === 'GET' && pathname === '/health') {
      const ollama = await checkOllamaStatus(serverConfig.OLLAMA_HOST, serverConfig.OLLAMA_MODEL);
      return sendJson(res, 200, {
        status: 'ok',
        service: 'DocVex Local Tutor',
        ollama,
        groq: {
          configured: Boolean(serverConfig.GROQ_API_KEY && serverConfig.GROQ_API_KEY.trim().length > 0),
          model: serverConfig.GROQ_MODEL,
        },
        defaultProvider: serverConfig.DEFAULT_PROVIDER,
      }, req);
    }

    if (req.method === 'GET' && pathname.startsWith('/audio/')) {
      if (!serverConfig.CHATTERBOX_ENABLED) {
        return sendJson(res, 404, { error: 'Local Chatterbox audio is disabled.' }, req);
      }
      const origin = req.headers.origin || req.headers['x-docvex-extension-origin'] || '';
      if (!serverConfig.EXTENSION_ORIGIN) {
        return sendJson(res, 503, { error: 'EXTENSION_ORIGIN must be configured before local audio is served.' }, req);
      }
      if (origin !== serverConfig.EXTENSION_ORIGIN || !origin.startsWith('chrome-extension://')) {
        return sendJson(res, 403, { error: 'Audio is available only to the configured DocVex extension origin.' }, req);
      }

      try {
        const fileName = decodeURIComponent(pathname.slice('/audio/'.length));
        const provider = getChatterboxProvider(serverConfig);
        const filePath = provider.safeAudioPath(fileName);
        const audioStream = createReadStream(filePath);
        audioStream.once('error', () => {
          if (!res.writableEnded) sendJson(res, 404, { error: 'Audio file is unavailable.' }, req);
        });
        audioStream.once('close', () => {
          provider.cleanupAudio(fileName).catch(() => {});
        });
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Cache-Control': 'no-store',
          'Content-Length': statSync(filePath).size,
        });
        audioStream.pipe(res);
        return;
      } catch {
        return sendJson(res, 404, { error: 'Audio file is unavailable.' }, req);
      }
    }

    // Interactive Demo Test Bench Endpoint
    if (req.method === 'GET' && (pathname === '/demo' || pathname === '/')) {
      try {
        const demoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo.html');
        const html = readFileSync(demoPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      } catch {
        return sendJson(res, 404, { error: 'Demo page not found.' }, req);
      }
    }

    // Teach Endpoint
    if (req.method === 'POST' && pathname === '/teach') {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message }, req);
      }

      const validation = validateTeachInput(body, serverConfig.MAX_SELECTION_LENGTH);
      if (!validation.valid) {
        return sendJson(res, 400, { error: validation.error }, req);
      }

      // Server-side supersession: abort any ongoing upstream model inference immediately
      if (activeUpstreamController) {
        activeUpstreamController.abort(new Error('SUPERSEDED: A newer teaching request arrived.'));
        activeUpstreamController = null;
      }

      const currentController = new AbortController();
      activeUpstreamController = currentController;

      const clearActiveController = () => {
        if (activeUpstreamController === currentController) {
          activeUpstreamController = null;
        }
      };

      const isStream = Boolean(body.stream === true || parsedUrl.searchParams.get('stream') === 'true');
      const requestId = body.requestId || `req_${Date.now()}`;

      if (isStream) {
        req.on('close', () => {
          currentController.abort();
          clearActiveController();
        });

        currentController.signal.addEventListener('abort', () => {
          if (!res.writableEnded) {
            sendEvent('error', {
              error: currentController.signal.reason?.message || 'Request aborted or superseded',
              statusCode: 499,
              requestId,
            });
            res.end();
          }
        });

        if (req.headers.origin && req.headers.origin.startsWith('chrome-extension://')) {
          res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const sendEvent = (event, data) => {
          if (!res.writableEnded) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        };

        const streamHandler = serverConfig.streamTeachHandler || streamTeachPipeline;
        try {
          await streamHandler(
            { ...validation.data, requestId },
            {
              onMetadata: (data) => sendEvent('metadata', data),
              onToken: (token) => sendEvent('token', { token, requestId }),
              onSpeechReady: (data) => sendEvent('speech_done', { ...data, requestId }),
              onAudioReady: (data) => sendEvent('audio_ready', { ...data, requestId }),
              onAudioError: (data) => sendEvent('audio_error', { ...data, requestId }),
              onInsights: (data) => sendEvent('local_insights', { ...data, requestId }),
              onDone: (data) => {
                clearActiveController();
                sendEvent('done', data);
                res.end();
              },
              onError: (err) => {
                clearActiveController();
                sendEvent('error', { error: err.message, statusCode: err.statusCode || 500, requestId });
                res.end();
              },
              signal: currentController.signal,
              options: serverConfig,
            }
          );
        } catch (err) {
          clearActiveController();
          if (!res.writableEnded) {
            sendEvent('error', { error: err.message, statusCode: err.statusCode || 500, requestId });
            res.end();
          }
        }
        return;
      }

      req.on('close', () => {
        currentController.abort();
        clearActiveController();
      });

      const handler = serverConfig.teachHandler || teachPipeline;
      try {
        const result = await handler(validation.data, { ...serverConfig, signal: currentController.signal });
        clearActiveController();
        return sendJson(res, 200, result, req);
      } catch (err) {
        clearActiveController();
        const statusCode = err.statusCode || (err.name === 'AbortError' ? 499 : 500);
        return sendJson(res, statusCode, { error: err.message || 'Internal teaching error' }, req);
      }
    }

    // 404 for unknown endpoints
    return sendJson(res, 404, { error: 'Not found' }, req);
  });
};

// Start the server directly if executed as main
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.listen(config.PORT, config.HOST, () => {
    console.log(`DocVex server listening on http://${config.HOST}:${config.PORT}`);
  });
}
