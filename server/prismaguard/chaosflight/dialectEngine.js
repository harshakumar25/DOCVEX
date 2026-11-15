/**
 * DialectEngine: Indic Multi-Dialect & Intra-Sentence Code-Switching Stressor
 *
 * Implements:
 * 1. Indic Code-Switching Synthesis:
 *    - Hinglish (Hindi + English)
 *    - Tanglish (Tamil + English)
 *    - Kanglish (Kannada + English)
 * 2. Intra-Sentence Transition Injection:
 *    Simulates real Indian enterprise caller speech where language alternates mid-clause.
 * 3. Code-Switching Index (CSI) Calculator:
 *    Quantifies linguistic stress to certify Gnani Prisma ASR Language Identification (LID).
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID single-responsibility.
 */

export const DIALECT_DISCOURSE_MARKERS = {
  hinglish: ['yaar', 'bhaiya', 'dekho', 'actually', 'arre', 'matlab', 'please'],
  tanglish: ['pa', 'da', 'machi', 'seri', 'actually', 'konjam', 'aprom'],
  kanglish: ['kano', 're', 'maga', 'hauda', 'actually', 'swalpa', 'aamele'],
};

export const CODE_SWITCH_PATTERNS = {
  hinglish: [
    { regex: /\bpayment pending\b/gi, replacement: 'payment pending hai' },
    { regex: /\btransferred the money\b/gi, replacement: 'paise transfer kar diye' },
    { regex: /\bwrong number\b/gi, replacement: 'galat number lag gaya' },
    { regex: /\bcall you back\b/gi, replacement: 'baad me call karunga' },
    { regex: /\bstatement send\b/gi, replacement: 'statement bhej do please' },
  ],
  tanglish: [
    { regex: /\bpayment pending\b/gi, replacement: 'payment pending-a iruku' },
    { regex: /\btransferred the money\b/gi, replacement: 'kaasu transfer panniten' },
    { regex: /\bwrong number\b/gi, replacement: 'thappana number pa' },
    { regex: /\bcall you back\b/gi, replacement: 'aprom call panren' },
    { regex: /\bstatement send\b/gi, replacement: 'statement anupunga please' },
  ],
  kanglish: [
    { regex: /\bpayment pending\b/gi, replacement: 'payment pending ide' },
    { regex: /\btransferred the money\b/gi, replacement: 'duddu transfer maadideeni' },
    { regex: /\bwrong number\b/gi, replacement: 'thappu number kano' },
    { regex: /\bcall you back\b/gi, replacement: 'aamele call maadtheeni' },
    { regex: /\bstatement send\b/gi, replacement: 'statement kalisi please' },
  ],
};

const COMMON_ENGLISH_TOKENS = new Set([
  'the', 'is', 'to', 'in', 'on', 'at', 'an', 'a', 'my', 'we', 'you', 'your',
  'and', 'or', 'for', 'of', 'with', 'from', 'by', 'as', 'it', 'this', 'that',
  'please', 'send', 'call', 'payment', 'transfer', 'statement', 'account',
  'card', 'bank', 'loan', 'emi', 'refund', 'money', 'number', 'immediately',
]);

const KNOWN_INDIC_TOKENS = new Set([
  'hai', 'hain', 'hoon', 'karo', 'karna', 'karunga', 'karungi', 'karke', 'paise', 'bhai', 'bhaiya',
  'padosi', 'unka', 'inka', 'iska', 'mera', 'meri', 'mere', 'aapse', 'tumse', 'baralla',
  'yaake', 'aayithu', 'venum', 'panniten', 'pa', 'da', 'machi', 'seri', 'konjam', 'aprom',
  'maga', 'kano', 're', 'hauda', 'swalpa', 'aamele', 'bhej', 'do', 'nahi', 'tha', 'thi',
  'aur', 'par', 'se', 'ko', 'ka', 'ki', 'ke', 'kripya', 'namaste', 'ji', 'duddu',
  'maadideeni', 'maadtheeni', 'kalisi', 'anupunga', 'kaasu', 'thappu', 'thappana', 'ide',
  'iruku', 'mat', 'kyun', 'kya', 'bol', 'raha', 'rahi', 'dekh', 'dekho', 'arre', 'matlab',
]);

/**
 * Calculates Code-Switching Index (CSI) for a text utterance.
 * CSI = language alternation transition points / (total tokens - 1).
 *
 * @param {string} text
 * @returns {number} Value between 0.0 (monolingual) and 1.0 (continuous alternation)
 */
export function calculateCodeSwitchingIndex(text) {
  if (typeof text !== 'string') return 0.0;
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return 0.0;

  // Check if sentence contains ANY unambiguous Indic tokens. If not, it is monolingual English (CSI = 0.0)
  const isIndicToken = (t) => KNOWN_INDIC_TOKENS.has(t) && !COMMON_ENGLISH_TOKENS.has(t);
  const hasIndicTokens = tokens.some(isIndicToken);
  if (!hasIndicTokens) return 0.0;

  let transitions = 0;
  let prevIsIndic = isIndicToken(tokens[0]);

  for (let i = 1; i < tokens.length; i++) {
    const isIndic = isIndicToken(tokens[i]);
    if (isIndic !== prevIsIndic) {
      transitions++;
      prevIsIndic = isIndic;
    }
  }

  const csi = transitions / (tokens.length - 1);
  return Number(csi.toFixed(3));
}

/**
 * Injects regional code-switching patterns into a canonical dialogue utterance.
 *
 * @param {string} text - Base utterance
 * @param {'hinglish'|'tanglish'|'kanglish'} [dialect='hinglish']
 * @returns {{ text: string, dialect: string, csi: number, marker: string }}
 */
export function injectIndicCodeSwitching(text, dialect = 'hinglish') {
  if (typeof text !== 'string') return { text, dialect, csi: 0, marker: '' };

  const targetDialect = dialect.toLowerCase();
  const patterns = CODE_SWITCH_PATTERNS[targetDialect] || CODE_SWITCH_PATTERNS.hinglish;
  const markers = DIALECT_DISCOURSE_MARKERS[targetDialect] || DIALECT_DISCOURSE_MARKERS.hinglish;

  let modified = text;
  for (const { regex, replacement } of patterns) {
    modified = modified.replace(regex, replacement);
  }

  // Inject a natural regional discourse particle
  const marker = markers[Math.floor(Math.random() * markers.length)];
  if (!modified.toLowerCase().includes(marker)) {
    modified = `${modified}, ${marker}`;
  }

  const csi = calculateCodeSwitchingIndex(modified);

  return {
    text: modified,
    dialect: targetDialect,
    csi,
    marker,
  };
}
