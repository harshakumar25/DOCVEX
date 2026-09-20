import { buildTeachingUserPrompt, shapeSpeechText, TEACHER_SYSTEM_PROMPT } from './prompt/teacherPrompt.js';
import { generateExplanation } from './providers/providerFactory.js';
import { retrieveVerifiedReferences } from './retrieval/referenceEngine.js';

/**
 * Full DocVex teaching pipeline:
 * Input -> Verified references (optional/conditional) -> Prompt -> Model -> Speech formatting -> Output
 */
export const teachPipeline = async (
  { text, title = '', url = '', provider },
  options = {}
) => {
  // 1. Conditionally retrieve verified reference context
  let references = [];
  try {
    references = await retrieveVerifiedReferences({
      text,
      title,
      url,
      maxSources: 3,
      timeoutMs: options.RETRIEVAL_TIMEOUT_MS || 4000,
    });
  } catch {
    // Retrieval failure must never break the teaching engine
    references = [];
  }

  // 2. Build structured teaching prompt
  const userPrompt = buildTeachingUserPrompt({
    text,
    title,
    url,
    references,
  });

  // 3. Generate explanation using requested or default provider
  const chosenProvider = provider || options.DEFAULT_PROVIDER || 'ollama';
  const modelResult = await generateExplanation({
    prompt: userPrompt,
    systemPrompt: TEACHER_SYSTEM_PROMPT,
    provider: chosenProvider,
    options,
  });

  // 4. Shape explanation for speech synthesis
  const speechFriendly = shapeSpeechText(modelResult.explanation);

  // 5. Structure clean response with sources
  const sources = references.map((ref) => ({
    title: ref.title,
    url: ref.url,
    domain: ref.domain,
  }));

  return {
    explanation: modelResult.explanation,
    speechFriendly,
    sources,
    provider: modelResult.provider,
    model: modelResult.model,
  };
};
