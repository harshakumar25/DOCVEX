/**
 * Canonical client speech shaping and sentence buffering module for DocVex extension.
 * Pure ES module (zero DOM, zero chrome.* APIs).
 */

export const NON_TERMINATING_ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'co', 'approx', 'dept', 'fig', 'no', 'vol', 'al',
]);

export function shapeSpeechText(text) {
  if (!text || typeof text !== 'string') return '';
  let spoken = text;
  spoken = spoken.replace(/https?:\/\/\S+/gi, '');
  spoken = spoken.replace(/^#{1,6}\s+/gm, '');
  spoken = spoken.replace(/```[a-zA-Z]*\n?/g, '');
  spoken = spoken.replace(/`/g, '');
  spoken = spoken.replace(/\*\*([^*]+)\*\*/g, '$1');
  spoken = spoken.replace(/\*([^*]+)\*/g, '$1');
  spoken = spoken.replace(/__([^_]+)__/g, '$1');
  spoken = spoken.replace(/_([^_]+)_/g, '$1');
  spoken = spoken.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  spoken = spoken.replace(/\[(?:Source\s*)?\d+[^\]]*\]/gi, '');
  spoken = spoken.replace(/^[\*\-]\s+/gm, '');
  spoken = spoken.replace(/[ \t]+/g, ' ');
  spoken = spoken.replace(/\n\s*\n+/g, ' ');
  return spoken.trim();
}

export function isFalseBoundary(text, punctuationIndex) {
  const char = text[punctuationIndex];

  if (char === '.') {
    const prevChar = text[punctuationIndex - 1];
    const nextChar = text[punctuationIndex + 1];

    if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
      return true;
    }

    if (prevChar === '.' || nextChar === '.') {
      return true;
    }

    const surrounding = text.slice(Math.max(0, punctuationIndex - 15), Math.min(text.length, punctuationIndex + 15));
    if (/https?:\/\/|\.com|\.org|\.net|\.io|\.edu|\.gov/i.test(surrounding)) {
      return true;
    }

    const preceding = text.slice(Math.max(0, punctuationIndex - 10), punctuationIndex);
    const lastWordMatch = preceding.match(/([a-zA-Z0-9\._]+)$/);
    if (lastWordMatch) {
      const candidate = lastWordMatch[1].toLowerCase().replace(/\.$/, '');
      if (NON_TERMINATING_ABBREVIATIONS.has(candidate)) {
        return true;
      }
    }
  }

  return false;
}

export function classifyPause(text, punctEndIndex) {
  const remainder = text.slice(punctEndIndex);
  if (/^\s*\n\s*\n/.test(remainder)) return 1000;
  return 0;
}

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
    const boundaryRegex = /([.?!]+)(\s+|\n+|$)/g;
    let match;

    while ((match = boundaryRegex.exec(this.buffer)) !== null) {
      const punctIndex = match.index;
      const punctLength = match[1].length;
      const spaceLength = match[2].length;
      const splitIndex = punctIndex + punctLength + spaceLength;

      if (splitIndex >= this.buffer.length && spaceLength === 0) {
        break;
      }

      if (isFalseBoundary(this.buffer, punctIndex)) {
        continue;
      }

      const candidate = this.buffer.slice(0, splitIndex).trim();

      if (candidate.length >= this.minSentenceLength) {
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
    }
    this.buffer = '';
  }

  reset() {
    this.buffer = '';
    this.sentenceIndex = 0;
  }
}

