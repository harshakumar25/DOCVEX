import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechStateMachine, parseVoiceNavigationCommand, VOICE_NAV_COMMANDS } from '../../extension/speechState.js';
import { normalizeSpeechText } from '../../extension/speechNormalization.js';

test('SpeechStateMachine: initializes and adds streaming sentences', () => {
  const events = [];
  const sm = new SpeechStateMachine({
    onSentenceChange: (s, idx, total, isStreaming) => events.push({ type: 'CHANGE', s, idx, total, isStreaming }),
    onStatusChange: (status, meta) => events.push({ type: 'STATUS', status, meta }),
  });

  sm.reset('req_1');
  assert.equal(sm.currentIndex, -1);
  assert.equal(sm.sentences.length, 0);

  // Add sentence 1
  const r1 = sm.addSentence({ text: 'A binary search divides the search space in half.', index: 1 });
  assert.equal(r1.action, 'PLAY_INITIAL');
  assert.equal(sm.currentIndex, 0);
  assert.equal(sm.sentences.length, 1);
  assert.equal(sm.canGoPrevious(), false);
  assert.equal(sm.canGoNext(), true); // true because still streaming

  // Add sentence 2
  const r2 = sm.addSentence({ text: 'It runs in O(log n) time complexity.', index: 2 });
  assert.equal(r2.action, 'BUFFERED');
  assert.equal(sm.sentences.length, 2);
  assert.equal(sm.currentIndex, 0); // Still on sentence 1 until advanced
  assert.equal(sm.sentences[1].phoneticText, 'It runs in O of log n time complexity.');
});

test('SpeechStateMachine: navigation controls next(), previous(), and replay()', () => {
  const changes = [];
  const sm = new SpeechStateMachine({
    onSentenceChange: (s, idx) => changes.push({ idx, text: s.text }),
  });

  sm.reset('req_2');
  sm.addSentence({ text: 'Sentence one.', index: 1 });
  sm.addSentence({ text: 'Sentence two.', index: 2 });
  sm.addSentence({ text: 'Sentence three.', index: 3 });
  sm.setStreamDone();

  assert.equal(sm.currentIndex, 0);
  assert.equal(sm.canGoPrevious(), false);
  assert.equal(sm.canGoNext(), true);

  // Advance to Next
  const nextRes = sm.next();
  assert.equal(nextRes.action, 'PLAY');
  assert.equal(sm.currentIndex, 1);
  assert.equal(nextRes.sentence.text, 'Sentence two.');
  assert.equal(sm.canGoPrevious(), true);
  assert.equal(sm.canGoNext(), true);

  // Advance to Sentence 3
  sm.next();
  assert.equal(sm.currentIndex, 2);
  assert.equal(sm.canGoNext(), false); // Last sentence and stream done!

  // Calling next() at the end returns null
  const endRes = sm.next();
  assert.equal(endRes, null);
  assert.equal(sm.currentIndex, 2);

  // Replay sentence 3
  const replayRes = sm.replay();
  assert.equal(replayRes.action, 'PLAY');
  assert.equal(replayRes.sentence.text, 'Sentence three.');
  assert.equal(sm.currentIndex, 2);

  // Previous moves back to sentence 2
  const prevRes = sm.previous();
  assert.equal(prevRes.action, 'PLAY');
  assert.equal(sm.currentIndex, 1);
  assert.equal(prevRes.sentence.text, 'Sentence two.');

  // Jump directly to sentence 1 (index 0)
  const jumpRes = sm.jumpTo(0);
  assert.equal(jumpRes.action, 'PLAY');
  assert.equal(sm.currentIndex, 0);
  assert.equal(jumpRes.sentence.text, 'Sentence one.');

  // Calling previous() at index 0 returns null
  assert.equal(sm.previous(), null);
});

test('SpeechStateMachine: auto-advances to next sentence on completion', () => {
  const sm = new SpeechStateMachine();
  sm.reset('req_3');
  sm.addSentence({ text: 'Part one.', index: 1 });
  sm.addSentence({ text: 'Part two.', index: 2 });
  sm.setStreamDone();

  assert.equal(sm.currentIndex, 0);

  // Sentence 1 ends
  const adv = sm.onSentenceEnded(0);
  assert.equal(adv.action, 'AUTO_ADVANCE');
  assert.equal(sm.currentIndex, 1);
  assert.equal(adv.sentence.text, 'Part two.');

  // Sentence 2 ends -> finished!
  const finalAdv = sm.onSentenceEnded(1);
  assert.equal(finalAdv.action, 'COMPLETED');
  assert.equal(sm.playbackStatus, 'completed');
});

test('SpeechStateMachine: buffers next when next() pressed before streaming sentence arrives', () => {
  const sm = new SpeechStateMachine();
  sm.reset('req_4'); // isStreaming is true
  sm.addSentence({ text: 'Only one sentence so far.', index: 1 });

  assert.equal(sm.currentIndex, 0);
  // User hits next before sentence 2 arrives
  const nextRes = sm.next();
  assert.equal(nextRes.action, 'WAITING_FOR_STREAM');
  assert.equal(sm.playbackStatus, 'buffering_next');

  // Sentence 2 finally arrives from LLM
  const addRes = sm.addSentence({ text: 'Sentence two just arrived!', index: 2 });
  assert.equal(addRes.action, 'PLAY_NEXT');
  assert.equal(sm.currentIndex, 1);
  assert.equal(addRes.sentence.text, 'Sentence two just arrived!');
  assert.equal(sm.playbackStatus, 'playing');
});

test('Voice Command Router: detects English and Hindi navigation commands', () => {
  // Replay commands (English)
  assert.equal(parseVoiceNavigationCommand('repeat that'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('repeat'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('Docy, repeat that'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('Docy say that again'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('once more'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('replay'), 'REPLAY');

  // Replay commands (Hindi & Hinglish)
  assert.equal(parseVoiceNavigationCommand('phir se bolo'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('Docy phir se bolo'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('dobara bolo'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('ek aur baar'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('फिर से बोलो'), 'REPLAY');
  assert.equal(parseVoiceNavigationCommand('दोबारा बोलो'), 'REPLAY');

  // Next commands
  assert.equal(parseVoiceNavigationCommand('next'), 'NEXT');
  assert.equal(parseVoiceNavigationCommand('next sentence'), 'NEXT');
  assert.equal(parseVoiceNavigationCommand('Docy, next'), 'NEXT');
  assert.equal(parseVoiceNavigationCommand('skip this'), 'NEXT');
  assert.equal(parseVoiceNavigationCommand('aage badho'), 'NEXT');
  assert.equal(parseVoiceNavigationCommand('agla sentence'), 'NEXT');
  assert.equal(parseVoiceNavigationCommand('आगे बढ़ो'), 'NEXT');

  // Previous commands
  assert.equal(parseVoiceNavigationCommand('previous'), 'PREVIOUS');
  assert.equal(parseVoiceNavigationCommand('previous sentence'), 'PREVIOUS');
  assert.equal(parseVoiceNavigationCommand('go back'), 'PREVIOUS');
  assert.equal(parseVoiceNavigationCommand('Docy, go back'), 'PREVIOUS');
  assert.equal(parseVoiceNavigationCommand('peeche jao'), 'PREVIOUS');
  assert.equal(parseVoiceNavigationCommand('pichla sentence'), 'PREVIOUS');
  assert.equal(parseVoiceNavigationCommand('पीछे जाओ'), 'PREVIOUS');

  // Rejects general curiosity questions
  assert.equal(parseVoiceNavigationCommand('why is this loop needed?'), null);
  assert.equal(parseVoiceNavigationCommand('what is the time complexity?'), null);
  assert.equal(parseVoiceNavigationCommand('can you explain quicksort?'), null);
  assert.equal(parseVoiceNavigationCommand('kya ye recursion hai?'), null);
});

test('normalizeSpeechText: normalizes technical operators and data structures', () => {
  const raw = 'If arr[i] !== x && nums[mid] <= target, complexity is O(n log n).';
  const phonetic = normalizeSpeechText(raw);
  assert.ok(phonetic.includes('array at index i'));
  assert.ok(phonetic.includes('is strictly not equal to'));
  assert.ok(phonetic.includes('numbers at mid'));
  assert.ok(phonetic.includes('order of n log n'));
});
