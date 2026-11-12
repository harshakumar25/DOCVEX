
import { buildReasoningPrompt, OLLAMA_REASONING_SYSTEM_PROMPT } from './prompt/reasoningPrompt.js';
import { generateExplanation, streamExplanation } from './providers/providerFactory.js';
import { ChatterboxProvider } from './providers/chatterboxProvider.js';
import { retrieveVerifiedReferences } from './retrieval/referenceEngine.js';
import { SentenceBuffer } from './prompt/sentenceBuffer.js';
import { normalizeSpeechText } from './prompt/speechNormalization.js';

// One worker per distinct Chatterbox configuration. Keyed by the settings themselves, not by the options
// object: the server builds a fresh options object per request, and keying on identity spawned a new
// model-loading worker for every request (and left /health watching a provider that never started).
const chatterboxProviders = new Map();

export const getChatterboxProvider = (options) => {
  if (options.chatterboxProvider) return options.chatterboxProvider;
  if (!options.CHATTERBOX_ENABLED) return null;
  const key = ChatterboxProvider.cacheKey(options);
  if (chatterboxProviders.has(key)) return chatterboxProviders.get(key);

  const provider = ChatterboxProvider.fromConfig(options);
  chatterboxProviders.set(key, provider);
  return provider;
};

// Sources shown to clients; legal evidence also carries what the LawBuddy page needs to open the cited text.
const toSource = (ref) => ({
  title: ref.title,
  url: ref.url,
  domain: ref.domain,
  ...(ref.kind ? { kind: ref.kind } : {}),
  ...(ref.label ? { label: ref.label } : {}),
  ...(ref.lookup ? { lookup: ref.lookup } : {}),
  ...(ref.via ? { via: ref.via } : {}),
  ...(ref.act ? { act: ref.act } : {}),
  ...(ref.role ? { role: ref.role } : {}),
});

// LawBuddy's rule, enforced in code rather than asked of the model: with no official text there is
// nothing to teach from, so no model is called. (A prompt saying "do not answer from memory" is not a
// guarantee: models do answer anyway.)
export const LAW_NO_TEXT_REPLY = 'LawBuddy has no official text for this question, so it will not answer it from memory. '
  + 'Try asking about a specific Article, Schedule or section, such as Article 21 of the Constitution.';
const lawNoTextReply = (references) => {
  if (!references?.analysis?.concepts?.some((concept) => concept.id === 'unauthorised-security-testing')) return LAW_NO_TEXT_REPLY;
  const missing = references.analysis.coverage?.missing?.filter((item) => item.act === 'IT2000') || [
    { label: 's.43' }, { label: 's.66' },
  ];
  const sections = missing.length === 1 ? `section ${missing[0].label.slice(2)}` : `sections ${missing.map((item) => item.label.slice(2)).join(' and ')}`;
  const coverage = missing.map((item) => item.reviewedThrough
    ? `section ${item.label.slice(2)} was reviewed only through ${item.reviewedThrough}`
    : `section ${item.label.slice(2)} has no indexed verified text`).join('; ');
  return `This is a cyber-law question about security testing and a case against the researcher. LawBuddy needs ${sections} of the Information Technology Act, 2000 for this question, but ${coverage}. It cannot assess the case for the requested date. Read the relevant provisions in India Code and consult an Indian cybercrime lawyer if a complaint or FIR has been filed.`;
};
const NO_MODEL = 'none: declined without official text';
const declinesWithoutText = (options, groundingStatus) => options.mode === 'law' && groundingStatus !== 'grounded';

// LawBuddy's answer check (law mode): which citations and quotations in the finished answer are tied to the
// official text it was given. Injected by the /lawbuddy route; other modes have none.
const checkAnswer = (options, explanation, references) => {
  if (typeof options.checkAnswer !== 'function') return null;
  try {
    return options.checkAnswer(explanation, references);
  } catch {
    return null;
  }
};

// LawBuddy's critique (law mode): an independent model reads each claim beside the provision it cites.
// Injected by the /lawbuddy route; it never fails the answer.
const critiqueAnswer = async (options, explanation, references) => {
  if (typeof options.critiqueAnswer !== 'function') return null;
  try {
    return await options.critiqueAnswer(explanation, references);
  } catch {
    return null;
  }
};

// What LawBuddy made of the question (its kind and legal concepts), for the page to show.
const describeAnalysis = (references) => (references?.analysis
  ? {
    kind: references.analysis.kind,
    concepts: references.analysis.concepts,
    ...(references.analysis.warnings?.length ? { warnings: references.analysis.warnings } : {}),
    ...(references.analysis.coverage ? { coverage: references.analysis.coverage } : {}),
  }
  : null);

/** The fixed reply, delivered word by word like a model stream so clients and voice work unchanged. */
const replyWithoutModel = (reply, onToken) => {
  for (const piece of reply.match(/\S+\s*/g)) onToken?.(piece);
  return { explanation: reply, provider: 'lawbuddy', model: NO_MODEL };
};

const isMeaningfulTeachingSentence = (sentence) => {
  const normalized = sentence.trim().toLowerCase();
  if (normalized.length < 8) return false;
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

  // LawBuddy (mode 'law') grounds follow-ups like fresh questions instead of answering from context.
  const isFollowUp = Boolean(options.isFollowUp || false) && options.mode !== 'law';

  // Follow-up: use warm context-aware prompt instead of cold teaching prompt
  let userPrompt, groundingStatus, sourceDomains, sources;
  if (isFollowUp) {
    userPrompt = buildFollowUpPrompt({
      followUpQuestion: text,
      previousContext: options.followUpContext || '',
    });
    groundingStatus = 'ungrounded';
    sourceDomains = [];
    sources = [];
  } else {
    // 2. Build structured teaching prompt with explicit groundingStatus
    const result = buildTeachingPrompt({
      selectedText: text,
      pageTitle: title,
      pageUrl: url,
      evidence: references,
      mode: options.mode,
      analysis: references.analysis ?? null,
    });
    userPrompt = result.userPrompt;
    groundingStatus = result.groundingStatus;
    sourceDomains = result.sourceDomains;
    sources = references.map(toSource);
  }

  // A route may bring its own system prompt (LawBuddy's law tutor); DocVex's narrator is the default.
  const activeSystemPrompt = isFollowUp ? DOCY_FOLLOWUP_SYSTEM_PROMPT : (options.systemPrompt || TEACHER_SYSTEM_PROMPT);

  if (declinesWithoutText(options, groundingStatus)) {
    const reply = lawNoTextReply(references);
    return {
      explanation: reply,
      speechFriendly: shapeSpeechText(reply),
      sources,
      groundingStatus,
      sourceDomains,
      provider: 'lawbuddy',
      model: NO_MODEL,
    };
  }
  const chosenProvider = provider || options.DEFAULT_PROVIDER || 'ollama';

  // Hybrid Mode: Groq provides rapid explanation, Ollama provides background deep reasoning
  if (chosenProvider === 'hybrid') {
    const groqPromise = generateExplanation({
      prompt: userPrompt,
      systemPrompt: activeSystemPrompt,
      provider: 'groq',
      options,
      signal: options.signal,
    });

    const isSubstantialTechnicalText =
      (text || '').trim().length >= 25 &&
      !/^(hi+|hello+|hey+|yo+|what'?s\s*up|greetings|hola)\b/i.test((text || '').trim());

    let ollamaPromise = Promise.resolve(null);
    if (isSubstantialTechnicalText) {
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
        signal: options.signal,
      }).catch(() => null);
    }

    const [groqResult, ollamaResult] = await Promise.all([groqPromise, ollamaPromise]);
    const speechFriendly = shapeSpeechText(groqResult.explanation);

    return {
      explanation: groqResult.explanation,
      speechFriendly,
      sources,
      groundingStatus,
      sourceDomains,
      analysis: describeAnalysis(references),
      check: checkAnswer(options, groqResult.explanation, references),
      insights: ollamaResult?.explanation || null,
      provider: 'hybrid',
      model: `${groqResult.model} + ${ollamaResult?.model || 'ollama'}`,
    };
  }

  // 3. Generate explanation using requested or default provider
  const modelResult = await generateExplanation({
    prompt: userPrompt,
    systemPrompt: activeSystemPrompt,
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
    analysis: describeAnalysis(references),
    check: checkAnswer(options, modelResult.explanation, references),
    critique: await critiqueAnswer(options, modelResult.explanation, references),
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

  // LawBuddy (mode 'law') grounds follow-ups like fresh questions instead of answering from context.
  const isFollowUp = Boolean(options.isFollowUp || false) && options.mode !== 'law';

  let userPrompt, groundingStatus, sourceDomains, sources;
  if (isFollowUp) {
    // Skip retrieval for follow-ups — the context is already in previousContext
    userPrompt = buildFollowUpPrompt({
      followUpQuestion: text,
      previousContext: options.followUpContext || '',
    });
    groundingStatus = 'ungrounded';
    sourceDomains = [];
    sources = [];
  } else {
    const result = buildTeachingPrompt({
      selectedText: text,
      pageTitle: title,
      pageUrl: url,
      evidence: references,
      mode: options.mode,
      analysis: references.analysis ?? null,
    });
    userPrompt = result.userPrompt;
    groundingStatus = result.groundingStatus;
    sourceDomains = result.sourceDomains;
    sources = references.map(toSource);
  }

  // A route may bring its own system prompt (LawBuddy's law tutor); DocVex's narrator is the default.
  const activeSystemPrompt = isFollowUp ? DOCY_FOLLOWUP_SYSTEM_PROMPT : (options.systemPrompt || TEACHER_SYSTEM_PROMPT);
  const declineWithoutText = declinesWithoutText(options, groundingStatus);

  const chosenProvider = provider || options.DEFAULT_PROVIDER || 'ollama';
  const isHybrid = chosenProvider === 'hybrid';
  const voiceProvider = isHybrid ? 'groq' : chosenProvider;
  const chatterbox = getChatterboxProvider(options);
  const audioPromises = [];
  const loggedAudioErrorCodes = new Set();

  if (chatterbox) {
    chatterbox.start().catch(() => {});
  }

  const reportedProvider = declineWithoutText ? 'lawbuddy' : chosenProvider;
  const modelName = declineWithoutText
    ? NO_MODEL
    : isHybrid
      ? `${options.GROQ_MODEL || 'openai/gpt-oss-20b'} + ${options.OLLAMA_MODEL || 'qwen3:4b'}`
      : (chosenProvider === 'groq' ? (options.GROQ_MODEL || 'openai/gpt-oss-20b') : (options.OLLAMA_MODEL || 'qwen3:4b'));

  if (typeof onMetadata === 'function') {
    onMetadata({
      requestId,
      sources,
      groundingStatus,
      sourceDomains,
      analysis: describeAnalysis(references),
      provider: reportedProvider,
      model: modelName,
      isHybrid: isHybrid && !declineWithoutText,
      chatterbox: chatterbox
        ? { enabled: true, model: options.CHATTERBOX_MODEL, nativeIncrementalGeneration: false }
        : { enabled: false },
    });
  }

  const sentenceBuffer = chatterbox
    ? new SentenceBuffer({
        minSentenceLength: 4,
        onSentence: (sentence, sentenceIndex, pauseAfterMs = 0) => {
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
                  pauseAfterMs,
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
              if (signal?.aborted || error.code === 'CHATTERBOX_CANCELLED' || error.name === 'AbortError') {
                return null;
              }
              // One log line per error kind per request, not one stack trace per sentence.
              if (!loggedAudioErrorCodes.has(error.code)) {
                loggedAudioErrorCodes.add(error.code);
                console.error(`[DocVex Pipeline Audio Error] ${error.code || 'AUDIO_ERROR'}: ${error.message}`);
              }
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

  // In hybrid mode, dispatch background deep-dive reasoning with Ollama concurrently (skip for trivial greetings and follow-ups).
  // Ollama is fire-and-forget — it must NEVER block onDone. Insights arrive later via onInsights.
  let ollamaPromise = null;
  const isSubstantialTechnicalText =
    (text || '').trim().length >= 25 &&
    !/^(hi+|hello+|hey+|yo+|what'?s\s*up|greetings|hola)\b/i.test((text || '').trim());
  if (isHybrid && isSubstantialTechnicalText && !isFollowUp && !declineWithoutText) {

    const reasoningPrompt = buildReasoningPrompt({
      selectedText: text,
      pageTitle: title,
      evidence: references,
    });
    // Hard caps: configurable timeout + max tokens to prevent qwen3 from running indefinitely
    ollamaPromise = generateExplanation({
      prompt: reasoningPrompt,
      systemPrompt: OLLAMA_REASONING_SYSTEM_PROMPT,
      provider: 'ollama',
      options: {
        ...options,
        OLLAMA_TIMEOUT_MS: options.OLLAMA_BACKGROUND_TIMEOUT_MS || 25000,
        OLLAMA_MAX_TOKENS: options.OLLAMA_BACKGROUND_MAX_TOKENS || 512,
      },
      signal,
    }).catch(() => null);
  }

  try {
    // Stream voice generation tokens from voice provider (Groq in hybrid mode)
    let modelResult;
    let usedVoiceProvider = voiceProvider;
    const forward = (token) => {
      onToken?.(token);
      sentenceBuffer?.addToken(token);
    };
    try {
      modelResult = declineWithoutText
        ? replyWithoutModel(lawNoTextReply(references), forward)
        : await streamExplanation({
          prompt: userPrompt,
          systemPrompt: activeSystemPrompt,
          provider: voiceProvider,
          options,
          signal,
          onToken: forward,
        });
    } catch (voiceErr) {
      // Groq is overloaded or unavailable — fall back to Ollama for the voice stream
      if (isHybrid && (voiceErr.statusCode === 503 || voiceErr.statusCode === 502 || voiceErr.statusCode === 504)) {
        console.warn('[DocVex Pipeline] Groq voice provider failed, falling back to Ollama for voice stream.');
        usedVoiceProvider = 'ollama';
        // Cancel any pending Ollama background insights so we don't run two Ollama calls concurrently
        ollamaPromise = null;
        modelResult = await streamExplanation({
          prompt: userPrompt,
          systemPrompt: activeSystemPrompt,
          provider: 'ollama',
          options,
          signal,
          onToken: forward,
        });
      } else {
        throw voiceErr;
      }
    }

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

    const check = checkAnswer(options, modelResult.explanation, references);
    // The answer has streamed (and is being spoken); the critique follows before "done".
    const critique = await critiqueAnswer(options, modelResult.explanation, references);
    // Fire onDone immediately after voice provider — do NOT await Ollama here.
    if (typeof onDone === 'function') {
      onDone({
        requestId,
        explanation: modelResult.explanation,
        speechFriendly,
        sources,
        groundingStatus,
        sourceDomains,
        check,
        critique,
        provider: reportedProvider,
        model: usedVoiceProvider !== voiceProvider
          ? `${usedVoiceProvider} (groq-fallback)`
          : modelName,
      });
    }

    // Background: resolve Ollama and emit insights asynchronously (after SSE done)
    if (ollamaPromise) {
      ollamaPromise.then((ollamaResult) => {
        if (ollamaResult?.explanation && typeof onInsights === 'function') {
          onInsights({
            requestId,
            insights: ollamaResult.explanation,
            provider: 'ollama',
            model: ollamaResult.model,
          });
        }
      }).catch(() => {});
    }

    return {
      explanation: modelResult.explanation,
      speechFriendly,
      sources,
      groundingStatus,
      sourceDomains,
      check,
      critique,
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
