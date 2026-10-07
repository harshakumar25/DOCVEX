import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBannedRoboticVoice,
  scoreSpeechVoice,
  selectBestSpeechVoice,
  BANNED_ROBOTIC_VOICE_NAMES
} from '../../extension/voiceSelector.js';

test('isBannedRoboticVoice: detects and flags harsh/robotic voices', () => {
  assert.equal(isBannedRoboticVoice('Alex'), true, 'Alex must be banned');
  assert.equal(isBannedRoboticVoice('Alex (en-US)'), true, 'Alex with locale must be banned');
  assert.equal(isBannedRoboticVoice('Fred'), true, 'Fred must be banned');
  assert.equal(isBannedRoboticVoice('Albert'), true, 'Albert must be banned');
  assert.equal(isBannedRoboticVoice('Zarvox'), true, 'Zarvox must be banned');
  assert.equal(isBannedRoboticVoice('Eddy'), true, 'Eddy must be banned');
  assert.equal(isBannedRoboticVoice('Rocko'), true, 'Rocko must be banned');

  // Must not flag legitimate names
  assert.equal(isBannedRoboticVoice('Samantha'), false);
  assert.equal(isBannedRoboticVoice('Google US English'), false);
  assert.equal(isBannedRoboticVoice('Ava (Enhanced)'), false);
  assert.equal(isBannedRoboticVoice('Alexander'), false);
});

test('scoreSpeechVoice: gives negative scores to robotic and compact voices', () => {
  const alexScore = scoreSpeechVoice({ name: 'Alex', lang: 'en-US' });
  assert.equal(alexScore, -1000, 'Alex must score -1000');

  const compactScore = scoreSpeechVoice({ name: 'Daniel (Compact)', lang: 'en-GB' });
  const enhancedScore = scoreSpeechVoice({ name: 'Oliver (Enhanced)', lang: 'en-US' });
  assert.ok(enhancedScore > compactScore, 'Enhanced voices must vastly outscore compact voices');
});

test('selectBestSpeechVoice: never selects Alex even when Alex is first in the list', () => {
  const macVoices = [
    { name: 'Alex', lang: 'en-US', default: true },
    { name: 'Fred', lang: 'en-US', default: false },
    { name: 'Victoria', lang: 'en-US', default: false },
    { name: 'Samantha', lang: 'en-US', default: false },
  ];

  const selected = selectBestSpeechVoice(macVoices);
  assert.ok(selected, 'Must select a voice');
  assert.notEqual(selected.name, 'Alex', 'Must NEVER select Alex');
  assert.notEqual(selected.name, 'Fred', 'Must NEVER select Fred');
  assert.equal(selected.name, 'Samantha', 'Must select Samantha');
});

test('selectBestSpeechVoice: prioritizes modern neural and enhanced voices', () => {
  const chromeVoices = [
    { name: 'Alex', lang: 'en-US' },
    { name: 'Samantha (Compact)', lang: 'en-US' },
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Daniel', lang: 'en-GB' },
  ];

  const selected = selectBestSpeechVoice(chromeVoices);
  assert.equal(selected.name, 'Google US English', 'Must prioritize Google US English');

  const appleVoices = [
    { name: 'Alex', lang: 'en-US' },
    { name: 'Samantha', lang: 'en-US' },
    { name: 'Ava (Enhanced)', lang: 'en-US' },
  ];

  const selectedApple = selectBestSpeechVoice(appleVoices);
  assert.equal(selectedApple.name, 'Ava (Enhanced)', 'Must prioritize Ava (Enhanced)');
});

test('selectBestSpeechVoice: returns null or non-banned voice if only banned voices are present', () => {
  const bannedOnly = [
    { name: 'Alex', lang: 'en-US' },
    { name: 'Fred', lang: 'en-US' },
    { name: 'Albert', lang: 'en-US' },
  ];

  const selected = selectBestSpeechVoice(bannedOnly);
  assert.equal(selected, null, 'Must return null rather than speaking with a banned robotic voice');
});
