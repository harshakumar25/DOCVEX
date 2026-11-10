/**
 * DocVex — Single Source of Truth for Speech Shaping, Phonetic Normalization, and Sentence Segmentation.
 * Shared across the backend pipeline, Chrome extension, and dashboard.
 */

export const NON_TERMINATING_ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'co', 'approx', 'dept', 'fig', 'no', 'vol', 'al',
]);

export const DEFAULT_SPEECH_DICTIONARY = Object.freeze({
  'O(n log n)': 'order of n log n',
  'O(1)': 'O of one',
  'O(n)': 'O of n',
  'O(n^2)': 'O of n squared',
  'O(n²)': 'O of n squared',
  'O(log n)': 'O of log n',
  'O(2^n)': 'O of two to the n',
  'O(n!)': 'O of n factorial',
  kubectl: 'kube control',
  gRPC: 'gee R P C',
  'HTTP/2': 'H T T P two',
  HTTP: 'H T T P',
  HTTPS: 'H T T P S',
  TCP: 'T C P',
  UDP: 'U D P',
  OAuth: 'O auth',
  SQL: 'S Q L',
  NoSQL: 'no S Q L',
  PostgreSQL: 'post gres Q L',
  Postgres: 'post gres',
  IPv6: 'I P v six',
  IPv4: 'I P v four',
  API: 'A P I',
  REST: 'rest',
  GraphQL: 'graph Q L',
  RBAC: 'R B A C',
  SLSA: 'S L S A',
  CI: 'C I',
  CD: 'C D',
  'CI/CD': 'C I C D',
  CLI: 'C L I',
  DOM: 'D O M',
  CSS: 'C S S',
  HTML: 'H T M L',
  JSON: 'Jason',
  UUID: 'U U I D',
  LLM: 'L L M',
  TTS: 'T T S',
  DFS: 'D F S',
  BFS: 'B F S',
  LIFO: 'last-in, first-out',
  FIFO: 'first-in, first-out',
  HashMap: 'hash map',
  HashSet: 'hash set',
  LinkedList: 'linked list',
  ArrayList: 'array list',
  TreeNode: 'tree node',
  ListNode: 'list node',
  'arr[i]': 'array at index i',
  'nums[i]': 'numbers at index i',
  'arr.length': 'array length',
  'nums.length': 'numbers length',
  'Math.min': 'minimum',
  'Math.max': 'maximum',
  'i++': 'i plus one',
  'i--': 'i minus one',
  'j++': 'j plus one',
  'j--': 'j minus one',
  'k++': 'k plus one',
  'k--': 'k minus one',
  '!=': 'is not equal to',
  '!==': 'is strictly not equal to',
  '===': 'strictly equals',
  '==': 'equals',
  '>=': 'is greater than or equal to',
  '<=': 'is less than or equal to',
  '->': 'points to',
  '=>': 'leads to',
  'O(N)': 'O of N',
  'O(N^2)': 'O of N squared',
  'O(N²)': 'O of N squared',
  'O(log N)': 'O of log N',
  'O(N log N)': 'order of N log N',
  'O(V+E)': 'O of V plus E',
  'O(V + E)': 'O of V plus E',
  'arr[j]': 'array at index j',
  'nums[j]': 'numbers at index j',
  'arr[mid]': 'array at mid',
  'nums[mid]': 'numbers at mid',
  '&&': 'and',
  '&': 'and',
  '||': 'or',
  '+=': 'plus equals',
  '-=': 'minus equals',
  nullptr: 'null pointer',
  DP: 'D P',
  GraphRAG: 'graph rag',
  GraphRag: 'graph rag',
  RAG: 'R A G',
  'auto-parse': 'auto parse',
  'Auto-Parse': 'auto parse',
  AutoParse: 'auto parse',
  'dual-platform': 'dual platform',
  'Dual-Platform': 'dual platform',
  'post-simulation': 'post simulation',
  'Post-Simulation': 'post simulation',
});

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const shapeSpeechText = (text) => {
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
};

export const normalizeSpeechText = (text, dictionary = DEFAULT_SPEECH_DICTIONARY) => {
  if (typeof text !== 'string' || !text.trim()) return '';

  let normalized = text;
  normalized = normalized.replace(/([a-z])([A-Z])/g, '$1 $2');
  normalized = normalized.replace(/(?:^|\n)\s*0?([1-9]\d?)\s*[\r\n]+(?=[A-Za-z])/g, '\nStep $1: ');
  normalized = normalized.replace(/(?:^|\n)\s*0?([1-9]\d?)\s*[-.:]\s*(?=[A-Za-z])/g, '\nStep $1: ');
  normalized = normalized.replace(/\s*&\s*/g, ' and ');

  const entries = Object.entries(dictionary).sort(([left], [right]) => right.length - left.length);
  for (const [term, pronunciation] of entries) {
    const pattern = /\W/.test(term)
      ? new RegExp(escapeRegex(term), 'g')
      : new RegExp(`\\b${escapeRegex(term)}\\b`, 'g');
    normalized = normalized.replace(pattern, pronunciation);
  }

  normalized = normalized.replace(/(?:[A-Za-z]:\\|\\\\)[^\s,;!?]+/g, 'the file path');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
};

export const isFalseBoundary = (text, punctuationIndex) => {
  const char = text[punctuationIndex];
  if (char !== '.') return false;

  const prevChar = text[punctuationIndex - 1];
  const nextChar = text[punctuationIndex + 1];

  if (/\d/.test(prevChar) && /\d/.test(nextChar)) return true;
  if (prevChar === '.' || nextChar === '.') return true;

  const surrounding = text.slice(Math.max(0, punctuationIndex - 15), Math.min(text.length, punctuationIndex + 15));
  if (/https?:\/\/|\.(?:com|org|net|io|edu|gov)(?=[\s/]|$)/i.test(surrounding)) {
    return true;
  }

  const precedingSlice = text.slice(Math.max(0, punctuationIndex - 10), punctuationIndex);
  const lastWordMatch = precedingSlice.match(/([a-zA-Z0-9\._]+)$/);
  if (lastWordMatch) {
    const candidate = lastWordMatch[1].toLowerCase().replace(/\.$/, '');
    if (NON_TERMINATING_ABBREVIATIONS.has(candidate)) return true;
  }

  return false;
};

export const classifyPause = (text, punctEndIndex) => {
  const remainder = text.slice(punctEndIndex);
  return /^\s*\n\s*\n/.test(remainder) ? 1000 : 0;
};

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

      if (splitIndex >= this.buffer.length && spaceLength === 0) break;
      if (isFalseBoundary(this.buffer, punctIndex)) continue;

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
      this.buffer = '';
    }
  }

  reset() {
    this.buffer = '';
    this.sentenceIndex = 0;
  }
}

