/**
 * DocVex — Speech State Machine & Voice Navigation Command Router
 * Authoritative sentence navigation state shared across streaming LLM tokens,
 * Web Speech API, Chatterbox audio, HUD stepper controls, and voice commands.
 */

import { normalizeSpeechText } from './speechNormalization.js';

export const VOICE_NAV_COMMANDS = Object.freeze({
  REPLAY: [
    // English
    /^(repeat(\s+(that|this|the\s+sentence|sentence))?|say\s+that\s+again|once\s+more|one\s+more\s+time|replay|play\s+again)$/i,
    // Hindi / Hinglish
    /^(phir\s*se\s*bolo?|dobara\s*bolo?|ek\s*aur\s*baar|wapas\s*bolo?|phir\s*se|dobara)$/i,
    // Devanagari Hindi
    /^(फिर\s*से\s*बोलो|दोबारा\s*बोलो|एक\s*बार\s*और|दोबारा|वापस\s*बोलो)$/,
  ],
  NEXT: [
    // English
    /^(next(\s+sentence)?|skip(\s+this)?|go\s+forward|move\s+on|continue\s+ahead)$/i,
    // Hindi / Hinglish
    /^(aage\s*badho?|aage\s*chalo?|agla\s*sentence|agla|agla\s*batao)$/i,
    // Devanagari Hindi
    /^(आगे\s*बढ़ो|अगला\s*सेंटेंस|अगला|आगे\s*चलो|आगे\s*बताओ)$/,
  ],
  PREVIOUS: [
    // English
    /^(previous(\s+sentence)?|go\s+back|back(\s+up)?|last\s+sentence|step\s+back)$/i,
    // Hindi / Hinglish
    /^(peeche\s*jao?|pichhla\s*sentence|pichla\s*sentence|pichla|pehle\s*wala|pichhe)$/i,
    // Devanagari Hindi
    /^(पीछे\s*जाओ|पिछला\s*सेंटेंस|पिछला|पहले\s*वाला|पीछे)$/,
  ],
});

/**
 * Strips leading addressing/wake prefix and returns navigation intent, or null.
 */
export function parseVoiceNavigationCommand(transcript) {
  if (!transcript || typeof transcript !== 'string') return null;
  let clean = transcript.trim().toLowerCase();

  // Strip leading wake/address words: "docy repeat that" -> "repeat that"
  clean = clean.replace(/^(docy|doci|docvex|bhai|yaar|hey\s+docy|ok\s+docy|okay\s+docy|sun\s+bhai|suno?|arey?)\s*[,:]?\s*/i, '');

  if (VOICE_NAV_COMMANDS.REPLAY.some((pattern) => pattern.test(clean))) {
    return 'REPLAY';
  }
  if (VOICE_NAV_COMMANDS.NEXT.some((pattern) => pattern.test(clean))) {
    return 'NEXT';
  }
  if (VOICE_NAV_COMMANDS.PREVIOUS.some((pattern) => pattern.test(clean))) {
    return 'PREVIOUS';
  }

  return null;
}

export class SpeechStateMachine {
  constructor({
    onSentenceChange = () => {},
    onStatusChange = () => {},
    onPlaybackFinished = () => {},
  } = {}) {
    this.sentences = [];
    this.currentIndex = -1;
    this.isStreaming = false;
    this.playbackStatus = 'idle'; // 'idle' | 'playing' | 'paused' | 'buffering_next' | 'completed'
    this.activeRequestId = null;
    this.onSentenceChange = onSentenceChange;
    this.onStatusChange = onStatusChange;
    this.onPlaybackFinished = onPlaybackFinished;
  }

  reset(requestId = null) {
    this.sentences = [];
    this.currentIndex = -1;
    this.isStreaming = true;
    this.playbackStatus = 'idle';
    this.activeRequestId = requestId;
    this.onStatusChange('idle', { count: 0, isStreaming: true });
  }

  /**
   * Adds a newly segmented sentence from token streaming.
   * Computes phonetic representation immediately for acoustic synthesis.
   */
  addSentence({ text, index, pauseAfterMs = 0, requestId = null }) {
    if (this.activeRequestId && requestId && requestId !== this.activeRequestId) {
      return null;
    }

    const cleanText = text.trim();
    if (!cleanText) return null;

    const sentenceItem = {
      id: `${this.activeRequestId || 'req'}-s-${index}`,
      index, // 1-based index (1, 2, 3...)
      text: cleanText,
      phoneticText: normalizeSpeechText(cleanText),
      pauseAfterMs,
      status: 'buffered',
    };

    this.sentences.push(sentenceItem);
    const zeroIndex = this.sentences.length - 1;

    // Case 1: First sentence ever arrived while idle -> make it active!
    if (this.currentIndex === -1 && this.playbackStatus === 'idle') {
      this.currentIndex = 0;
      this.playbackStatus = 'playing';
      this.onSentenceChange(sentenceItem, 0, this.sentences.length, this.isStreaming);
      return { action: 'PLAY_INITIAL', sentence: sentenceItem };
    }

    // Case 2: We were waiting for the next sentence to stream in!
    if (this.playbackStatus === 'buffering_next' && this.currentIndex === zeroIndex - 1) {
      this.currentIndex = zeroIndex;
      this.playbackStatus = 'playing';
      this.onSentenceChange(sentenceItem, zeroIndex, this.sentences.length, this.isStreaming);
      return { action: 'PLAY_NEXT', sentence: sentenceItem };
    }

    // Update count in HUD
    this.onStatusChange(this.playbackStatus, {
      currentIndex: this.currentIndex,
      count: this.sentences.length,
      isStreaming: this.isStreaming,
    });

    return { action: 'BUFFERED', sentence: sentenceItem };
  }

  setStreamDone() {
    this.isStreaming = false;
    if (this.playbackStatus === 'buffering_next') {
      // If we were waiting for a next sentence that never arrived because stream ended:
      this.playbackStatus = 'completed';
      this.onPlaybackFinished();
    }
    this.onStatusChange(this.playbackStatus, {
      currentIndex: this.currentIndex,
      count: this.sentences.length,
      isStreaming: false,
    });
  }

  getCurrentSentence() {
    if (this.currentIndex >= 0 && this.currentIndex < this.sentences.length) {
      return this.sentences[this.currentIndex];
    }
    return null;
  }

  canGoNext() {
    if (this.currentIndex < this.sentences.length - 1) return true;
    return this.isStreaming;
  }

  canGoPrevious() {
    return this.currentIndex > 0;
  }

  next() {
    if (this.currentIndex < this.sentences.length - 1) {
      this.currentIndex++;
      const sentence = this.sentences[this.currentIndex];
      this.playbackStatus = 'playing';
      this.onSentenceChange(sentence, this.currentIndex, this.sentences.length, this.isStreaming);
      return { action: 'PLAY', sentence };
    }

    if (this.isStreaming) {
      this.playbackStatus = 'buffering_next';
      this.onStatusChange('buffering_next', {
        currentIndex: this.currentIndex,
        count: this.sentences.length,
        isStreaming: true,
      });
      return { action: 'WAITING_FOR_STREAM' };
    }

    return null;
  }

  previous() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      const sentence = this.sentences[this.currentIndex];
      this.playbackStatus = 'playing';
      this.onSentenceChange(sentence, this.currentIndex, this.sentences.length, this.isStreaming);
      return { action: 'PLAY', sentence };
    }
    return null;
  }

  replay() {
    const sentence = this.getCurrentSentence();
    if (sentence) {
      this.playbackStatus = 'playing';
      this.onSentenceChange(sentence, this.currentIndex, this.sentences.length, this.isStreaming);
      return { action: 'PLAY', sentence };
    }
    return null;
  }

  jumpTo(targetIndex) {
    if (targetIndex >= 0 && targetIndex < this.sentences.length) {
      this.currentIndex = targetIndex;
      const sentence = this.sentences[targetIndex];
      this.playbackStatus = 'playing';
      this.onSentenceChange(sentence, targetIndex, this.sentences.length, this.isStreaming);
      return { action: 'PLAY', sentence };
    }
    return null;
  }

  onSentenceEnded(index) {
    if (index >= 0 && index < this.sentences.length) {
      this.sentences[index].status = 'played';
    }

    // Auto-advance if we just finished the active sentence
    if (this.currentIndex === index) {
      if (this.currentIndex < this.sentences.length - 1) {
        this.currentIndex++;
        const nextSentence = this.sentences[this.currentIndex];
        this.playbackStatus = 'playing';
        this.onSentenceChange(nextSentence, this.currentIndex, this.sentences.length, this.isStreaming);
        return { action: 'AUTO_ADVANCE', sentence: nextSentence };
      }

      if (this.isStreaming) {
        this.playbackStatus = 'buffering_next';
        this.onStatusChange('buffering_next', {
          currentIndex: this.currentIndex,
          count: this.sentences.length,
          isStreaming: true,
        });
        return { action: 'WAITING_FOR_STREAM' };
      }

      this.playbackStatus = 'completed';
      this.onPlaybackFinished();
      return { action: 'COMPLETED' };
    }

    return null;
  }
}
