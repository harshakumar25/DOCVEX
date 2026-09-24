import { buildTeachingPrompt, shapeSpeechText, TEACHER_SYSTEM_PROMPT } from './prompt/teacherPrompt.js';
import { buildReasoningPrompt, OLLAMA_REASONING_SYSTEM_PROMPT } from './prompt/reasoningPrompt.js';
import { generateExplanation, streamExplanation } from './providers/providerFactory.js';
import { ChatterboxProvider } from './providers/chatterboxProvider.js';
import { retrieveVerifiedReferences } from './retrieval/referenceEngine.js';
import { SentenceBuffer } from './prompt/sentenceBuffer.js';
import { normalizeSpeechText } from './prompt/speechNormalization.js';

const chatterboxProviders = new WeakMap();

export const getChatterboxProvider = (options) => {
  if (options.chatterboxProvider) return options.chatterboxProvider;
  if (!options.CHATTERBOX_ENABLED) return null;
  if (chatterboxProviders.has(options)) return chatterboxProviders.get(options);

  const provider = new ChatterboxProvider({
    pythonPath: options.CHATTERBOX_PYTHON,
    workerPath: options.CHATTERBOX_WORKER,
    model: options.CHATTERBOX_MODEL,
    device: options.CHATTERBOX_DEVICE,
    tempDir: options.CHATTERBOX_TEMP_DIR,
    voicePrompt: options.CHATTERBOX_VOICE_PROMPT,
    startupTimeoutMs: options.CHATTERBOX_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: options.CHATTERBOX_REQUEST_TIMEOUT_MS,
    maxQueue: options.CHATTERBOX_MAX_QUEUE,
  });
  chatterboxProviders.set(options, provider);
  return provider;
};

const isMeaningfulTeachingSentence = (sentence) => {
  const normalized = sentence.trim().toLowerCase();
  if (normalized.length < 15) return false;
  // Filter out pure assistant pleasantries like "Sure, I can help you with that."
  if (/^(sure[,.]?|okay[,.]?|certainly[,.]?|of course[,.]?|absolutely[,.]?)\s*(i can|here is your|i'll explain)/.test(normalized)) {
    return false;
  }
  if (/^#{1,6}\s|^[\u{1f300}-\u{1faff}]/u.test(sentence)) return false;
  return /[a-z]{3}/i.test(sentence);
};

/**
 * Full DocVex teaching pipeline:
 * Input -> Verified references (pre-fetch triage) -> Prompt with Grounding Truth -> Model -> Speech formatting -> Output
 */
export const teachPipeline = async (
  { text, title = '', url = '', pageContext = '', provider },
  options = {}
) => {
  // 1. Triage and retrieve verified reference context
  let references = [];
  try {
    const retrieveFn = options.retrieveVerifiedReferences || retrieveVerifiedReferences;
    references = await retrieveFn({
      text,
      title,
      url,
      pageContext,
      maxSources: 3,
      timeoutMs: options.RETRIEVAL_TIMEOUT_MS || 2500,
    });
  } catch {
    references = [];
  }

  // 2. Build structured teaching prompt with explicit groundingStatus
  const { userPrompt, groundingStatus, sourceDomains } = buildTeachingPrompt({
    selectedText: text,
    pageTitle: title,
    pageUrl: url,
    evidence: references,
  });

  const sources = references.map((ref) => ({
    title: ref.title,
    url: ref.url,
    domain: ref.domain,
  }));

  const chosenProvider = provider || options.DEFAULT_PROVIDER || 'ollama';

  // Hybrid Mode: Groq provides rapid explanation, Ollama provides background deep reasoning
  if (chosenProvider === 'hybrid') {
    const groqPromise = generateExplanation({
      prompt: userPrompt,
      systemPrompt: TEACHER_SYSTEM_PROMPT,
      provider: 'groq',
      options,
      signal: options.signal,
    });

    const reasoningPrompt = buildReasoningPrompt({
      selectedText: text,
      pageTitle: title,
      evidence: references,
    });
    const ollamaPromise = generateExplanation({
      prompt: reasoningPrompt,
      systemPrompt: OLLAMA_REASONING_SYSTEM_PROMPT,
      provider: 'ollama',
      options,
      signal: options.signal,
    }).catch(() => null);

    const [groqResult, ollamaResult] = await Promise.all([groqPromise, ollamaPromise]);
    const speechFriendly = shapeSpeechText(groqResult.explanation);

    return {
      explanation: groqResult.explanation,
      speechFriendly,
      sources,
      groundingStatus,
      sourceDomains,
      insights: ollamaResult?.explanation || null,
      provider: 'hybrid',
      model: `${groqResult.model} + ${ollamaResult?.model || 'ollama'}`,
    };
  }

  // 3. Generate explanation using requested or default provider
  const modelResult = await generateExplanation({
    prompt: userPrompt,
    systemPrompt: TEACHER_SYSTEM_PROMPT,
    provider: chosenProvider,
    options,
    signal: options.signal,
  });

  // 4. Shape explanation for speech synthesis
  const speechFriendly = shapeSpeechText(modelResult.explanation);

  return {
    explanation: modelResult.explanation,
    speechFriendly,
    sources,
    groundingStatus,
    sourceDomains,
    provider: modelResult.provider,
    model: modelResult.model,
  };
};

/**
 * Real streaming DocVex teaching pipeline:
 * In hybrid mode:
 * 1. Groq streams spoken explanation immediately (<600ms to first sentence).
 * 2. Ollama runs parallel background deep-dive reasoning for summary & gotchas.
 * 3. Emits onSpeechReady when Groq finishes, onInsights when Ollama finishes.
 */
export const streamTeachPipeline = async (
  { text, title = '', url = '', pageContext = '', provider, requestId },
  { onMetadata, onToken, onSpeechReady, onAudioReady, onAudioError, onInsights, onDone, onError, signal, options = {} } = {}
) => {
  let references = [];
  try {
    const retrieveFn = options.retrieveVerifiedReferences || retrieveVerifiedReferences;
    references = await retrieveFn({
      text,
      title,
      url,
      pageContext,
      maxSources: 3,
      timeoutMs: options.RETRIEVAL_TIMEOUT_MS || 2500,
    });
  } catch {
    references = [];
  }

  const { userPrompt, groundingStatus, sourceDomains } = buildTeachingPrompt({
    selectedText: text,
    pageTitle: title,
    pageUrl: url,
    evidence: references,
  });

  const sources = references.map((ref) => ({
    title: ref.title,
    url: ref.url,
    domain: ref.domain,
  }));

  const chosenProvider = provider || options.DEFAULT_PROVIDER || 'ollama';
  const isHybrid = chosenProvider === 'hybrid';
  const voiceProvider = isHybrid ? 'groq' : chosenProvider;
  const chatterbox = getChatterboxProvider(options);
  const audioPromises = [];

  if (chatterbox) {
    chatterbox.start().catch(() => {});
  }

  const modelName = isHybrid
    ? `${options.GROQ_MODEL || 'openai/gpt-oss-20b'} + ${options.OLLAMA_MODEL || 'qwen3:4b'}`
    : (chosenProvider === 'groq' ? (options.GROQ_MODEL || 'openai/gpt-oss-20b') : (options.OLLAMA_MODEL || 'qwen3:4b'));

  if (typeof onMetadata === 'function') {
    onMetadata({
      requestId,
      sources,
      groundingStatus,
      sourceDomains,
      provider: chosenProvider,
      model: modelName,
      isHybrid,
      chatterbox: chatterbox
        ? { enabled: true, model: options.CHATTERBOX_MODEL, nativeIncrementalGeneration: false }
        : { enabled: false },
    });
  }

  const sentenceBuffer = chatterbox
    ? new SentenceBuffer({
        minSentenceLength: 10,
        onSentence: (sentence, sentenceIndex) => {
          if (!isMeaningfulTeachingSentence(sentence)) return;
          const speechText = normalizeSpeechText(sentence);
          const audioPromise = chatterbox
            .synthesize(speechText, { requestId: `${requestId}-sentence-${sentenceIndex}`, signal })
            .then((audio) => {
              if (typeof onAudioReady === 'function') {
                onAudioReady({
                  requestId,
                  sentence,
                  sentenceIndex,
                  speechText,
                  fileName: audio.fileName,
                  sampleRate: audio.sampleRate,
                  durationSeconds: audio.durationSeconds,
                  generatedAudioAvailableSeconds: audio.generatedAudioAvailableSeconds,
                  model: audio.model,
                });
              }
              return audio;
            })
            .catch((error) => {
              console.error('[DocVex Pipeline Audio Error]', error);
              if (typeof onAudioError === 'function') {
                onAudioError({
                  requestId,
                  sentence,
                  sentenceIndex,
                  error: error.message,
                  statusCode: error.statusCode || 502,
                });
              }
              return null;
            });
          audioPromises.push(audioPromise);
        },
      })
    : null;

  // In hybrid mode, dispatch background deep-dive reasoning with Ollama concurrently
  let ollamaPromise = null;
  if (isHybrid) {
    const reasoningPrompt = buildReasoningPrompt({
      selectedText: text,
      pageTitle: title,
      evidence: references,
    });
    ollamaPromise = generateExplanation({
      prompt: reasoningPrompt,
      systemPrompt: OLLAMA_REASONING_SYSTEM_PROMPT,
      provider: 'ollama',
      options,
      signal,
    }).catch(() => null);
  }

  try {
    // Stream voice generation tokens from voice provider (Groq in hybrid mode)
    const modelResult = await streamExplanation({
      prompt: userPrompt,
      systemPrompt: TEACHER_SYSTEM_PROMPT,
      provider: voiceProvider,
      options,
      signal,
      onToken: (token) => {
        onToken?.(token);
        sentenceBuffer?.addToken(token);
      },
    });

    const speechFriendly = shapeSpeechText(modelResult.explanation);

    // Notify client that voice explanation generation is complete
    if (typeof onSpeechReady === 'function') {
      onSpeechReady({
        requestId,
        explanation: modelResult.explanation,
        speechFriendly,
        sources,
        groundingStatus,
      });
    }

    sentenceBuffer?.flush();
    if (audioPromises.length > 0) {
      await Promise.allSettled(audioPromises);
    }

    // Await background Ollama reasoning insights if in hybrid mode
    let insights = null;
    if (ollamaPromise) {
      const ollamaResult = await ollamaPromise;
      if (ollamaResult?.explanation) {
        insights = ollamaResult.explanation;
        if (typeof onInsights === 'function') {
          onInsights({
            requestId,
            insights,
            provider: 'ollama',
            model: ollamaResult.model,
          });
        }
      }
    }

    if (typeof onDone === 'function') {
      onDone({
        requestId,
        explanation: modelResult.explanation,
        speechFriendly,
        sources,
        groundingStatus,
        sourceDomains,
        insights,
        provider: chosenProvider,
        model: modelName,
      });
    }

    return {
      explanation: modelResult.explanation,
      speechFriendly,
      sources,
      groundingStatus,
      sourceDomains,
      insights,
      provider: chosenProvider,
      model: modelName,
    };
  } catch (err) {
    if (typeof onError === 'function') {
      onError(err);
    }
    throw err;
  }
};
