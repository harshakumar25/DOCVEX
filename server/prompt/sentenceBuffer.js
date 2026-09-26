import { shapeSpeechText } from './teacherPrompt.js';

// Common abbreviations and patterns that end with a dot but do NOT terminate a sentence
const NON_TERMINATING_ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'co', 'approx', 'dept', 'fig', 'no', 'vol', 'al'
]);

/**
 * Checks if a match index is a false boundary (e.g., number 3.14, version 1.2.0, or abbreviation).
 */
const isFalseBoundary = (text, punctuationIndex) => {
  const char = text[punctuationIndex];

  // If period, check for digits on both sides (e.g. 3.14)
  if (char === '.') {
    const prevChar = text[punctuationIndex - 1];
    const nextChar = text[punctuationIndex + 1];
    if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
      return true;
    }

    // Check for ellipsis (...)
    if (prevChar === '.' || nextChar === '.') {
      return true;
    }

    // Check for preceding word to detect abbreviations (e.g., "e.g.", "i.e.")
    const precedingSlice = text.slice(Math.max(0, punctuationIndex - 10), punctuationIndex);
    const lastWordMatch = precedingSlice.match(/([a-zA-Z0-9\._]+)$/);
    if (lastWordMatch) {
      const candidate = lastWordMatch[1].toLowerCase().replace(/\.$/, '');
      if (NON_TERMINATING_ABBREVIATIONS.has(candidate)) {
        return true;
      }
    }
  }

  return false;
};

/**
 * Classifies the gap after a sentence boundary.
 * Returns pauseAfterMs = 1000 if a paragraph break (double newline) immediately follows the boundary,
 * 0 for a normal intra-paragraph continuation.
 */
const classifyPause = (text, punctEndIndex) => {
  const remainder = text.slice(punctEndIndex);
  // Double newline (paragraph break) before any non-whitespace text -> 1000ms (1 sec) pause
  if (/^\s*\n\s*\n/.test(remainder)) return 1000;
  return 0;
};

/**
 * SentenceBuffer accumulates stream tokens and splits them into clean, speech-friendly sentences.
 * Clamps overly long run-on sentences to a natural maximum length (default 360 chars) at clause boundaries.
 * Each emitted sentence includes a `pauseAfterMs` hint: 0 = continue immediately, 700 = paragraph break.
 */
export class SentenceBuffer {
  constructor({ onSentence, minSentenceLength = 4, maxUtteranceLength = 360 }) {
    this.buffer = '';
    this.onSentence = onSentence;
    this.minSentenceLength = minSentenceLength;
    this.maxUtteranceLength = maxUtteranceLength;
    this.sentenceIndex = 0;
  }

  addToken(token) {
    if (!token || typeof token !== 'string') return;
    this.buffer += token;
    this.process();
  }

  emitClamped(candidate, pauseAfterMs = 0) {
    const cleaned = shapeSpeechText(candidate);
    if (!cleaned || cleaned.length < this.minSentenceLength) return;

    if (cleaned.length <= this.maxUtteranceLength) {
      this.sentenceIndex++;
      this.onSentence(cleaned, this.sentenceIndex, pauseAfterMs);
      return;
    }

    // Candidate exceeds maxUtteranceLength: split at clause boundary or last space
    // Inner chunks have 0 pause; only last chunk carries the original pauseAfterMs
    let remaining = cleaned;
    while (remaining.length > this.maxUtteranceLength) {
      const slice = remaining.slice(0, this.maxUtteranceLength);
      const match = slice.match(/.*([,;:—]|\s-\s)\s*/);
      let splitAt = -1;
      if (match && match[0].length >= this.minSentenceLength) {
        splitAt = match[0].length;
      } else {
        splitAt = slice.lastIndexOf(' ');
      }

      if (splitAt <= 0 || splitAt < this.minSentenceLength) {
        splitAt = this.maxUtteranceLength;
      }

      const part = remaining.slice(0, splitAt).trim();
      if (part.length > 0) {
        this.sentenceIndex++;
        this.onSentence(part, this.sentenceIndex, 0);
      }
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining.length >= this.minSentenceLength) {
      this.sentenceIndex++;
      this.onSentence(remaining, this.sentenceIndex, pauseAfterMs);
    }
  }

  process() {
    // Regex looking for sentence termination: punctuation followed by space or newline
    const boundaryRegex = /([.?!]+)(\s+|\n+|$)/g;
    let match;

    while ((match = boundaryRegex.exec(this.buffer)) !== null) {
      const punctIndex = match.index;
      const punctLength = match[1].length;
      const spaceLength = match[2].length;
      const splitIndex = punctIndex + punctLength + spaceLength;

      // Don't split if at the very end of buffer without trailing whitespace
      if (splitIndex >= this.buffer.length && spaceLength === 0) {
        break;
      }

      // Check for false boundaries (decimals, abbreviations, etc.)
      if (isFalseBoundary(this.buffer, punctIndex)) {
        continue;
      }

      const candidate = this.buffer.slice(0, splitIndex).trim();

      // Only emit if candidate meets minimum length threshold
      if (candidate.length >= this.minSentenceLength) {
        // Classify pause BEFORE slicing the buffer so we can inspect the following text
        const pauseAfterMs = classifyPause(this.buffer, punctIndex + punctLength);
        this.emitClamped(candidate, pauseAfterMs);
        this.buffer = this.buffer.slice(splitIndex);
        boundaryRegex.lastIndex = 0;
      }
    }
  }

  flush() {
    const remaining = this.buffer.trim();
    if (remaining.length > 0) {
      this.emitClamped(remaining);
      this.buffer = '';
    }
  }

  reset() {
    this.buffer = '';
    this.sentenceIndex = 0;
  }
}
