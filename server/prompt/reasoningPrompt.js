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

export function buildReasoningPrompt({ selectedText, pageTitle = '', evidence = [] }) {
  let prompt = `Selected Technical Passage:\n"""\n${selectedText.trim()}\n"""\n`;

  if (pageTitle) {
    prompt += `\nContext / Document Title: ${pageTitle.trim()}\n`;
  }

  if (Array.isArray(evidence) && evidence.length > 0) {
    prompt += `\nAuthoritative Reference Material:\n<evidence>\n`;
    for (const ref of evidence) {
      if (ref.content) {
        prompt += `Source: ${ref.domain || ref.title || 'Official Docs'}\n${ref.content.slice(0, 1000)}\n---\n`;
      }
    }
    prompt += `</evidence>\n`;
  }

  prompt += `\nProvide the Mental Model, Critical Gotchas, and Executive Summary based on the technical passage.`;
  return prompt;
}
