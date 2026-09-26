const DEFAULT_SPEECH_DICTIONARY = Object.freeze({
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
  '||': 'or',
  '+=': 'plus equals',
  '-=': 'minus equals',
  nullptr: 'null pointer',
  DP: 'D P',
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
