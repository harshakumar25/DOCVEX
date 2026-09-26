/**
 * DocVex — Background Reasoning Prompt Builder
 * Used by Ollama for deep-dive mental models, architectural gotchas, and executive summaries.
 */

export const OLLAMA_REASONING_SYSTEM_PROMPT = `You are DocVex Deep Reasoner, an expert staff engineer providing deep technical insight on complex software and systems.

The student is already listening to the spoken explanation. Your job is to synthesize the deep-dive takeaway, architectural gotchas, and mental model.

Structure your response into exactly three sections with these markdown headers:

### 🧠 Mental Model
1-2 concise sentences giving the right intuitive abstraction or mental model for this concept.

### ⚠️ Critical Gotchas & Pitfalls
2-3 concrete real-world traps, subtle bugs, or misconceptions engineers face when working with this mechanism.

### 📋 Executive Summary
3 crisp bullet points summarizing the core mechanics and trade-offs.

Be direct, technically rigorous, and avoid conversational filler.`;

/**
 * Maximum characters of selected text sent to Ollama reasoning.
 * Keeps qwen3 chain-of-thought proportional to a fixed budget regardless of how
 * much text the user selected. Head + tail strategy preserves opening context and
 * conclusion while dropping middle bulk.
 */
const MAX_REASONING_CHARS = 1200;

function truncateForReasoning(text) {
  const t = text.trim();
  if (t.length <= MAX_REASONING_CHARS) return t;
  const head = t.slice(0, 700);
  const tail = t.slice(-500);
  return `${head}\n[... truncated ...]\n${tail}`;
}

export function buildReasoningPrompt({ selectedText, pageTitle = '', evidence = [] }) {
  const passageText = truncateForReasoning(selectedText || '');
  let prompt = `Selected Technical Passage:\n"""\n${passageText}\n"""\n`;

  if (pageTitle) {
    prompt += `\nContext / Document Title: ${pageTitle.trim()}\n`;
  }

  if (Array.isArray(evidence) && evidence.length > 0) {
    prompt += `\nAuthoritative Reference Material:\n<evidence>\n`;
    for (const ref of evidence) {
      if (ref.content) {
        // Cap per-source evidence at 500 chars to keep total context tight
        prompt += `Source: ${ref.domain || ref.title || 'Official Docs'}\n${ref.content.slice(0, 500)}\n---\n`;
      }
    }
    prompt += `</evidence>\n`;
  }

  prompt += `\nProvide the Mental Model, Critical Gotchas, and Executive Summary based on the technical passage.`;
  return prompt;
}
