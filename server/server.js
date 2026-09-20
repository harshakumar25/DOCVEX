import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { teachPipeline } from './pipeline.js';

// Origin security: Only allow requests from chrome-extension:// origins or non-browser clients (service worker, curl)
const applyOriginSecurity = (req, res) => {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  const { text, url, title, provider } = body;

  if (typeof text !== 'string' || text.trim().length === 0) {
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

  if (provider !== undefined && !['ollama', 'groq'].includes(provider)) {
    return { valid: false, error: "Provider must be 'ollama' or 'groq'." };
  }

  return {
    valid: true,
    data: {
      text: trimmedText,
      url: url?.trim() || '',
      title: title?.trim() || '',
      provider: provider || config.DEFAULT_PROVIDER,
    },
  };
};

export const createServer = (options = {}) => {
  const serverConfig = { ...config, ...options };

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

      const handler = serverConfig.teachHandler || teachPipeline;
      try {
        const result = await handler(validation.data, serverConfig);
        return sendJson(res, 200, result, req);
      } catch (err) {
        const statusCode = err.statusCode || 500;
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
