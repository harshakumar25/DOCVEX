import test from 'node:test';
import assert from 'node:assert/strict';

// Tests for the Docy Voice Interrupt logic (wake detection, resume detection, echo filter, countdown)
// Exact regex rules mirrored from extension/content.js:
const WAKE_PATTERNS = [
  /\b(docy|doci|docvex|dokey|dhoki)\b/i,
  /\b(ru+k+|roo?k+)\s*(ja+[ao]*|o+|ha)?\b/i, // "ruk jao", "ruk jaao", "rukk jaoo", "ruko", "rooko"
  /\bek\s*(sec|second|pal|minute|min)\b/i,
  /\b(wait|waitt)(\s+(for\s+)?(a\s+)?(moment|sec|second|minute))?\b/i, // "wait", "wait for moment", "wait for a moment"
  /\bpause\b/i,
  /\bhold\s*on\b/i,
  /\bstop\b/i,
  /\b(i\s*have\s*a\s*)?doubt\b/i,
  /\bsuno\b/i,
];

const RESUME_PATTERNS = [
  /\b(continue|resume|go\s*on|carry\s*on)\b/i,
  /\bchalte\s*raho\b/i,
  /\bjaari\b/i,
  /\btheek\s*hai\b/i,
  /\bhaan\b/i,
  /\b(ok|okay|got\s*it|fine|chalo)\b/i,
];

const matchesWake = (transcript) => WAKE_PATTERNS.some((p) => p.test(transcript));
const matchesResume = (transcript) => RESUME_PATTERNS.some((p) => p.test(transcript));

const isSelfEcho = (transcript, currentSpeakingText) => {
  if (!currentSpeakingText) return false;
  const lower = transcript.toLowerCase().trim();
  if (/\b(docy|doci|docvex|dokey|dhoki|ruk|ruko|doubt|suno)\b/i.test(lower)) {
    return false;
  }
  if (/^(wait|stop|pause)$/i.test(lower) && currentSpeakingText.toLowerCase().includes(lower)) {
    return true;
  }
  return false;
};

test('Docy Voice Interrupt: detects English wake phrases reliably', () => {
  const englishPhrases = [
    'docy',
    'hey docy',
    'docy listen',
    'wait',
    'wait for moment',
    'wait for a moment',
    'wait a second',
    'pause please',
    'hold on',
    'stop',
    'docy i have a doubt',
    'i have a doubt',
    'i have a doubt about this function',
    'doubt here',
    'docvex wait',
  ];

  for (const phrase of englishPhrases) {
    assert.ok(matchesWake(phrase), `Expected "${phrase}" to trigger wake pattern`);
  }
});

test('Docy Voice Interrupt: detects Hindi/Hinglish wake phrases reliably', () => {
  const hindiPhrases = [
    'ruk jao',
    'ruk jaao',
    'ruk jaoo',
    'rukk jaoo',
    'ruk ja',
    'ruko',
    'ek second',
    'ek sec',
    'ek pal',
    'ek minute',
    'suno',
    'docy suno',
  ];

  for (const phrase of hindiPhrases) {
    assert.ok(matchesWake(phrase), `Expected "${phrase}" to trigger wake pattern`);
  }
});

test('Docy Voice Interrupt: ignores unrelated speech during normal playback', () => {
  const nonWakePhrases = [
    'the event loop processes callbacks',
    'javascript promises are microtasks',
    'we can render the component now',
    'click the button below',
  ];

  for (const phrase of nonWakePhrases) {
    assert.ok(!matchesWake(phrase), `Expected "${phrase}" NOT to trigger wake pattern`);
  }
});

test('Docy Voice Interrupt: detects English & Hindi resume phrases', () => {
  const resumePhrases = [
    'continue',
    'resume',
    'go on',
    'carry on',
    'theek hai',
    'haan',
    'ok',
    'okay',
    'got it',
    'fine',
    'chalo',
    'chalte raho',
    'jaari rakho',
  ];

  for (const phrase of resumePhrases) {
    assert.ok(matchesResume(phrase), `Expected "${phrase}" to trigger resume pattern`);
  }
});

test('Docy Voice Interrupt: acoustic self-echo filter prevents DocVex speaker false-positives', () => {
  const speakingUtterance = 'We must call wait and wait for the response before continuing.';
  
  // Single generic "wait" picked up while DocVex itself is uttering "wait" -> recognized as echo
  assert.equal(isSelfEcho('wait', speakingUtterance), true);
  assert.equal(isSelfEcho('stop', 'We will stop the loop when condition is met.'), true);

  // But if the user says "docy wait" or "ruk jao", it is NOT echo and wakes Docy
  assert.equal(isSelfEcho('docy wait', speakingUtterance), false);
  assert.equal(isSelfEcho('ruk jao', speakingUtterance), false);
  assert.equal(isSelfEcho('docy i have a doubt', speakingUtterance), false);
});

test('Docy Voice Interrupt: speech activity dynamically resets countdown and tracks transcript', () => {
  // Simulating state machine of DocyVoiceInterrupt
  let interrupted = false;
  let secondsLeft = 0;
  let lastSpokenText = '';
  let statusText = '';

  const wake = () => {
    interrupted = true;
    lastSpokenText = '';
    secondsLeft = 8;
    statusText = `🎙️ Docy is listening… (resuming in ${secondsLeft}s)`;
  };

  const handleSpeechResult = (transcript) => {
    if (!interrupted) {
      if (matchesWake(transcript)) {
        wake();
      }
    } else {
      if (matchesResume(transcript)) {
        interrupted = false;
        statusText = 'Finished listening.';
        return;
      }
      // User speaking while interrupted
      lastSpokenText = transcript;
      const preview = transcript.length > 36 ? transcript.slice(0, 33) + '…' : transcript;
      secondsLeft = 6;
      statusText = `🎙️ Heard: "${preview}" (resuming in ${secondsLeft}s)`;
    }
  };

  // 1. Initial wake
  handleSpeechResult('ruk jaoo');
  assert.equal(interrupted, true);
  assert.equal(secondsLeft, 8);
  assert.ok(statusText.includes('Docy is listening'));

  // 2. User starts speaking their doubt
  handleSpeechResult('why does node js block on sync fs calls?');
  assert.equal(interrupted, true);
  assert.equal(secondsLeft, 6);
  assert.ok(statusText.includes('why does node js block'));

  // 3. User says continue
  handleSpeechResult('theek hai');
  assert.equal(interrupted, false);
});
