import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getChatterboxProvider, teachPipeline, streamTeachPipeline } from './pipeline.js';
import { transcribeAudioWithGroq } from './providers/groqProvider.js';
import { DEFAULT_TRUSTED_DOMAINS } from './retrieval/trustedSources.js';
import { listPlugins, executePlugin, setPluginEnabled } from './plugins/pluginManager.js';
import {
  config as legalConfig,
  LAW_SYSTEM_PROMPT,
  checkLegalAnswer,
  critiqueAnswer,
  createLawRetriever,
  createLegalStoreLoader,
  handleLawBuddyStaticRoute,
  handleLawBuddyApiRoute,
  LAWBUDDY_FILES,
  LAWBUDDY_SECURITY_HEADERS,
} from '@docvex/lawbuddy';


const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STATIC_TEXT_ASSETS = Object.freeze({
  '/demo': { file: 'demo.html', type: 'text/html; charset=utf-8', missing: 'Dashboard page not found.' },
  '/demo.html': { file: 'demo.html', type: 'text/html; charset=utf-8', missing: 'Dashboard page not found.' },
  '/': { file: 'demo.html', type: 'text/html; charset=utf-8', missing: 'Dashboard page not found.' },
  '/dashboard': { file: 'demo.html', type: 'text/html; charset=utf-8', missing: 'Dashboard page not found.' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8', missing: 'Manifest not found.' },
  '/sw.js': { file: 'sw.js', type: 'application/javascript; charset=utf-8', missing: 'Service worker not found.' },
  '/assets/voiceSelector.js': { file: 'extension/voiceSelector.js', type: 'application/javascript; charset=utf-8', missing: 'Voice selector asset not found.' },
  '/assets/speechCore.js': { file: 'extension/speechCore.js', type: 'application/javascript; charset=utf-8', missing: 'Speech core asset not found.' },
});

const serveStaticTextAsset = (req, res, pathname) => {
  const asset = STATIC_TEXT_ASSETS[pathname];
  if (!asset || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  try {
    const content = readFileSync(path.join(REPO_ROOT, asset.file), 'utf8');
    res.writeHead(200, { 'Content-Type': asset.type });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(content);
    return true;
  } catch {
    sendJson(res, 404, { error: asset.missing }, req);
    return true;
  }
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

// Origin security: Only allow requests from chrome-extension:// origins, local dashboard origins (localhost / 127.0.0.1 / ::1), or non-browser clients (service worker, curl)
const applyOriginSecurity = (req, res) => {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DocVex-Extension-Origin, Accept');
    return true;
  }
  try {
    const parsedOrigin = new URL(origin);
    if (LOCAL_HOSTNAMES.has(parsedOrigin.hostname)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DocVex-Extension-Origin, Accept');
      return true;
    }
  } catch {}
  return false;
};

const sendJson = (res, statusCode, data, req = null) => {
  if (req) {
    applyOriginSecurity(req, res);
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const parseJsonBody = async (req, maxBytes = 1024 * 1024) => {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      // Safeguard against overly large payloads
      if (body.length > maxBytes) {
        rejected = true;
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (rejected) return;
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
export const validateTeachInput = (
  body,
  maxLength = config.MAX_SELECTION_LENGTH,
  defaultProvider = config.DEFAULT_PROVIDER
) => {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const {
    text,
    url,
    title,
    provider,
    pageContext,
    isFollowUp,
    followUpContext,
    followUpSelectedText,
    continueSentences,
  } = body;

  let cleanedContinue = [];
  if (continueSentences !== undefined) {
    if (!Array.isArray(continueSentences)) {
      return { valid: false, error: 'continueSentences must be an array of strings.' };
    }
    cleanedContinue = continueSentences
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (cleanedContinue.length === 0) {
      return { valid: false, error: 'continueSentences must contain at least one sentence.' };
    }
  }

  const hasContinue = cleanedContinue.length > 0;
  if (!hasContinue && (!text || typeof text !== 'string' || text.trim().length === 0)) {
    return { valid: false, error: 'Select some text first.' };
  }

  const trimmedText = typeof text === 'string' && text.trim().length > 0
    ? text.trim()
    : (hasContinue ? 'Continue previous explanation.' : '');
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

  if (followUpContext !== undefined && typeof followUpContext !== 'string') {
    return { valid: false, error: 'followUpContext must be a string if provided.' };
  }

  if (followUpSelectedText !== undefined && typeof followUpSelectedText !== 'string') {
    return { valid: false, error: 'followUpSelectedText must be a string if provided.' };
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
      provider: provider || defaultProvider,
      isFollowUp: Boolean(isFollowUp),
      followUpContext: typeof followUpContext === 'string' ? followUpContext.trim().slice(0, 1200) : '',
      followUpSelectedText: typeof followUpSelectedText === 'string' ? followUpSelectedText.trim() : '',
      continueSentences: cleanedContinue,
    },
  };
};

export const createServer = (options = {}) => {
  const serverConfig = { ...config, ...options };
  let activeUpstreamController = null;

  // LawBuddy lives on its own /lawbuddy routes; /teach stays plain DocVex.
  const legalLibrary = createLegalStoreLoader({ store: serverConfig.legalStore ?? null, dbPath: serverConfig.LEGAL_DB_PATH });
  const lawRetriever = serverConfig.lawRetriever || createLawRetriever({ loader: legalLibrary });
  const LIBRARY_MISSING = 'LawBuddy legal library is not installed. Import and ingest it first, e.g. npm run legal -- ingest-constitution <url>.';

  const server = http.createServer(async (req, res) => {
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
      const chatterbox = getChatterboxProvider(serverConfig);
      return sendJson(res, 200, {
        status: 'ok',
        service: 'DocVex Local Tutor',
        ollama,
        groq: {
          configured: Boolean(serverConfig.GROQ_API_KEY && serverConfig.GROQ_API_KEY.trim().length > 0),
          model: serverConfig.GROQ_MODEL,
        },
        chatterbox: {
          enabled: Boolean(serverConfig.CHATTERBOX_ENABLED),
          model: serverConfig.CHATTERBOX_MODEL,
          ready: Boolean(chatterbox?.isReady?.()),
        },
        defaultProvider: serverConfig.DEFAULT_PROVIDER,
      }, req);
    }

    if (req.method === 'GET' && pathname.startsWith('/audio/')) {
      if (!serverConfig.CHATTERBOX_ENABLED) {
        return sendJson(res, 404, { error: 'Local Chatterbox audio is disabled.' }, req);
      }
      const origin = req.headers.origin || req.headers['x-docvex-extension-origin'] || '';
      const allowedOrigins = (serverConfig.EXTENSION_ORIGIN || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowedOrigins.length === 0) {
        return sendJson(res, 503, { error: 'EXTENSION_ORIGIN must be configured before local audio is served.' }, req);
      }
      const isAllowed =
        (origin.startsWith('chrome-extension://') &&
          (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('http://localhost:');

      if (!isAllowed) {
        console.warn(`[DocVex Audio 403] Origin rejected: "${origin}". Allowed origins:`, allowedOrigins);
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

        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DocVex-Extension-Origin, Accept');
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

    // System Stats Endpoint
    if (req.method === 'GET' && pathname === '/api/system/stats') {
      const ollama = await checkOllamaStatus(serverConfig.OLLAMA_HOST, serverConfig.OLLAMA_MODEL);
      const chatterbox = getChatterboxProvider(serverConfig);
      return sendJson(res, 200, {
        status: 'ok',
        service: 'DocVex Local Tutor',
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        memoryMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
        config: {
          host: serverConfig.HOST,
          port: serverConfig.PORT,
          defaultProvider: serverConfig.DEFAULT_PROVIDER,
          maxSelectionLength: serverConfig.MAX_SELECTION_LENGTH,
          retrievalTimeoutMs: serverConfig.RETRIEVAL_TIMEOUT_MS,
        },
        providers: {
          ollama,
          groq: {
            configured: Boolean(serverConfig.GROQ_API_KEY && serverConfig.GROQ_API_KEY.trim().length > 0),
            model: serverConfig.GROQ_MODEL,
          },
          chatterbox: {
            enabled: Boolean(serverConfig.CHATTERBOX_ENABLED),
            model: serverConfig.CHATTERBOX_MODEL,
            device: serverConfig.CHATTERBOX_DEVICE,
            ready: Boolean(chatterbox?.isReady?.()),
            tempDir: serverConfig.CHATTERBOX_TEMP_DIR,
            sampleRate: serverConfig.CHATTERBOX_TARGET_SR,
            cfmSteps: serverConfig.CHATTERBOX_CFM_STEPS,
          },
        },
      }, req);
    }

    // Speech Transcription Endpoint (fallback when browser SpeechRecognition is blocked e.g. Brave)
    if (req.method === 'POST' && pathname === '/transcribe') {
      let body;
      try {
        body = await parseJsonBody(req, 5 * 1024 * 1024);
      } catch (err) {
        return sendJson(res, 400, { error: err.message }, req);
      }

      const audioBase64 = typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : '';
      if (!audioBase64) {
        return sendJson(res, 400, { error: 'audioBase64 is required.' }, req);
      }

      const cleanBase64 = audioBase64.replace(/^data:[^;]+;base64,/, '');
      const audioBuffer = Buffer.from(cleanBase64, 'base64');
      if (!audioBuffer || audioBuffer.length === 0) {
        return sendJson(res, 400, { error: 'Decoded audio payload is empty.' }, req);
      }

      const transcribeHandler = serverConfig.transcribeHandler || transcribeAudioWithGroq;
      try {
        const result = await transcribeHandler({
          audioBuffer,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'audio/webm',
          fileName: typeof body.fileName === 'string' ? body.fileName : '',
          language: typeof body.language === 'string' ? body.language : 'en',
          apiKey: serverConfig.GROQ_API_KEY,
        });
        return sendJson(res, 200, result, req);
      } catch (err) {
        return sendJson(res, err.statusCode || 502, { error: err.message || 'Audio transcription failed.' }, req);
      }
    }

    // Retrieval Allowlist Domains Endpoint
    if (req.method === 'GET' && pathname === '/api/retrieval/domains') {
      return sendJson(res, 200, {
        domains: DEFAULT_TRUSTED_DOMAINS,
        count: DEFAULT_TRUSTED_DOMAINS.length,
      }, req);
    }

    // Audio Cache Purge Endpoint
    if (req.method === 'POST' && pathname === '/api/cache/purge') {
      const tempDir = serverConfig.CHATTERBOX_TEMP_DIR;
      let filesPurged = 0;
      let bytesFreed = 0;
      try {
        const entries = await fsPromises.readdir(tempDir);
        for (const entry of entries) {
          if (entry.endsWith('.wav')) {
            const fullPath = path.join(tempDir, entry);
            try {
              const st = await fsPromises.stat(fullPath);
              bytesFreed += st.size;
              await fsPromises.unlink(fullPath);
              filesPurged += 1;
            } catch {}
          }
        }
      } catch {
        // Temp directory does not exist or has no wav files
      }
      return sendJson(res, 200, {
        success: true,
        filesPurged,
        bytesFreed,
      }, req);
    }

    // Plugins Registry Endpoint
    if (req.method === 'GET' && pathname === '/api/plugins') {
      const plugins = listPlugins();
      return sendJson(res, 200, {
        success: true,
        plugins,
        count: plugins.length,
      }, req);
    }

    // Plugin Execution Endpoint
    if (req.method === 'POST' && pathname === '/api/plugins/execute') {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message }, req);
      }

      const { pluginId, input } = body;
      if (!pluginId || typeof pluginId !== 'string') {
        return sendJson(res, 400, { error: 'Missing or invalid "pluginId" parameter.' }, req);
      }

      const result = executePlugin(pluginId, input || {});
      const statusCode = result.success ? 200 : 400;
      return sendJson(res, statusCode, result, req);
    }

    // Plugin Toggle Enabled Endpoint
    if (req.method === 'POST' && pathname === '/api/plugins/toggle') {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message }, req);
      }

      const { pluginId, enabled } = body;
      if (!pluginId || typeof pluginId !== 'string' || typeof enabled !== 'boolean') {
        return sendJson(res, 400, { error: 'Missing "pluginId" string or "enabled" boolean.' }, req);
      }

      const updated = setPluginEnabled(pluginId, enabled);
      if (!updated) {
        return sendJson(res, 404, { error: `Plugin "${pluginId}" not found.` }, req);
      }
      return sendJson(res, 200, { success: true, plugin: updated }, req);
    }

    if (serveStaticTextAsset(req, res, pathname)) {
      return;
    }

    // Teach Endpoint
    // LawBuddy website pages and assets (GET /lawbuddy, GET /lawbuddy/teach, /lawbuddy/assets/*)
    if (handleLawBuddyStaticRoute(req, res, pathname, LAWBUDDY_FILES)) {
      return;
    }

    // LawBuddy library API: health, provisions, search and the official old↔new section tables
    if (await handleLawBuddyApiRoute(req, res, {
      pathname,
      parsedUrl,
      legalLibrary,
      sendJson,
      libraryMissingMessage: LIBRARY_MISSING,
      reportOptions: serverConfig,
    })) {
      return;
    }

    if (req.method === 'POST' && (pathname === '/teach' || pathname === '/lawbuddy/teach' || pathname === '/advocatevox/teach')) {
      // Same request/stream contract on both routes; POST /lawbuddy/teach or /advocatevox/teach teaches only from the legal library.
      // LawBuddy answers fit Groq's free tier (8,000 tokens per minute): a short system prompt, a set answer
      // allowance and low reasoning effort.
      const routeOptions = (pathname === '/lawbuddy/teach' || pathname === '/advocatevox/teach')
        ? {
          mode: 'law',
          retrieveVerifiedReferences: lawRetriever,
          checkAnswer: checkLegalAnswer,
          // A critique that cannot run is reported, never silently dropped: the student must know the claims
          // were not read against the law this time.
          critiqueAnswer: (answer, evidence) => critiqueAnswer({ answer, evidence }).catch((error) => {
            console.warn(`[LawBuddy] critique unavailable: ${error.message}`);
            return { unavailable: /429|rate|quota|413|too large/i.test(error.message)
              ? 'the model\'s free quota was used up by the answer itself'
              : 'the checking model did not respond' };
          }),
          systemPrompt: LAW_SYSTEM_PROMPT,
          GROQ_MODEL: legalConfig.LEGAL_ANSWER_MODEL,
          GROQ_MAX_TOKENS: 2600,
          GROQ_REASONING_EFFORT: 'low',
        }
        : {};
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message }, req);
      }

      const validation = validateTeachInput(body, serverConfig.MAX_SELECTION_LENGTH, serverConfig.DEFAULT_PROVIDER);
      if (!validation.valid) {
        return sendJson(res, 400, { error: validation.error }, req);
      }
      // LawBuddy answers only from the grounded stream: hybrid's background local "insights" are not
      // grounded in the official text, so law mode runs Groq (or local Ollama when no Groq key is set).
      if (routeOptions.mode === 'law' && validation.data.provider === 'hybrid') {
        validation.data.provider = serverConfig.GROQ_API_KEY ? 'groq' : 'ollama';
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
          if (!res.writableEnded) {
            currentController.abort();
          }
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

        if (req.headers.origin && isOriginAllowed) {
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
              options: { ...serverConfig, isFollowUp: validation.data.isFollowUp, followUpContext: validation.data.followUpContext, ...routeOptions },
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
        const result = await handler(validation.data, { ...serverConfig, signal: currentController.signal, isFollowUp: validation.data.isFollowUp, followUpContext: validation.data.followUpContext, ...routeOptions });
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

  server.on('close', () => legalLibrary.close());
  return server;
};

// Start the server directly if executed as main
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Error: Port ${config.PORT} is already in use.`);
      console.error(`A previous DocVex server or another process is running on http://${config.HOST}:${config.PORT}.\n`);
      console.error(`To free port ${config.PORT}, run:\n  lsof -ti:${config.PORT} | xargs kill -9\n`);
      process.exit(1);
    } else {
      throw err;
    }
  });
  server.listen(config.PORT, config.HOST, () => {
    console.log(`DocVex server listening on http://${config.HOST}:${config.PORT}`);
    if (config.CHATTERBOX_ENABLED) {
      const chatterbox = getChatterboxProvider(config);
      if (chatterbox) {
        console.log(`[DocVex] Pre-warming local Chatterbox (${config.CHATTERBOX_MODEL} on ${config.CHATTERBOX_DEVICE})…`);
        chatterbox.start().then(() => {
          console.log('[DocVex] Local Chatterbox ready for instant speech synthesis.');
        }).catch((err) => {
          console.warn('[DocVex] Chatterbox pre-warm warning:', err.message);
        });
      }
    }
  });
}
