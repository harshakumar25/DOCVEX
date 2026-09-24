const DEFAULT_SPEECH_DICTIONARY = Object.freeze({
  'O(n log n)': 'order of n log n',
  kubectl: 'kube control',
  gRPC: 'gee R P C',
  'HTTP/2': 'H T T P two',
  HTTP: 'H T T P',
  HTTPS: 'H T T P S',
  TCP: 'T C P',
  UDP: 'U D P',
  OAuth: 'O auth',
  SQL: 'S Q L',
  IPv6: 'I P v six',
  API: 'A P I',
  RBAC: 'R B A C',
  SLSA: 'S L S A',
});

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalizeSpeechText = (text, dictionary = DEFAULT_SPEECH_DICTIONARY) => {
  if (typeof text !== 'string' || !text.trim()) return '';

  let normalized = text;
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

export { DEFAULT_SPEECH_DICTIONARY };
