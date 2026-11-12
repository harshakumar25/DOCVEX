/**
 * Canonical conversation state machine & voice intent classifiers for DocVex / Docy.
 * Pure ES module (zero DOM, zero chrome.* APIs) shared by content script and unit tests.
 */

export const CONVERSATION_STATES = Object.freeze({
  IDLE: 'IDLE',
  MAIN_TEACHING: 'MAIN_TEACHING',
  INTERRUPTED_LISTENING: 'INTERRUPTED_LISTENING',
  FOLLOWUP_ANSWERING: 'FOLLOWUP_ANSWERING',
  ASK_CONTINUE: 'ASK_CONTINUE',
  AWAITING_PROMPT: 'AWAITING_PROMPT',
});

const INTERROGATIVE_OR_INSTRUCTION_RE =
  /^(what|what's|whats|why|why's|whys|how|how's|hows|when|where|who|which|can|could|would|should|will|is|are|do|does|did|has|have|explain|tell|show|give|summarize|compare|contrast|list|trace|compute|calculate|evaluate|find|check|verify|simplify|clarify|elaborate|define|describe|walk|break|write|generate|output|repeat|rephrase|mean|does\s+it|what\s+is|kya|kyu|kyon|kaise|batao|samjhao)\b/i;

const SINGLE_WORD_COMMANDS = new Set([
  'why',
  'how',
  'what',
  'explain',
  'elaborate',
  'simplify',
  'summarize',
  'example',
  'examples',
  'output',
  'result',
  'details',
  'repeat',
  'clarify',
  'compare',
]);

const FILLER_ONLY_RE = /^(uh+|um+|hmm+|hm+|ah+|oh+|er+|mhm+|huh)$/i;

const PROCEED_COMMANDS = new Set([
  'proceed',
  'continue',
  'resume',
  'go ahead',
  'yes',
  'yes proceed',
  'yes continue',
  'yes please',
  'carry on',
  'keep going',
  'move on',
  'chalo',
  'haan',
  'aage badho',
]);

const DENY_COMMANDS = new Set([
  'deny',
  'no',
  'nope',
  'nah',
  'cancel',
  'skip',
  'dont',
  'do not',
  'stop previous',
  'new prompt',
  'new question',
  'another question',
  'ask another',
  'something else',
  'listen',
  'nahi',
  'mat karo',
]);

export function normalizeVoiceText(transcript) {
  return String(transcript || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Accepts both spoken questions AND spoken context-inspired instructions/prompts.
 * Rejects empty text and isolated hesitation fillers while ensuring real user
 * commands ("tell me the actual output", "give an example", "explain why", etc.) pass.
 */
export function looksLikePromptOrInstruction(transcript) {
  const raw = String(transcript || '').trim();
  if (!raw) return false;

  const cleaned = normalizeVoiceText(raw).replace(/\?/g, '').trim();
  if (!cleaned || FILLER_ONLY_RE.test(cleaned)) return false;

  if (raw.includes('?')) {
    return cleaned.length >= 2;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  if (words.length === 1) {
    return SINGLE_WORD_COMMANDS.has(words[0]);
  }

  if (INTERROGATIVE_OR_INSTRUCTION_RE.test(cleaned)) {
    return true;
  }

  // Any meaningful multi-word utterance (at least 2 alphabetic tokens or >= 6 chars)
  const alphaWords = words.filter((w) => /\p{L}{2,}/u.test(w));
  return alphaWords.length >= 2 || cleaned.length >= 6;
}

export function isProceedCommand(transcript) {
  const normalized = normalizeVoiceText(transcript).replace(/\?/g, '').trim();
  if (!normalized) return false;
  if (PROCEED_COMMANDS.has(normalized)) return true;
  return /^(yes\s+)?(proceed|continue|resume|go ahead|carry on)\b/.test(normalized);
}

export function isDenyCommand(transcript) {
  const normalized = normalizeVoiceText(transcript).replace(/\?/g, '').trim();
  if (!normalized) return false;
  if (DENY_COMMANDS.has(normalized)) return true;
  return /^(no\s+)?(deny|new prompt|new question|ask another|stop previous)\b/.test(normalized);
}

/**
 * Manages primary explanation progress across follow-up interruptions so that:
 * - Main teaching progress (selectedText, sentences, completedIndex) is preserved
 *   even across multiple chained "Deny -> new prompt" turns.
 * - Proceeding resumes only the unplayed sentences from where Docy left off.
 */
export class DocyConversationState {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = CONVERSATION_STATES.IDLE;
    this.mainSession = {
      selectedText: '',
      fullText: '',
      sentences: [],
      completedIndex: -1,
      streamDone: false,
    };
    this.followUpHistory = [];
  }

  startMainSession({ selectedText = '' } = {}) {
    this.mainSession = {
      selectedText: String(selectedText || ''),
      fullText: '',
      sentences: [],
      completedIndex: -1,
      streamDone: false,
    };
    this.followUpHistory = [];
    this.state = CONVERSATION_STATES.MAIN_TEACHING;
  }

  recordMainSentence(sentence) {
    const clean = String(sentence || '').trim();
    if (!clean) return -1;
    this.mainSession.sentences.push(clean);
    this.mainSession.fullText = this.mainSession.sentences.join(' ');
    return this.mainSession.sentences.length - 1;
  }

  setMainFullText(fullText) {
    const clean = String(fullText || '').trim();
    if (clean) {
      this.mainSession.fullText = clean;
    }
  }

  markMainSentenceCompleted(index) {
    if (!Number.isInteger(index) || index < 0) return;
    const bounded = Math.min(index, this.mainSession.sentences.length - 1);
    if (bounded > this.mainSession.completedIndex) {
      this.mainSession.completedIndex = bounded;
    }
  }

  markMainStreamDone() {
    this.mainSession.streamDone = true;
  }

  hasMainSession() {
    return Boolean(
      this.mainSession.selectedText.trim() ||
        this.mainSession.sentences.length > 0 ||
        this.mainSession.fullText.trim()
    );
  }

  getRemainingSentences() {
    const startIdx = Math.max(0, this.mainSession.completedIndex + 1);
    return this.mainSession.sentences.slice(startIdx);
  }

  getProceedSentences() {
    const remaining = this.getRemainingSentences();
    if (remaining.length > 0) return remaining;
    // If the main explanation had already finished all queued sentences before follow-up,
    // replay its final sentence or full sentences so "Proceed" always gives continuity.
    if (this.mainSession.sentences.length > 0) {
      return this.mainSession.sentences.slice(-1);
    }
    return [];
  }

  beginListening() {
    this.state = CONVERSATION_STATES.INTERRUPTED_LISTENING;
  }

  startFollowUp(prompt) {
    this.followUpHistory.push({
      prompt: String(prompt || '').trim(),
      response: '',
    });
    this.state = CONVERSATION_STATES.FOLLOWUP_ANSWERING;
  }

  completeFollowUp(responseText) {
    const clean = String(responseText || '').trim();
    if (this.followUpHistory.length > 0) {
      this.followUpHistory[this.followUpHistory.length - 1].response = clean;
    }
    if (this.hasMainSession()) {
      this.state = CONVERSATION_STATES.ASK_CONTINUE;
      return this.state;
    }
    this.state = CONVERSATION_STATES.IDLE;
    return this.state;
  }

  proceedMainSession() {
    const resumeFromIndex = Math.max(0, this.mainSession.completedIndex + 1);
    const remainingSentences = this.getRemainingSentences();
    const fallbackSentences = remainingSentences.length > 0
      ? remainingSentences
      : this.getProceedSentences();
    if (remainingSentences.length === 0 && fallbackSentences.length > 0) {
      // Rewinding by one sentence when continuing after end-of-session
      this.mainSession.completedIndex = Math.max(
        -1,
        this.mainSession.sentences.length - fallbackSentences.length - 1
      );
    }
    this.state = CONVERSATION_STATES.MAIN_TEACHING;
    return {
      selectedText: this.mainSession.selectedText,
      fullText: this.mainSession.fullText,
      remainingSentences: fallbackSentences,
      resumeFromIndex: Math.max(0, this.mainSession.completedIndex + 1),
    };
  }

  denyContinue() {
    this.state = CONVERSATION_STATES.AWAITING_PROMPT;
    return this.state;
  }

  getFollowUpContext(maxChars = 1100) {
    const parts = [];
    if (this.mainSession.fullText) {
      parts.push(`Main explanation: ${this.mainSession.fullText}`);
    }
    const recentTurns = this.followUpHistory.slice(-2);
    for (const turn of recentTurns) {
      if (turn.prompt) {
        const ans = turn.response ? ` -> Docy answered: ${turn.response}` : '';
        parts.push(`Student prompt: "${turn.prompt}"${ans}`);
      }
    }
    const combined = parts.join('\n').trim();
    if (combined.length <= maxChars) return combined;
    return combined.slice(combined.length - maxChars);
  }
}
