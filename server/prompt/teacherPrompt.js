/**
 * Teaching System Prompt and speech-optimization transformations for DocVex.
 */

export const TEACHER_SYSTEM_PROMPT = `You are a highly skilled technical teacher explaining difficult material to one student.

Your job is NOT to simply read or paraphrase the selected text.
Your job is to make the concept understandable.

Priority order:
1. Technical accuracy
2. Clear mental model
3. Logical structure
4. Useful context
5. Practical examples
6. Natural spoken delivery

Teaching guidelines:
- Start from the core meaning of the concept.
- Explain unfamiliar terminology before relying on it.
- Break complicated mechanisms into smaller, digestible steps.
- Use analogies when they genuinely improve understanding, but do not force one if unnecessary.
- Do not force humor, slang, or motivational filler.
- Do not say "As an AI" or refer to yourself as a language model.
- If verified technical references are provided, use them to clarify, verify, and enrich context.
- Distinguish clearly between what is in the selected material and additional context.
- If selected text contains code, explain what the code accomplishes conceptually and describe the flow before discussing details. Do not mechanically read punctuation aloud.

For spoken delivery:
- Use natural, conversational sentences.
- Avoid long, winding sentences.
- Avoid markdown tables, raw URLs, citation symbols, or dense numbered lists.
- Make technical terms clear and easy to listen to.
- Teach as though an excellent professor is sitting next to the student and explaining the material in person.`;

/**
 * Builds user prompt combining selected text, page context, and verified references.
 */
export const buildTeachingUserPrompt = ({ text, title = '', url = '', references = [] }) => {
  let prompt = `SELECTED TEXT TO TEACH:\n"""\n${text}\n"""\n`;

  if (title || url) {
    prompt += `\nWEBPAGE CONTEXT:\n`;
    if (title) prompt += `Title: ${title}\n`;
    if (url) prompt += `URL: ${url}\n`;
  }

  if (Array.isArray(references) && references.length > 0) {
    prompt += `\nVERIFIED TECHNICAL REFERENCES (For grounding & context only):\n`;
    references.forEach((ref, index) => {
      prompt += `[Source ${index + 1}: ${ref.domain || ref.title}]\n${ref.content}\n`;
    });
  }

  prompt += `\nPlease explain and teach the meaning of the selected text aloud to the student.`;
  return prompt;
};

/**
 * Optimizes text for speech synthesis:
 * - Strips raw URLs and markdown formatting symbols (*, _, #, `, [ ]).
 * - Converts bullet points and numbered lists to fluid spoken transitions.
 * - Expands common programming operators into words where helpful.
 */
export const shapeSpeechText = (text) => {
  if (!text || typeof text !== 'string') return '';

  let spoken = text;

  // Remove URLs so they aren't read character-by-character
  spoken = spoken.replace(/https?:\/\/\S+/gi, '');

  // Remove markdown headers
  spoken = spoken.replace(/^#{1,6}\s+/gm, '');

  // Remove code block markers and inline backticks
  spoken = spoken.replace(/```[a-zA-Z]*\n?/g, '');
  spoken = spoken.replace(/`/g, '');

  // Remove bold / italics asterisks and underscores
  spoken = spoken.replace(/\*\*([^*]+)\*\*/g, '$1');
  spoken = spoken.replace(/\*([^*]+)\*/g, '$1');
  spoken = spoken.replace(/__([^_]+)__/g, '$1');
  spoken = spoken.replace(/_([^_]+)_/g, '$1');

  // Remove markdown link syntax [text](url) -> text
  spoken = spoken.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Convert list bullets (- or *) at start of line into natural pauses
  spoken = spoken.replace(/^[\*\-]\s+/gm, 'Also, ');

  // Collapse multiple whitespaces and excessive newlines into clean sentence spacing
  spoken = spoken.replace(/[ \t]+/g, ' ');
  spoken = spoken.replace(/\n\s*\n+/g, '\n\n');

  return spoken.trim();
};
