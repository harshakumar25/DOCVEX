/**
 * Canonical SpeechSynthesis voice selector for DocVex extension.
 * Pure ES module (zero DOM, zero chrome.* APIs).
 */

const NOVELTY_OR_ROBOTIC_VOICE_NAMES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles',
  'cellos', 'deranged', 'good news', 'hysterical', 'jester',
  'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'junior', 'ralph',
  'fred', 'grandpa',
]);

const FEMALE_VOICE_NAMES = new Set([
  'samantha', 'ava', 'serena', 'karen', 'moira', 'tessa', 'victoria', 'fiona',
  'allison', 'susan', 'veena', 'yuri', 'kyoko', 'amelie', 'anna', 'carmit',
  'damayanti', 'ellen', 'ioana', 'joana', 'kanya', 'katya', 'luciana', 'mariska',
  'meijia', 'melina', 'milena', 'monica', 'nora', 'paulina', 'satu', 'sinji',
  'tingting', 'yelda', 'yuna', 'zosia', 'zuzana', 'flo', 'grandma', 'kathy',
  'sandy', 'shelley', 'tara', 'alice', 'alva', 'amira', 'daria', 'female',
]);

const PREFERRED_MALE_VOICE_NAMES = [
  'daniel', 'oliver', 'rishi', 'eddy', 'reed', 'rocko', 'aman', 'aaron', 'george', 'alex', 'arthur', 'tom',
  'male', 'natural', 'neural', 'premium', 'enhanced', 'google',
];

export function selectBestSpeechVoice(voices) {
  if (!voices || voices.length === 0) return null;

  const nonFemaleVoices = voices.filter((v) => {
    const lowerName = (v.name || '').toLowerCase();
    const isRobotic = Array.from(NOVELTY_OR_ROBOTIC_VOICE_NAMES).some((bad) => lowerName === bad || lowerName.includes(bad));
    const isFemale = Array.from(FEMALE_VOICE_NAMES).some((fem) => lowerName === fem || lowerName.startsWith(`${fem} `) || lowerName.includes(` ${fem}`));
    return !isRobotic && !isFemale;
  });

  const candidatePool = nonFemaleVoices.length > 0 ? nonFemaleVoices : voices.filter((v) => {
    const lowerName = (v.name || '').toLowerCase();
    return !Array.from(FEMALE_VOICE_NAMES).some((fem) => lowerName === fem || lowerName.includes(fem));
  });

  const englishVoices = candidatePool.filter((v) => v.lang && v.lang.startsWith('en'));
  const searchPool = englishVoices.length > 0 ? englishVoices : candidatePool;

  for (const preferred of PREFERRED_MALE_VOICE_NAMES) {
    const match = searchPool.find((v) => (v.name || '').toLowerCase().includes(preferred));
    if (match) return match;
  }

  return searchPool[0] || null;
}

