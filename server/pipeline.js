import { buildTeachingPrompt, shapeSpeechText, TEACHER_SYSTEM_PROMPT } from './prompt/teacherPrompt.js';
import { buildReasoningPrompt, OLLAMA_REASONING_SYSTEM_PROMPT } from './prompt/reasoningPrompt.js';
import { generateExplanation, streamExplanation } from './providers/providerFactory.js';
import { retrieveVerifiedReferences } from './retrieval/referenceEngine.js';

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
  { onMetadata, onToken, onSpeechReady, onInsights, onDone, onError, signal, options = {} } = {}
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
    });
  }

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
      onToken,
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
