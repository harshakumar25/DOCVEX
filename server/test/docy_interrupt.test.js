import test from 'node:test';
import assert from 'node:assert/strict';

// Tests for the Docy Voice Interrupt logic (wake detection, resume detection, echo filter, countdown)
// Exact regex rules mirrored from extension/content.js:
const WAKE_PATTERNS = [
  // Direct Docy address
  /\b(docy|doci|docvex|dokey|dhoki)\b/i,
  // Hindi/Hinglish stop commands: ruk, ruko, ruk ja, ruk jao, ruk ja bhai, ruk ja bhyii, ruk ja yaar, rukh
  /\b(ru+k+|roo?k+|ru+kh?)\s*(ja+[ao]*|o+|ha)?(\s*(bha?y+i+|bha?i|bhaiya|yaar|yar|re|na|zara|ji))?\b/i,
  // Devanagari Hindi stop commands: रुक, रुको, रुक जा, रुक जाओ, रुकिए, रुक जा भाई, रुक जा यार
  /(रुक(ना|ो|िए)?(\s*(जा+[ओो]*|जाइए))?(\s*(भाई|यार|रे|ना|ज़रा|जरा))?)/,
  // Hindi silence/stop commands: chup, chup ho ja, chup karo, shant, shant ho ja
  /\b(chup(\s*(ho\s*ja|karo|raho))?|shant(\s*(ho\s*ja|raho))?)\b/i,
  // Devanagari silence: चुप, चुप हो जा, चुप रहो, शांत
  /(चुप(\s*(हो\s*जा|रहो|करो))?|शांत(\s*(हो\s*जा|रहो))?)/,
  // Hindi attention commands: sun, suno, sun bhai, sun bhyii, arey sun, arey suno, sun na, sun lo, sun rahe ho, sun rha h
  /\b(suno?|arey?\s*suno?|sun\s*(rahe?\s*ho|raha\s*hai|rha\s*h|bha?y+i+|bha?i|na|yaar|yar|lo|be)?|bha?i\s*sun)\b/i,
  // Devanagari attention: सुन, सुनो, सुनिए, अरे सुनो, भाई सुन, सुन रहे हो
  /(सुन(ना|ो|िए| रहे हो| रहा है)?|अरे\s*सुन(ना|ो|िए)?|भाई\s*सुन(ना|ो|िए)?)/,
  // English wait variations: wait, waitt, wait a sec, wait a second, wait for a moment, ok wait, okk wait, okay wait
  /\b(ok+|okay)?\s*(wait|waitt|weight)(\s+(for\s+)?(a\s+)?(moment|sec|second|minute))?\b/i,
  // English listen / hey: listen, hey docy, docy listen, listen docy, just listen, hey wait, are you listening, listening, can you hear me
  /\b(listen|listening|are\s+you\s+listening|can\s+you\s+hear\s+me|hey\s+docy|docy\s+listen|listen\s+docy|just\s+listen|hey\s+wait)\b/i,
  // Greetings and addressing Docy: hello docy, hello, hi docy, hi
  /\b(hello(\s+docy)?|hi\s+docy)\b/i,
  // English pause / stop / hold commands
  /\b(pause|stop|hold\s*on|hold\s*up|hang\s*on|shut\s*up|be\s*quiet)\b/i,
  // Devanagari pause/stop: रुको जरा, ठहरो
  /(रुको\s*ज़रा|रुको\s*जरा|ठहरो)/,
  // Short-time expressions: ek sec, ek second, ek minute, ek min, 1 sec, 1 min, just a sec
  /\b((ek|1|one)\s*(sec|second|pal|minute|min))\b/i,
  /(एक\s*(सेकंड|मिनट|पल)|१\s*(सेकंड|मिनट))/i,
  /\b(just\s*a\s*(sec|second|minute|moment))\b/i,
  // Student doubt: doubt, i have a doubt, ek doubt
  /\b((i\s*have\s*a|ek)\s*)?doubt\b/i,
  /(डाउट|संदेह|सवाल|प्रश्न)/,
];

const RESUME_PATTERNS = [
  /\b(continue|resume|go\s*on|carry\s*on)\b/i,
  /\bchalte\s*raho\b/i,
  /\bjaari\b/i,
  /\btheek\s*hai\b/i,
  /\bhaan\b/i,
  /\b(ok|okay|got\s*it|fine|chalo|aage\s*badho|shuru\s*karo)\b/i,
  // Devanagari resume phrases
  /(जारी(\s*रखो)?|चलते\s*रहो|ठीक\s*है|हाँ|आगे\s*बढ़ो|शुरू\s*करो|चलो)/,
];

const matchesWake = (transcript) => WAKE_PATTERNS.some((p) => p.test(transcript));
const matchesResume = (transcript) => RESUME_PATTERNS.some((p) => p.test(transcript));

const isSelfEcho = (transcript, currentSpeakingText) => {
  if (!currentSpeakingText) return false;
  const lower = transcript.toLowerCase().trim();
  if (/\b(docy|doci|docvex|dokey|dhoki|ruk|ruko|doubt|suno?|sun\b|listen|listening|hello|hi|chup|hold|bhai)\b/i.test(lower) || /[\u0900-\u097F]/.test(lower)) {
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
    'listen',
    'just listen',
    'are you listening',
    'listening',
    'can you hear me',
    'hello docy',
    'hello',
    'hi docy',
    'wait',
    'okk wait',
    'ok wait',
    'okay wait',
    'wait for moment',
    'wait for a moment',
    'wait a second',
    'wait a sec',
    'pause please',
    'hold on',
    'hold up',
    'hang on',
    'stop',
    'docy i have a doubt',
    'i have a doubt',
    'i have a doubt about this function',
    'doubt here',
    'ek doubt',
    'docvex wait',
    'hey wait',
    '1 min',
    'one minute',
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
    'ruk ja bhyii',
    'ruk ja bhai',
    'ruk ja yaar',
    'ruko',
    'chup',
    'chup ho ja',
    'chup raho',
    'shant ho ja',
    'sun bhai',
    'bhai sun',
    'suno',
    'docy suno',
    'sun rahe ho',
    'sun rha h',
    'sun raha hai',
    'ek second',
    'ek sec',
    'ek min',
    'ek minute',
    'ek pal',
    // Devanagari Hindi
    'रुक जा',
    'रुक',
    'रुको',
    'रुकिए',
    'रुक जा भाई',
    'सुनो',
    'सुन भाई',
    'सुन रहे हो',
    'अरे सुनो',
    'चुप',
    'चुप रहो',
    'शांत',
    'रुको जरा',
    'एक मिनट',
    'डाउट',
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
    'aage badho',
    'shuru karo',
    // Devanagari Hindi
    'चलते रहो',
    'ठीक है',
    'हाँ',
    'आगे बढ़ो',
    'शुरू करो',
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

  // But if the user says "docy wait", "ruk ja bhyii", or "listen", it is NOT echo and wakes Docy
  assert.equal(isSelfEcho('docy wait', speakingUtterance), false);
  assert.equal(isSelfEcho('ruk ja bhyii', speakingUtterance), false);
  assert.equal(isSelfEcho('listen', speakingUtterance), false);
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

  const handleSpeechResult = (transcript, isFinal = true) => {
    // When NOT interrupted, wake triggers immediately on interim OR final results!
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
      // User speaking while interrupted: interim updates HUD preview
      lastSpokenText = transcript;
      const preview = transcript.length > 36 ? transcript.slice(0, 33) + '…' : transcript;
      if (isFinal) {
        secondsLeft = 6;
      }
      statusText = `🎙️ Heard: "${preview}" (resuming in ${secondsLeft}s)`;
    }
  };

  // 1. Initial wake triggered via live interim result (isFinal=false)
  handleSpeechResult('ruk ja bhyii', false);
  assert.equal(interrupted, true, 'Interim speech result must instantly trigger wake without waiting for isFinal');
  assert.equal(secondsLeft, 8);
  assert.ok(statusText.includes('Docy is listening'));

  // 2. User starts speaking their doubt
  handleSpeechResult('why does node js block on sync fs calls?', true);
  assert.equal(interrupted, true);
  assert.equal(secondsLeft, 6);
  assert.ok(statusText.includes('why does node js block'));

  // 3. User says continue
  handleSpeechResult('theek hai', true);
  assert.equal(interrupted, false);
});

// Mirror of _looksLikeQuestion from content.js for unit testing
const looksLikeQuestion = (transcript) => {
  const t = transcript.trim();
  if (t.length < 6) return false;
  if (/[?]/.test(t)) return true;
  if (/^(what|why|how|when|where|who|which|can you|could you|explain|tell me|is there|are there|difference between|what is|what are)/i.test(t)) return true;
  if (/^(kya|kyun|kaise|kaun|batao|samjhao|explain karo)/i.test(t)) return true;
  return false;
};

test('Docy Quick-Answer: _looksLikeQuestion identifies question transcripts correctly', () => {
  const questions = [
    'what is the event loop?',
    'why does this happen',
    'how does async await work',
    'explain closures to me',
    'what are promises',
    'difference between let and const',
    'can you tell me about garbage collection',
    'could you explain this',
    'is there a better way?',
    'kya yeh sahi hai',
    'kyun error aa raha hai',
    'batao this works how',
  ];

  for (const q of questions) {
    assert.ok(looksLikeQuestion(q), `Expected "${q}" to be recognized as a question`);
  }
});

test('Docy Quick-Answer: _looksLikeQuestion rejects non-question phrases', () => {
  const nonQuestions = [
    'ok',
    'fine',
    'ya',
    'hmm interesting',
    'i see',
    'got it',
  ];

  for (const phrase of nonQuestions) {
    assert.ok(!looksLikeQuestion(phrase), `Expected "${phrase}" NOT to be recognized as a question`);
  }
});

// ── Follow-up prompt builder ──────────────────────────────────────────────────
import { buildFollowUpPrompt, DOCY_FOLLOWUP_SYSTEM_PROMPT } from '../../server/prompt/teacherPrompt.js';

test('buildFollowUpPrompt includes the spoken question and previous context', () => {
  const prompt = buildFollowUpPrompt({
    followUpQuestion: 'kya event loop ek thread pe chalta hai?',
    previousContext: 'The event loop is the mechanism Node uses to handle async callbacks.',
  });

  assert.ok(prompt.includes('kya event loop ek thread pe chalta hai'), 'should include the question');
  assert.ok(prompt.includes('Previous explanation context'), 'should include context section');
  assert.ok(prompt.includes('event loop is the mechanism'), 'should include previous context text');
});

test('buildFollowUpPrompt omits context section when no previous context is given', () => {
  const prompt = buildFollowUpPrompt({ followUpQuestion: 'what is a closure?' });
  assert.ok(!prompt.includes('Previous explanation context'), 'should omit context section when empty');
  assert.ok(prompt.includes('what is a closure?'), 'should still include the question');
});

test('DOCY_FOLLOWUP_SYSTEM_PROMPT uses warm tone and no lecture structure markers', () => {
  // These words must not appear anywhere in the prompt (they signal a cold/clinical response)
  const coldMarkers = ['In conclusion', 'Point one', 'Masterclass'];
  for (const marker of coldMarkers) {
    assert.ok(!DOCY_FOLLOWUP_SYSTEM_PROMPT.includes(marker), `follow-up prompt should not contain "${marker}"`);
  }
  // Should contain warmth and brevity indicators
  assert.ok(DOCY_FOLLOWUP_SYSTEM_PROMPT.includes('curious'), 'should acknowledge student curiosity');
  assert.ok(DOCY_FOLLOWUP_SYSTEM_PROMPT.includes('warm'), 'should mention warm delivery');
  assert.ok(DOCY_FOLLOWUP_SYSTEM_PROMPT.includes('friend'), 'should describe tone as friend-like');
});

test('Client Speech Queue: preserves sentences and halts audio cleanly on pause', () => {
  const queue = [];
  let isPlaying = false;
  let currentItem = null;
  let synthCanceled = false;

  const queueSentence = (sentence, index) => {
    queue.push({ sentence, index });
    if (!isPlaying) playNext();
  };

  const playNext = () => {
    if (queue.length === 0) return;
    currentItem = queue.shift();
    isPlaying = true;
  };

  const pause = () => {
    if (currentItem) {
      queue.unshift(currentItem);
      currentItem = null;
    }
    isPlaying = false;
    synthCanceled = true;
  };

  const resume = () => {
    synthCanceled = false;
    playNext();
  };

  queueSentence('First sentence', 1);
  queueSentence('Second sentence', 2);
  assert.equal(currentItem.sentence, 'First sentence');
  assert.equal(queue.length, 1);

  // User interrupts while first sentence is playing
  pause();
  assert.equal(isPlaying, false);
  assert.equal(synthCanceled, true);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].sentence, 'First sentence', 'Paused sentence must be restored to head of queue');

  // User resumes
  resume();
  assert.equal(isPlaying, true);
  assert.equal(currentItem.sentence, 'First sentence');
  assert.equal(queue.length, 1);
});
