/**
 * DocVex — Content Script
 * - Captures user selection and webpage context
 * - Injects isolated Shadow DOM HUD floating tutor
 * - Connects via streaming port to background worker (real-time SSE relay)
 * - Implements deterministic SentenceBuffer with false-boundary protection
 * - Begins SpeechSynthesis on the very first complete sentence while model continues generating
 * - Queues subsequent sentences smoothly into browser SpeechSynthesis queue
 * - Enforces activeRequestId session protection against stale responses
 * - Supports instant Stop, Pause, and Resume controls
 * - Zero innerHTML usage (strict DOM construction for security)
 */

(() => {
  // Prevent duplicate script execution
  if (window.__DOCVEX_INITIALIZED__) return;
  window.__DOCVEX_INITIALIZED__ = true;

  // --- Shared Canonical ES Modules (Zero Duplication) ---
  let speechCore = null;
  let voiceSelector = null;
  let vadModule = null;
  let convModule = null;
  let conversationState = null;

  const sharedModulesReady = (async () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      const [coreMod, voiceMod, vadMod, convMod] = await Promise.all([
        import(chrome.runtime.getURL('speechCore.js')),
        import(chrome.runtime.getURL('voiceSelector.js')),
        import(chrome.runtime.getURL('voiceActivityDetector.js')),
        import(chrome.runtime.getURL('conversationState.js')),
      ]);
      speechCore = coreMod;
      voiceSelector = voiceMod;
      vadModule = vadMod;
      convModule = convMod;
      conversationState = new convMod.DocyConversationState();
    }
  })();

  // --- State Variables ---
  let hudContainer = null;
  let shadowRoot = null;
  let isSpeaking = false;
  let isPaused = false;
  let currentSpeechText = '';
  let activeRequestId = null;
  let activePort = null;
  let activeUtterances = [];
  let speechKeepAliveInterval = null;
  let chatterboxEnabled = true;
  let activeAudio = null;
  let chatterboxAudioQueue = [];
  let isChatterboxPlaying = false;
  let chatterboxObjectUrls = new Set();
  let currentSessionIsFollowUp = false;
  let currentSessionResumeOffset = 0;

  // Timing metrics
  let timingMetrics = {
    t0: 0, // shortcut pressed / trigger
    t4: 0, // first model token
    t5: 0, // first complete sentence emitted
    t6: 0, // speech synthesis started
    t7: 0, // full generation finished
  };

  function isSafeUrl(urlString) {
    try {
      const parsed = new URL(urlString);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function safeShapeSpeechText(text) {
    return speechCore ? speechCore.shapeSpeechText(text) : String(text || '').trim();
  }

  // --- Docy Voice Interrupt & Instruction Capture ---
  // Dual-engine listener:
  //   1. Adaptive Web Audio VAD (spectra + flatness + ZCR + hangover) rejects fan/click/AGC noise
  //   2. Web Speech API in Chrome + MediaRecorder -> Groq Whisper (/transcribe) fallback in Brave/offline
  class DocyVoiceInterrupt {
    constructor() {
      this.recognition = null;
      this.active = false;
      this.interrupted = false;
      this.userDisabled = false;
      this.resumeTimer = null;
      this.countdownInterval = null;
      this.secondsLeft = 0;
      this.lastSpokenText = '';
      this.currentSpeakingText = '';
      this.micStream = null;
      this.audioCtx = null;
      this.analyser = null;
      this.vadInterval = null;
      this.vadDetector = null;
      this.vadFreqData = null;
      this.vadTimeData = null;
      this.hasMicPermission = false;
      this.recognitionWorking = false;
      this._sttNetworkBlocked = false;

      // MediaRecorder speech segment capture for Brave / Whisper fallback
      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.isCapturingSpeech = false;
      this.segmentHadConfirmedSpeech = false;
      this.transcribing = false;
      this.maxCaptureTimer = null;

      // Transcript debounce & dedup
      this.pendingTranscript = '';
      this.transcriptDebounceTimer = null;
      this.lastSubmittedAt = 0;
      this.lastSubmittedNormalized = '';
    }

    // Regex patterns that trigger an immediate pause
    static WAKE = [
      /\b(docy|doci|docvex|dokey|dhoki)\b/i,
      /\b(ru+k+|roo?k+)\s*(ja+[ao]*|o+|ha)?\b/i,
      /\bek\s*(sec|second|pal|minute|min)\b/i,
      /\b(wait|waitt)(\s+(for\s+)?(a\s+)?(moment|sec|second|minute))?\b/i,
      /\bpause\b/i,
      /\bhold\s*on\b/i,
      /\bstop\b/i,
      /\b(i\s*have\s*a\s*)?doubt\b/i,
      /\bsuno\b/i,
    ];

    setCurrentSpeakingText(text) {
      this.currentSpeakingText = (text || '').toLowerCase().trim();
    }

    _isPromptMode() {
      const st = conversationState?.state;
      return st === 'INTERRUPTED_LISTENING' || st === 'ASK_CONTINUE' || st === 'AWAITING_PROMPT';
    }

    _isSelfEcho(transcript) {
      if (!this.currentSpeakingText || this._isPromptMode()) return false;
      const lower = transcript.toLowerCase().trim();
      if (/\b(docy|doci|docvex|dokey|dhoki|ruk|ruko|doubt|suno)\b/i.test(lower)) {
        return false;
      }
      if (/^(wait|stop|pause)$/i.test(lower) && this.currentSpeakingText.includes(lower)) {
        return true;
      }
      // Check high word overlap with currently spoken TTS words when DocVex is speaking
      const words = lower.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter((w) => w.length >= 3);
      if (words.length >= 2 && words.length <= 5) {
        const matchCount = words.filter((w) => this.currentSpeakingText.includes(w)).length;
        if (matchCount === words.length) return true;
      }
      return false;
    }

    _passesNoiseGuard(transcript, { isFinal = false, confidence = 1, source = 'webspeech' } = {}) {
      const text = String(transcript || '').trim();
      if (!text) return false;
      if (source === 'whisper') return text.length >= 2;

      const words = text.split(/\s+/).filter(Boolean);
      const inPromptMode = this._isPromptMode() || this.interrupted;

      // Reject pure single-word unconfirmed noise blip during playback
      if (!inPromptMode && !isFinal && words.length === 1 && confidence < 0.72) {
        return false;
      }

      if (inPromptMode) {
        return isFinal || words.length >= 2 || Boolean(convModule?.looksLikePromptOrInstruction?.(text));
      }

      return true;
    }

    async ensureMicAccess() {
      await sharedModulesReady;
      if (this.hasMicPermission && this.micStream?.active) return true;
      try {
        console.log('[Docy Voice] Requesting microphone access via getUserMedia...');
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        this.hasMicPermission = true;
        this.userDisabled = false;
        console.log('[Docy Voice] Microphone access granted!');
        this._updateMicButton(true);
        this._initVAD(this.micStream);
        return true;
      } catch (err) {
        console.warn('[Docy Voice] Microphone permission denied or unavailable:', err.message);
        this.hasMicPermission = false;
        this._updateMicButton(false);
        updateHUDStatus('🎙️ Click "🎙️ Enable Mic" to allow Docy voice commands');
        return false;
      }
    }

    async toggleMicAccess() {
      await sharedModulesReady;
      if (!this.hasMicPermission) {
        const ok = await this.ensureMicAccess();
        if (ok) {
          if (isSpeaking && !isPaused) {
            await this.start();
            updateHUDStatus('🎙️ Docy mic active — speak anytime to ask or instruct!');
          } else {
            await enterActivePromptListening();
          }
        }
        return;
      }

      if (this.userDisabled) {
        this.userDisabled = false;
        this._updateMicButton(true);
        if (isSpeaking && !isPaused) {
          await this.start();
          updateHUDStatus('🎙️ Docy mic resumed!');
        } else {
          await enterActivePromptListening();
        }
        return;
      }

      // If paused or idle and NOT yet in prompt mode, switch straight to active listening
      if ((!isSpeaking || isPaused) && conversationState?.state !== 'AWAITING_PROMPT') {
        await enterActivePromptListening();
        return;
      }

      // Otherwise mute Docy mic cleanly
      this.userDisabled = true;
      this.stop(false);
      this._updateMicButton(false);
      updateHUDStatus('🔇 Docy mic muted.');
    }

    _updateMicButton(enabled) {
      if (!shadowRoot) return;
      const micBtn = shadowRoot.querySelector('#docvex-btn-mic');
      if (micBtn) {
        if (this.userDisabled && this.hasMicPermission) {
          micBtn.textContent = '🔇 Mic Off';
          micBtn.classList.remove('active');
        } else if (enabled) {
          micBtn.textContent = this._isPromptMode() ? '🎙️ Listening' : '🎙️ Docy: On';
          micBtn.classList.add('active');
        } else {
          micBtn.textContent = '🎙️ Enable Mic';
          micBtn.classList.remove('active');
        }
      }
    }

    _initVAD(stream) {
      if (!vadModule) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!this.audioCtx || this.audioCtx.state === 'closed') {
          this.audioCtx = new AudioCtx();
        }
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
        const source = this.audioCtx.createMediaStreamSource(stream);
        this.analyser = this.audioCtx.createAnalyser();
        const cfg = vadModule.DEFAULT_VAD_CONFIG;
        this.analyser.fftSize = cfg.fftSize;
        this.analyser.smoothingTimeConstant = cfg.smoothingTimeConstant;
        source.connect(this.analyser);

        this.vadFreqData = new Float32Array(this.analyser.frequencyBinCount);
        this.vadTimeData = new Float32Array(this.analyser.fftSize);
        this.vadDetector = new vadModule.AdaptiveSpeechDetector(cfg);
        this._startVADMonitoring();
      } catch (err) {
        console.warn('[Docy VAD Init Error]', err.message);
      }
    }

    _pickRecorderMimeType() {
      if (typeof MediaRecorder === 'undefined') return '';
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      for (const mime of candidates) {
        if (typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(mime)) {
          return mime;
        }
      }
      return '';
    }

    _startSegmentCapture() {
      if (this.isCapturingSpeech || !this.micStream || !this.micStream.active) return;
      if (typeof MediaRecorder === 'undefined') return;

      try {
        const mimeType = this._pickRecorderMimeType();
        const opts = mimeType ? { mimeType } : undefined;
        this.recordedChunks = [];
        this.segmentHadConfirmedSpeech = false;
        this.mediaRecorder = new MediaRecorder(this.micStream, opts);
        this.isCapturingSpeech = true;

        this.mediaRecorder.ondataavailable = (evt) => {
          if (evt.data && evt.data.size > 0) {
            this.recordedChunks.push(evt.data);
          }
        };

        this.mediaRecorder.start(200);
        clearTimeout(this.maxCaptureTimer);
        this.maxCaptureTimer = setTimeout(() => {
          if (this.isCapturingSpeech && this.segmentHadConfirmedSpeech) {
            this._finishSegmentCaptureAndTranscribe(true);
          } else {
            this._cancelSegmentCapture();
          }
        }, 14000);
      } catch (err) {
        this.isCapturingSpeech = false;
        console.warn('[Docy MediaRecorder Start Error]', err.message);
      }
    }

    _cancelSegmentCapture() {
      clearTimeout(this.maxCaptureTimer);
      this.maxCaptureTimer = null;
      const recorder = this.mediaRecorder;
      this.mediaRecorder = null;
      this.isCapturingSpeech = false;
      this.segmentHadConfirmedSpeech = false;
      this.recordedChunks = [];
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try { recorder.stop(); } catch { /* ignore */ }
      }
    }

    async _finishSegmentCaptureAndTranscribe(force = false) {
      clearTimeout(this.maxCaptureTimer);
      this.maxCaptureTimer = null;
      const recorder = this.mediaRecorder;
      if (!recorder || !this.isCapturingSpeech) return;

      const hadConfirmed = this.segmentHadConfirmedSpeech || force;
      this.isCapturingSpeech = false;
      this.segmentHadConfirmedSpeech = false;
      this.mediaRecorder = null;

      if (!hadConfirmed) {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
        this.recordedChunks = [];
        return;
      }

      // Skip backend Whisper if WebSpeech ALREADY submitted a transcript cleanly moments ago
      const recentlySubmittedViaWebSpeech = Date.now() - this.lastSubmittedAt < 2200 || Boolean(this.pendingTranscript);
      const shouldUseWhisper = this._sttNetworkBlocked || !this.recognition || !this.recognitionWorking || (force && !recentlySubmittedViaWebSpeech);

      const blob = await new Promise((resolve) => {
        if (recorder.state === 'inactive') {
          resolve(new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' }));
          return;
        }
        recorder.onstop = () => {
          resolve(new Blob(this.recordedChunks, { type: recorder.mimeType || 'audio/webm' }));
        };
        try {
          recorder.stop();
        } catch {
          resolve(null);
        }
      });

      this.recordedChunks = [];
      if (!shouldUseWhisper || !blob || blob.size < 1600 || blob.size > 3500000) {
        return;
      }

      await this._transcribeBlobWithBackend(blob);
    }

    async _transcribeBlobWithBackend(blob) {
      if (this.transcribing || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
      this.transcribing = true;
      updateHUDStatus('🧠 Transcribing your voice instruction…');
      try {
        const audioBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Failed to read microphone audio.'));
          reader.readAsDataURL(blob);
        });

        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              action: 'TRANSCRIBE_AUDIO',
              payload: {
                audioBase64,
                mimeType: blob.type || 'audio/webm',
                language: 'en',
              },
            },
            (res) => resolve(res)
          );
        });

        if (response?.success && response.data?.text) {
          const text = response.data.text.trim();
          console.log('[Docy Whisper Transcribed]', text);
          if (text) {
            this._handleTranscript(text, { isFinal: true, confidence: 0.95, source: 'whisper' });
          } else {
            updateHUDStatus('🎙️ Didn’t catch that — try speaking clearly or type below.');
          }
        } else {
          console.warn('[Docy Whisper Error]', response?.error);
          if (this._isPromptMode()) {
            updateHUDStatus('🎙️ Listening (mic ready — type below or speak closer)…');
          }
        }
      } catch (err) {
        console.warn('[Docy Transcribe Failed]', err.message);
      } finally {
        this.transcribing = false;
      }
    }

    _startVADMonitoring() {
      if (this.vadInterval) clearInterval(this.vadInterval);
      if (!vadModule || !this.vadDetector) return;

      const intervalMs = vadModule.DEFAULT_VAD_CONFIG.sampleIntervalMs || 45;
      this.vadInterval = setInterval(() => {
        if (!this.active || this.userDisabled || !this.analyser || !this.vadDetector) {
          return;
        }
        const listeningInPrompt = this._isPromptMode();
        const listeningDuringPlayback = isSpeaking && !isPaused;
        if (!listeningInPrompt && !listeningDuringPlayback) {
          if (this.isCapturingSpeech) this._cancelSegmentCapture();
          return;
        }

        if (this.audioCtx?.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }

        this.analyser.getFloatFrequencyData(this.vadFreqData);
        this.analyser.getFloatTimeDomainData(this.vadTimeData);

        const features = vadModule.extractAcousticFeatures({
          frequencyDb: this.vadFreqData,
          timeDomain: this.vadTimeData,
          sampleRate: this.audioCtx?.sampleRate || 48000,
          fftSize: this.analyser.fftSize,
        });

        const strictMode = listeningDuringPlayback && !listeningInPrompt;
        const result = this.vadDetector.update(features, { strictMode, nowMs: Date.now() });

        if (!this.isCapturingSpeech && (result.state === 'CANDIDATE' || result.event === 'speech_start')) {
          if (this._sttNetworkBlocked || !this.recognition || listeningInPrompt) {
            this._startSegmentCapture();
          }
        }

        if (result.state === 'SPEAKING') {
          this.segmentHadConfirmedSpeech = true;
          if (this.interrupted && conversationState?.state === 'INTERRUPTED_LISTENING') {
            // Keep extending countdown while the user is actively talking so Docy never interrupts mid-sentence
            this.secondsLeft = Math.max(this.secondsLeft, 7);
          }
        }

        if (result.state === 'IDLE' && this.isCapturingSpeech && !this.segmentHadConfirmedSpeech) {
          this._cancelSegmentCapture();
        }

        if (result.event === 'speech_start') {
          if (!this.interrupted && listeningDuringPlayback) {
            console.log('[Docy VAD] Confirmed real speech over noise floor. Pausing playback to listen.');
            this._wake('voice activity');
            if (!this.isCapturingSpeech && (this._sttNetworkBlocked || !this.recognition)) {
              this._startSegmentCapture();
            }
          } else if (listeningInPrompt) {
            this._setListeningStyle(true);
            updateHUDStatus('🎙️ Hearing you… finish your instruction or question.');
          }
        }

        if (result.event === 'speech_end') {
          if (this.isCapturingSpeech && this.segmentHadConfirmedSpeech) {
            this._finishSegmentCaptureAndTranscribe(false);
          }
        }
      }, intervalMs);
    }

    init() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        console.warn('[Docy Voice] Web Speech API not supported; using VAD + Whisper backend.');
        this._sttNetworkBlocked = true;
        return false;
      }

      try {
        this.recognition = new SR();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-IN';
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
          console.log('[Docy Voice] SpeechRecognition active.');
          this.recognitionWorking = true;
          this._sttNetworkBlocked = false;
        };

        this.recognition.onresult = (event) => {
          this.recognitionWorking = true;
          this._sttNetworkBlocked = false;
          const last = event.results[event.results.length - 1];
          const transcript = (last[0].transcript || '').trim();
          const confidence = typeof last[0].confidence === 'number' ? last[0].confidence : 0.9;
          const isFinal = Boolean(last.isFinal);
          this._handleTranscript(transcript, { isFinal, confidence, source: 'webspeech' });
        };

        this.recognition.onend = () => {
          const shouldStayListening = this.active && !this.userDisabled && !this._sttNetworkBlocked;
          if (shouldStayListening && (this._isPromptMode() || (isSpeaking && !isPaused))) {
            try { this.recognition.start(); } catch { /* already running */ }
          }
        };

        this.recognition.onerror = (e) => {
          console.warn('[Docy Voice Recognition Event]', e.error);
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            this.recognitionWorking = false;
            updateHUDStatus('🎙️ Allow microphone for Docy voice commands');
          } else if (e.error === 'network' || e.error === 'language-not-supported') {
            // Brave strips Google Cloud STT — switch cleanly to VAD + Whisper backend
            this.recognitionWorking = false;
            this._sttNetworkBlocked = true;
            console.log('[Docy Voice] Cloud STT blocked/offline; switching seamlessly to Adaptive VAD + Whisper.');
          }
        };

        return true;
      } catch (err) {
        console.warn('[Docy Voice Init Error]', err);
        this._sttNetworkBlocked = true;
        return false;
      }
    }

    _stripLeadingWakeWord(transcript) {
      return String(transcript || '')
        .replace(/^(?:hey\s+|ok(?:ay)?\s+|hi\s+)?(?:docy|doci|docvex|dokey|dhoki|wait|ruko|pause|suno)[\s,.:;-]*/i, '')
        .trim();
    }

    _handleTranscript(transcript, meta = {}) {
      const text = String(transcript || '').trim();
      if (!text) return;
      if (this._isSelfEcho(text)) return;
      if (!this._passesNoiseGuard(text, meta)) return;

      const normalized = convModule ? convModule.normalizeVoiceText(text) : text.toLowerCase();
      if (!normalized) return;

      // Deduplicate rapid repeated dispatch from dual WebSpeech + Whisper firing on same sentence
      if (normalized === this.lastSubmittedNormalized && Date.now() - this.lastSubmittedAt < 3000) {
        return;
      }

      const st = conversationState?.state;
      console.log(`[Docy Voice Heard] (${meta.source || 'stt'}, state=${st || 'NONE'}):`, text);

      // 1. User is answering "Continue from previous? Proceed / Deny"
      if (st === 'ASK_CONTINUE' && convModule) {
        if (convModule.isProceedCommand(text)) {
          this._clearTranscriptDebounce();
          this.lastSubmittedAt = Date.now();
          this.lastSubmittedNormalized = normalized;
          handleProceedPrevious();
          return;
        }
        if (convModule.isDenyCommand(text)) {
          this._clearTranscriptDebounce();
          this.lastSubmittedAt = Date.now();
          this.lastSubmittedNormalized = normalized;
          handleDenyContinue();
          return;
        }
        if (meta.isFinal && convModule.looksLikePromptOrInstruction(text)) {
          this._clearTranscriptDebounce();
          this._commitUserPrompt(text);
          return;
        }
      }

      // 2. While DocVex is actively playing main or follow-up speech
      if (!this.interrupted && isSpeaking && !isPaused) {
        const hasWake = DocyVoiceInterrupt.WAKE.some((p) => p.test(text));
        const stripped = this._stripLeadingWakeWord(text);
        const isDirectCommand =
          (meta.isFinal || meta.source === 'whisper') &&
          Boolean(convModule?.looksLikePromptOrInstruction?.(stripped || text)) &&
          (hasWake || (stripped.split(/\s+/).length >= 3));

        if (isDirectCommand && stripped.length >= 4) {
          this._wake(text);
          this._commitUserPrompt(stripped);
          return;
        }

        if (hasWake) {
          console.log('[Docy Voice] Wake trigger matched in:', text);
          this._wake(text);
          return;
        }
        return;
      }

      // 3. While paused / listening (`INTERRUPTED_LISTENING` or `AWAITING_PROMPT`)
      if (this._isPromptMode() || this.interrupted) {
        if (st === 'INTERRUPTED_LISTENING' && convModule?.isProceedCommand?.(text)) {
          this._clearTranscriptDebounce();
          this._resume();
          return;
        }

        this.lastSpokenText = text;
        this.pendingTranscript = text;
        const preview = text.length > 42 ? text.slice(0, 39) + '…' : text;
        if (st === 'AWAITING_PROMPT') {
          updateHUDStatus(`🎙️ Hearing: "${preview}"`);
          syncAwaitingPromptInput(text);
        } else {
          this._startCountdown(8, preview);
        }

        if (meta.isFinal || meta.source === 'whisper') {
          if (convModule?.looksLikePromptOrInstruction?.(text) || text.length >= 3) {
            this._clearTranscriptDebounce();
            this._commitUserPrompt(text);
          }
        } else {
          // Wait ~1.3s after last interim update before committing Chrome interim STT
          clearTimeout(this.transcriptDebounceTimer);
          this.transcriptDebounceTimer = setTimeout(() => {
            if (this.pendingTranscript && (convModule?.looksLikePromptOrInstruction?.(this.pendingTranscript) || this.pendingTranscript.length >= 5)) {
              this._commitUserPrompt(this.pendingTranscript);
            }
          }, 1300);
        }
      }
    }

    _clearTranscriptDebounce() {
      clearTimeout(this.transcriptDebounceTimer);
      this.transcriptDebounceTimer = null;
      this.pendingTranscript = '';
    }

    _commitUserPrompt(promptText) {
      const cleaned = this._stripLeadingWakeWord(promptText) || String(promptText || '').trim();
      if (!cleaned) return;
      this._clearTranscriptDebounce();
      this._cancelSegmentCapture();
      this._clearTimers();
      this.interrupted = false;
      this.lastSpokenText = '';
      this.lastSubmittedAt = Date.now();
      this.lastSubmittedNormalized = convModule ? convModule.normalizeVoiceText(cleaned) : cleaned.toLowerCase();
      submitUserPrompt(cleaned);
    }

    /** Start continuous listening when speaking or awaiting prompt. */
    async start() {
      if (this.userDisabled) return false;
      await sharedModulesReady;
      const micOk = await this.ensureMicAccess();
      if (!micOk) return false;

      if (!this.active) {
        this.active = true;
        console.log('[Docy Voice] Docy voice listener active.');
      }

      if (!this.recognition && !this._sttNetworkBlocked) {
        this.init();
      }
      if (this.recognition && !this._sttNetworkBlocked) {
        try {
          this.recognition.start();
        } catch { /* already started */ }
      }
      this._updateMicButton(true);
      return true;
    }

    /** Stop listening. Keeps mic stream by default so resuming is instant unless releaseMic=true. */
    stop(releaseMic = false) {
      this.active = false;
      this.interrupted = false;
      this.lastSpokenText = '';
      this._clearTranscriptDebounce();
      this._cancelSegmentCapture();
      this._clearTimers();
      this.vadDetector?.reset?.();
      try { this.recognition?.stop(); } catch { /* already stopped */ }

      if (releaseMic) {
        if (this.vadInterval) {
          clearInterval(this.vadInterval);
          this.vadInterval = null;
        }
        if (this.micStream) {
          try {
            this.micStream.getTracks().forEach((track) => track.stop());
          } catch { /* ignore */ }
          this.micStream = null;
          this.hasMicPermission = false;
        }
        if (this.audioCtx && this.audioCtx.state !== 'closed') {
          this.audioCtx.close().catch(() => {});
          this.audioCtx = null;
        }
      }
      this._updateMicButton(this.hasMicPermission && !this.userDisabled);
    }

    forceResume() {
      if (this.interrupted) this._resume();
    }

    _wake(triggerTranscript = '') {
      if (this.interrupted) return;
      this.interrupted = true;
      this.lastSpokenText = '';
      this._clearTranscriptDebounce();
      conversationState?.beginListening();
      pauseSpeech();
      this._updateMicButton(true);
      this._startCountdown(9);
    }

    _resume() {
      if (!this.interrupted) return;
      this.interrupted = false;
      this.lastSpokenText = '';
      this._clearTranscriptDebounce();
      this._cancelSegmentCapture();
      this._clearTimers();
      if (conversationState?.state === 'INTERRUPTED_LISTENING') {
        conversationState.state = 'MAIN_TEACHING';
      }
      this._updateMicButton(true);
      resumeSpeech();
    }

    _startCountdown(seconds, spokenPreview = null) {
      this.secondsLeft = seconds;
      clearInterval(this.countdownInterval);
      this._updateListeningHUD(spokenPreview);
      this._setListeningStyle(true);

      this.countdownInterval = setInterval(() => {
        if (this.transcribing || this.isCapturingSpeech && this.segmentHadConfirmedSpeech) {
          return;
        }
        this.secondsLeft--;
        if (this.secondsLeft <= 0) {
          this._resume();
        } else {
          this._updateListeningHUD(
            this.lastSpokenText
              ? (this.lastSpokenText.length > 36 ? this.lastSpokenText.slice(0, 33) + '…' : this.lastSpokenText)
              : null
          );
        }
      }, 1000);
    }

    _updateListeningHUD(spokenPreview) {
      if (spokenPreview) {
        updateHUDStatus(`🎙️ Heard: "${spokenPreview}" (resuming in ${this.secondsLeft}s)`);
      } else {
        updateHUDStatus(`🎙️ Docy is listening for your instruction… (${this.secondsLeft}s)`);
      }
    }

    _clearTimers() {
      clearInterval(this.countdownInterval);
      clearTimeout(this.resumeTimer);
      this.countdownInterval = null;
      this.resumeTimer = null;
      this._setListeningStyle(false);
    }

    _setListeningStyle(on) {
      if (!shadowRoot) return;
      const pulse = shadowRoot.querySelector('.status-pulse');
      if (pulse) {
        pulse.classList.toggle('listening', on);
      }
    }
  }

  const docyInterrupt = new DocyVoiceInterrupt();


  // --- HUD DOM Management ---
  function getOrCreateHUD() {
    if (hudContainer && shadowRoot) {
      if (!hudContainer.isConnected && document.body) {
        document.body.appendChild(hudContainer);
      }
      return { hudContainer, shadowRoot };
    }

    hudContainer = document.createElement('div');
    hudContainer.id = 'docvex-tutor-host';
    hudContainer.style.position = 'fixed';
    hudContainer.style.zIndex = '2147483647';
    hudContainer.style.bottom = '24px';
    hudContainer.style.right = '24px';
    hudContainer.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    shadowRoot = hudContainer.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      .hud-card {
        width: 360px;
        max-width: calc(100vw - 48px);
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid #334155;
        border-radius: 16px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
        padding: 16px;
        font-size: 14px;
        line-height: 1.5;
        transition: all 0.2s ease;
        animation: docvex-fade-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes docvex-fade-in {
        from { opacity: 0; transform: translateY(12px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .hud-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid #1e293b;
      }
      .hud-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 15px;
        color: #e2e8f0;
      }
      .hud-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 9999px;
        background: #1e1b4b;
        color: #818cf8;
        border: 1px solid #3730a3;
      }
      .hud-close {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 18px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 6px;
        line-height: 1;
      }
      .hud-close:hover {
        background: #334155;
        color: #ffffff;
      }
      .hud-status {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #cbd5e1;
        margin-bottom: 12px;
        font-size: 13px;
      }
      .status-pulse {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #38bdf8;
        animation: pulse 1.5s infinite;
        transition: background 0.3s ease;
      }
      .status-pulse.listening {
        background: #4ade80;
        animation: pulse-listen 0.6s infinite;
      }
      @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.5); opacity: 0.5; }
      }
      @keyframes pulse-listen {
        0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.6); }
        50% { transform: scale(1.6); opacity: 0.8; box-shadow: 0 0 0 5px rgba(74, 222, 128, 0); }
      }
      .hud-equalizer {
        display: none;
        align-items: flex-end;
        gap: 2.5px;
        height: 12px;
        margin-left: auto;
      }
      .hud-equalizer.active {
        display: inline-flex;
      }
      .eq-bar {
        width: 3px;
        background: #38bdf8;
        border-radius: 2px;
        animation: docvex-eq 0.8s ease-in-out infinite alternate;
      }
      .eq-bar:nth-child(1) { height: 4px; animation-delay: 0s; }
      .eq-bar:nth-child(2) { height: 11px; animation-delay: 0.2s; }
      .eq-bar:nth-child(3) { height: 6px; animation-delay: 0.4s; }
      @keyframes docvex-eq {
        0% { height: 3px; }
        100% { height: 12px; }
      }
      .hud-content {
        max-height: 240px;
        overflow-y: auto;
        color: #e2e8f0;
        font-size: 13.5px;
        margin-bottom: 14px;
        white-space: pre-wrap;
        word-break: break-word;
        padding-right: 4px;
      }
      .hud-content::-webkit-scrollbar {
        width: 4px;
      }
      .hud-content::-webkit-scrollbar-thumb {
        background: #475569;
        border-radius: 4px;
      }
      .hud-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 14px;
        border-radius: 8px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: background 0.15s ease;
      }
      .btn-primary {
        background: #4f46e5;
        color: #ffffff;
      }
      .btn-primary:hover {
        background: #4338ca;
      }
      .btn-danger {
        background: #7f1d1d;
        color: #fecaca;
        border: 1px solid #991b1b;
      }
      .btn-danger:hover {
        background: #991b1b;
      }
      .btn-secondary {
        background: #1e293b;
        color: #cbd5e1;
        border: 1px solid #334155;
      }
      .btn-secondary:hover {
        background: #334155;
        color: #ffffff;
      }
      .btn-secondary.active {
        background: #064e3b;
        color: #34d399;
        border-color: #059669;
      }
      .sources-list {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #1e293b;
        font-size: 11.5px;
        color: #94a3b8;
      }
      .source-link {
        display: inline-block;
        color: #38bdf8;
        text-decoration: none;
        margin-right: 8px;
        margin-top: 4px;
      }
      .source-link:hover {
        text-decoration: underline;
      }
      .error-msg {
        color: #f87171;
        background: #450a0a;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid #7f1d1d;
        font-size: 12.5px;
        margin-bottom: 10px;
      }
      .insights-container {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid #334155;
      }
      .insights-shimmer {
        font-size: 11.5px;
        color: #818cf8;
        background: rgba(99, 102, 241, 0.1);
        border: 1px dashed rgba(99, 102, 241, 0.35);
        border-radius: 8px;
        padding: 8px 10px;
        display: flex;
        align-items: center;
        gap: 6px;
        animation: docvex-pulse 2s infinite ease-in-out;
      }
      @keyframes docvex-pulse {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }
      .insights-card {
        background: #090d16;
        border: 1px solid #3b82f6;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.5;
        color: #e2e8f0;
      }
      .insights-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 12px;
        font-weight: 700;
        color: #93c5fd;
      }
      .insights-content {
        white-space: pre-line;
        max-height: 160px;
        overflow-y: auto;
        font-size: 11.5px;
        color: #cbd5e1;
        line-height: 1.6;
      }
      .decision-banner {
        background: #172554;
        border: 1px solid #3b82f6;
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .decision-title {
        font-size: 12.5px;
        font-weight: 700;
        color: #bfdbfe;
      }
      .decision-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .btn-proceed {
        background: #059669;
        color: #ffffff;
      }
      .btn-proceed:hover {
        background: #047857;
      }
      .btn-deny {
        background: #b45309;
        color: #ffffff;
      }
      .btn-deny:hover {
        background: #92400e;
      }
      .prompt-input-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .prompt-input {
        flex: 1;
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid #475569;
        border-radius: 7px;
        padding: 6px 9px;
        font-size: 12px;
        outline: none;
      }
      .prompt-input:focus {
        border-color: #38bdf8;
      }
    `;

    shadowRoot.appendChild(style);
    document.body.appendChild(hudContainer);

    return { hudContainer, shadowRoot };
  }

  function closeHUD() {
    stopCurrentTeachingSession(true, true);
    if (hudContainer && hudContainer.parentNode) {
      hudContainer.parentNode.removeChild(hudContainer);
      hudContainer = null;
      shadowRoot = null;
    }
  }

  function updateHUDStatus(statusText) {
    if (!shadowRoot) return;
    const statusSpan = shadowRoot.querySelector('.hud-status-text');
    if (statusSpan) {
      statusSpan.textContent = statusText;
    }
  }

  function updateHUDExplanation(text) {
    if (!shadowRoot) return;
    const contentDiv = shadowRoot.querySelector('.hud-content');
    if (contentDiv) {
      contentDiv.textContent = text;
      contentDiv.scrollTop = contentDiv.scrollHeight;
    }
  }

  function updatePlayButtonState() {
    if (!shadowRoot) return;
    const playBtn = shadowRoot.querySelector('#docvex-btn-play');
    if (playBtn) {
      if (isSpeaking && !isPaused) {
        playBtn.textContent = '⏸ Pause';
      } else if (isPaused) {
        playBtn.textContent = '▶ Resume';
      } else {
        playBtn.textContent = '▶ Play';
      }
    }
    const eq = shadowRoot.querySelector('#docvex-hud-eq');
    if (eq) {
      if (isSpeaking && !isPaused) {
        eq.classList.add('active');
      } else {
        eq.classList.remove('active');
      }
    }
  }

  function updateHUDBadge(groundingStatus) {
    if (!shadowRoot) return;
    const badge = shadowRoot.querySelector('#docvex-title-badge');
    if (!badge) return;

    if (groundingStatus === 'grounded') {
      badge.textContent = '🟢 Grounded in Docs';
      badge.style.background = '#064e3b';
      badge.style.color = '#34d399';
      badge.style.border = '1px solid #059669';
    } else {
      badge.textContent = '⚪ General Knowledge';
      badge.style.background = '#1e293b';
      badge.style.color = '#94a3b8';
      badge.style.border = '1px solid #334155';
    }
  }

  function renderHUDSkeleton({ status = 'Understanding selected text…', error = null }) {
    const { shadowRoot } = getOrCreateHUD();

    let existingCard = shadowRoot.querySelector('.hud-card');
    if (!existingCard) {
      existingCard = document.createElement('div');
      existingCard.className = 'hud-card';
      shadowRoot.appendChild(existingCard);
    } else {
      existingCard.replaceChildren();
    }

    // 1. Header
    const header = document.createElement('div');
    header.className = 'hud-header';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'hud-title';

    const titleIcon = document.createElement('span');
    titleIcon.textContent = '🎓 DocVex';

    const titleBadge = document.createElement('span');
    titleBadge.id = 'docvex-title-badge';
    titleBadge.className = 'hud-badge';
    titleBadge.textContent = 'Local Tutor';

    titleDiv.appendChild(titleIcon);
    titleDiv.appendChild(titleBadge);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'docvex-btn-close';
    closeBtn.className = 'hud-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = closeHUD;

    header.appendChild(titleDiv);
    header.appendChild(closeBtn);
    existingCard.appendChild(header);

    // 2. Status Row
    const statusRow = document.createElement('div');
    statusRow.className = 'hud-status';

    const pulseSpan = document.createElement('span');
    pulseSpan.className = 'status-pulse';

    const statusTextSpan = document.createElement('span');
    statusTextSpan.className = 'hud-status-text';
    statusTextSpan.textContent = status;

    statusRow.appendChild(pulseSpan);
    statusRow.appendChild(statusTextSpan);

    const eqDiv = document.createElement('div');
    eqDiv.className = 'hud-equalizer';
    eqDiv.id = 'docvex-hud-eq';
    for (let i = 0; i < 3; i++) {
      const bar = document.createElement('span');
      bar.className = 'eq-bar';
      eqDiv.appendChild(bar);
    }
    statusRow.appendChild(eqDiv);

    existingCard.appendChild(statusRow);

    // 3. Error message (if any)
    if (error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'error-msg';
      errorDiv.textContent = error;
      existingCard.appendChild(errorDiv);
      return;
    }

    // 4. Content Area
    const contentDiv = document.createElement('div');
    contentDiv.className = 'hud-content';
    contentDiv.id = 'docvex-hud-content';
    contentDiv.textContent = '';
    existingCard.appendChild(contentDiv);

    // 4b. Decision / Active Prompt Banner Container (Proceed vs Deny)
    const decisionDiv = document.createElement('div');
    decisionDiv.id = 'docvex-decision-container';
    decisionDiv.style.display = 'none';
    existingCard.appendChild(decisionDiv);

    // 5. Audio Controls
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'hud-controls';

    const playBtn = document.createElement('button');
    playBtn.id = 'docvex-btn-play';
    playBtn.className = 'btn btn-primary';
    playBtn.textContent = '⏸ Pause';
    playBtn.onclick = () => {
      if (isSpeaking && !isPaused) {
        pauseSpeech();
      } else if (isPaused) {
        docyInterrupt.forceResume(); // clear Docy countdown if it triggered the pause
        resumeSpeech();
      } else if (currentSpeechText) {
        startSpeechQueueFromText(currentSpeechText);
      }
    };

    const stopBtn = document.createElement('button');
    stopBtn.id = 'docvex-btn-stop';
    stopBtn.className = 'btn btn-danger';
    stopBtn.textContent = '⏹ Stop';
    stopBtn.onclick = () => {
      stopCurrentTeachingSession(true, false);
      hideDecisionBanner();
      updateHUDStatus('Teaching stopped.');
    };

    const micBtn = document.createElement('button');
    micBtn.id = 'docvex-btn-mic';
    micBtn.className = 'btn btn-secondary';
    micBtn.title = 'Click to enable Docy voice interrupt';
    micBtn.textContent = docyInterrupt.hasMicPermission ? '🎙️ Docy: On' : '🎙️ Enable Mic';
    if (docyInterrupt.hasMicPermission) micBtn.classList.add('active');
    micBtn.onclick = async () => {
      await docyInterrupt.toggleMicAccess();
    };

    controlsDiv.appendChild(playBtn);
    controlsDiv.appendChild(stopBtn);
    controlsDiv.appendChild(micBtn);
    existingCard.appendChild(controlsDiv);

    // 6. Sources Container (populated when metadata/sources arrive)
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'sources-list';
    sourcesDiv.id = 'docvex-sources-list';
    sourcesDiv.style.display = 'none';
    existingCard.appendChild(sourcesDiv);

    // 7. Local Insights Container (for hybrid background reasoning)
    const insightsDiv = document.createElement('div');
    insightsDiv.className = 'insights-container';
    insightsDiv.id = 'docvex-insights-container';
    insightsDiv.style.display = 'none';
    existingCard.appendChild(insightsDiv);
  }

  function hideDecisionBanner() {
    if (!shadowRoot) return;
    const div = shadowRoot.querySelector('#docvex-decision-container');
    if (div) {
      div.replaceChildren();
      div.style.display = 'none';
    }
  }

  function renderContinuePromptBanner() {
    if (!shadowRoot) return;
    const div = shadowRoot.querySelector('#docvex-decision-container');
    if (!div) return;

    div.replaceChildren();
    const banner = document.createElement('div');
    banner.className = 'decision-banner';

    const title = document.createElement('div');
    title.className = 'decision-title';
    title.textContent = 'Continue from previous explanation?';

    const actions = document.createElement('div');
    actions.className = 'decision-actions';

    const proceedBtn = document.createElement('button');
    proceedBtn.id = 'docvex-btn-proceed';
    proceedBtn.className = 'btn btn-proceed';
    proceedBtn.textContent = '▶ Proceed';
    proceedBtn.onclick = () => handleProceedPrevious();

    const denyBtn = document.createElement('button');
    denyBtn.id = 'docvex-btn-deny';
    denyBtn.className = 'btn btn-deny';
    denyBtn.textContent = '🎙️ Deny (New Prompt)';
    denyBtn.onclick = () => handleDenyContinue();

    actions.appendChild(proceedBtn);
    actions.appendChild(denyBtn);
    banner.appendChild(title);
    banner.appendChild(actions);
    div.appendChild(banner);
    div.style.display = 'block';
  }

  function renderAwaitingPromptBanner() {
    if (!shadowRoot) return;
    const div = shadowRoot.querySelector('#docvex-decision-container');
    if (!div) return;

    div.replaceChildren();
    const banner = document.createElement('div');
    banner.className = 'decision-banner';

    const title = document.createElement('div');
    title.className = 'decision-title';
    title.textContent = '🎙️ Speak your new instruction or question (or type below):';

    const inputRow = document.createElement('div');
    inputRow.className = 'prompt-input-row';

    const input = document.createElement('input');
    input.id = 'docvex-prompt-input';
    input.className = 'prompt-input';
    input.type = 'text';
    input.placeholder = 'e.g. Give the actual output or explain step 2…';
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        docyInterrupt._commitUserPrompt(input.value.trim());
      }
    };

    const sendBtn = document.createElement('button');
    sendBtn.id = 'docvex-btn-send-prompt';
    sendBtn.className = 'btn btn-primary';
    sendBtn.textContent = 'Ask';
    sendBtn.onclick = () => {
      if (input.value.trim()) {
        docyInterrupt._commitUserPrompt(input.value.trim());
      } else if (docyInterrupt.isCapturingSpeech) {
        docyInterrupt._finishSegmentCaptureAndTranscribe(true);
      }
    };

    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    const actions = document.createElement('div');
    actions.className = 'decision-actions';

    const finishMicBtn = document.createElement('button');
    finishMicBtn.id = 'docvex-btn-finish-voice';
    finishMicBtn.className = 'btn btn-secondary';
    finishMicBtn.textContent = '⏹ Done Speaking';
    finishMicBtn.onclick = () => {
      if (docyInterrupt.pendingTranscript) {
        docyInterrupt._commitUserPrompt(docyInterrupt.pendingTranscript);
      } else {
        docyInterrupt._finishSegmentCaptureAndTranscribe(true);
      }
    };
    actions.appendChild(finishMicBtn);

    if (conversationState?.hasMainSession()) {
      const backBtn = document.createElement('button');
      backBtn.className = 'btn btn-proceed';
      backBtn.textContent = '▶ Proceed Previous';
      backBtn.onclick = () => handleProceedPrevious();
      actions.appendChild(backBtn);
    }

    banner.appendChild(title);
    banner.appendChild(inputRow);
    banner.appendChild(actions);
    div.appendChild(banner);
    div.style.display = 'block';
  }

  function syncAwaitingPromptInput(text) {
    if (!shadowRoot) return;
    const input = shadowRoot.querySelector('#docvex-prompt-input');
    if (input) {
      input.value = text;
    }
  }

  function showHUDInsightsShimmer() {
    if (!shadowRoot) return;
    const insightsDiv = shadowRoot.querySelector('#docvex-insights-container');
    if (!insightsDiv) return;

    insightsDiv.replaceChildren();
    const shimmer = document.createElement('div');
    shimmer.className = 'insights-shimmer';
    shimmer.textContent = '🧠 Computing local deep dive & gotchas (Ollama reasoning in background)…';
    insightsDiv.appendChild(shimmer);
    insightsDiv.style.display = 'block';
  }

  function renderHUDInsights(insightsText) {
    if (!shadowRoot || !insightsText) return;
    const insightsDiv = shadowRoot.querySelector('#docvex-insights-container');
    if (!insightsDiv) return;

    insightsDiv.replaceChildren();

    const card = document.createElement('div');
    card.className = 'insights-card';

    const header = document.createElement('div');
    header.className = 'insights-header';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = '🧠 Local Deep Dive & Gotchas (Ollama)';

    const listenBtn = document.createElement('button');
    listenBtn.className = 'btn btn-primary';
    listenBtn.style.padding = '3px 9px';
    listenBtn.style.fontSize = '11px';
    listenBtn.textContent = '🔊 Read Summary';
    listenBtn.onclick = () => {
      startSpeechQueueFromText(insightsText);
    };

    header.appendChild(titleSpan);
    header.appendChild(listenBtn);
    card.appendChild(header);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'insights-content';
    bodyDiv.textContent = insightsText;
    card.appendChild(bodyDiv);

    insightsDiv.appendChild(card);
    insightsDiv.style.display = 'block';
  }

  function renderHUDSources(sources) {
    if (!shadowRoot || !Array.isArray(sources) || sources.length === 0) return;
    const sourcesDiv = shadowRoot.querySelector('#docvex-sources-list');
    if (!sourcesDiv) return;

    sourcesDiv.replaceChildren();
    const sourcesHeader = document.createElement('strong');
    sourcesHeader.textContent = 'Verified Sources:';
    sourcesDiv.appendChild(sourcesHeader);
    sourcesDiv.appendChild(document.createElement('br'));

    sources.forEach((s) => {
      const link = document.createElement('a');
      link.className = 'source-link';
      link.textContent = s.domain || s.title || 'Official Source';
      if (s.url && isSafeUrl(s.url)) {
        link.href = s.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.href = '#';
      }
      sourcesDiv.appendChild(link);
    });

    sourcesDiv.style.display = 'block';
  }

  let cachedVoices = [];
  function updateVoices() {
    if ('speechSynthesis' in window) {
      const v = window.speechSynthesis.getVoices();
      if (v && v.length > 0) {
        cachedVoices = v;
      }
    }
  }
  updateVoices();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = updateVoices;
  }

  // --- Speech Queue & Playback Engine ---
  let followUpStreamDone = false;
  let followUpAudioStarted = false;

  function onAudioQueueDrained() {
    isSpeaking = false;
    isPaused = false;
    docyInterrupt.setCurrentSpeakingText('');
    updatePlayButtonState();

    if (currentSessionIsFollowUp && conversationState?.state === 'FOLLOWUP_ANSWERING') {
      const nextState = conversationState.completeFollowUp(currentSpeechText);
      if (nextState === 'ASK_CONTINUE') {
        renderContinuePromptBanner();
        updateHUDStatus('💬 Continue from previous explanation? Click Proceed or Deny.');
        if (!docyInterrupt.userDisabled) {
          docyInterrupt.start().catch(() => {});
        }
        return;
      }
    }

    docyInterrupt.stop(false);
    updateHUDStatus('Finished speaking.');
  }

  function queueSpeechSentence(sentence, index, requestId, mainSentenceIndex = -1) {
    if (!sentence || !('speechSynthesis' in window)) return;
    if (requestId !== activeRequestId) return; // Discard stale requests

    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.rate = 0.97;
    utterance.pitch = 1.0;

    const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
    const naturalVoice = voiceSelector ? voiceSelector.selectBestSpeechVoice(voices) : (voices[0] || null);
    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    utterance.onstart = () => {
      if (requestId !== activeRequestId) {
        window.speechSynthesis.cancel();
        return;
      }

      if (currentSessionIsFollowUp) {
        followUpAudioStarted = true;
      }

      if (index === 1 && timingMetrics.t6 === 0) {
        timingMetrics.t6 = performance.now();
        const latency = Math.round(timingMetrics.t6 - timingMetrics.t0);
        console.log(`[DocVex Timing] First Audible Speech (T0->T6): ${latency}ms`);
      }

      isSpeaking = true;
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus(currentSessionIsFollowUp ? '🗣️ Answering your instruction…' : '🔊 Speaking explanation…');
      docyInterrupt.setCurrentSpeakingText(sentence);
      if (!docyInterrupt.userDisabled) {
        docyInterrupt.start().catch(() => {});
      }

      if (!speechKeepAliveInterval) {
        speechKeepAliveInterval = setInterval(() => {
          if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
            window.speechSynthesis.resume();
          }
        }, 10000);
      }
    };

    utterance.onend = () => {
      const idx = activeUtterances.indexOf(utterance);
      if (idx !== -1) {
        activeUtterances.splice(idx, 1);
      }

      if (requestId === activeRequestId && !currentSessionIsFollowUp && mainSentenceIndex >= 0) {
        conversationState?.markMainSentenceCompleted(mainSentenceIndex);
      }

      if (activeUtterances.length === 0 && !window.speechSynthesis.speaking) {
        clearInterval(speechKeepAliveInterval);
        speechKeepAliveInterval = null;
        onAudioQueueDrained();
      }
    };

    utterance.onerror = (e) => {
      const idx = activeUtterances.indexOf(utterance);
      if (idx !== -1) {
        activeUtterances.splice(idx, 1);
      }
      if (e.error !== 'canceled' && e.error !== 'interrupted') {
        console.warn('SpeechSynthesis error:', e.error);
      }
      if (activeUtterances.length === 0 && !window.speechSynthesis.speaking) {
        clearInterval(speechKeepAliveInterval);
        speechKeepAliveInterval = null;
        onAudioQueueDrained();
      }
    };

    // Retain in memory to prevent Chrome utterance GC bug
    activeUtterances.push(utterance);
    window.speechSynthesis.speak(utterance);
  }

  function playNextChatterboxAudio() {
    if (isChatterboxPlaying || chatterboxAudioQueue.length === 0) return;
    const item = chatterboxAudioQueue.shift();
    if (!item || item.requestId !== activeRequestId) {
      playNextChatterboxAudio();
      return;
    }

    const blob = new Blob([item.audioBuffer], { type: 'audio/wav' });
    const objectUrl = URL.createObjectURL(blob);
    chatterboxObjectUrls.add(objectUrl);
    const audio = new Audio(objectUrl);
    activeAudio = audio;
    isChatterboxPlaying = true;

    audio.onplay = () => {
      if (item.requestId !== activeRequestId) {
        finish();
        return;
      }
      if (timingMetrics.t6 === 0) {
        timingMetrics.t6 = performance.now();
        console.log(`[DocVex Timing] Chatterbox Playback Started (T0->T6): ${Math.round(timingMetrics.t6 - timingMetrics.t0)}ms`);
      }
      isSpeaking = true;
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking with local Chatterbox…');
      docyInterrupt.setCurrentSpeakingText(item.sentence || item.speechText || '');
      if (!docyInterrupt.userDisabled) {
        docyInterrupt.start().catch(() => {});
      }
    };

    const finish = () => {
      isChatterboxPlaying = false;
      activeAudio = null;
      URL.revokeObjectURL(objectUrl);
      chatterboxObjectUrls.delete(objectUrl);
      if (item.requestId === activeRequestId) {
        playNextChatterboxAudio();
        if (!isChatterboxPlaying && chatterboxAudioQueue.length === 0) {
          onAudioQueueDrained();
        }
      }
    };

    audio.onended = finish;
    audio.onerror = () => {
      finish();
      if (item.requestId === activeRequestId) {
        queueSpeechSentence(item.sentence, item.sentenceIndex, item.requestId);
        updateHUDStatus('Local Chatterbox audio failed; using browser speech fallback.');
      }
    };
    audio.play().catch(() => {
      audio.onerror?.();
    });
  }

  function queueChatterboxAudio(data, requestId) {
    if (!data?.audioBuffer || requestId !== activeRequestId) return;
    chatterboxAudioQueue.push({ ...data, requestId });
    playNextChatterboxAudio();
  }

  function stopChatterboxAudio() {
    chatterboxAudioQueue = [];
    isChatterboxPlaying = false;
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
    chatterboxObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    chatterboxObjectUrls.clear();
  }

  function pauseSpeech() {
    if (chatterboxEnabled && activePort) {
      activePort.postMessage({ action: 'PAUSE_AUDIO' });
      isPaused = true;
      updatePlayButtonState();
      updateHUDStatus('⏸ Audio paused');
      return;
    }
    if (activeAudio && isChatterboxPlaying) {
      activeAudio.pause();
      isPaused = true;
      updatePlayButtonState();
      updateHUDStatus('⏸ Audio paused');
      return;
    }
    if (window.speechSynthesis && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      isPaused = true;
      updatePlayButtonState();
      updateHUDStatus('⏸ Audio paused');
    }
  }

  function resumeSpeech() {
    let resumed = false;
    if (chatterboxEnabled && activePort && isPaused) {
      activePort.postMessage({ action: 'RESUME_AUDIO' });
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking with local Chatterbox… (Docy listening)');
      resumed = true;
    } else if (activeAudio && isPaused) {
      activeAudio.play().catch(() => {});
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking with local Chatterbox… (Docy listening)');
      resumed = true;
    } else if (window.speechSynthesis && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking explanation… (Docy listening)');
      resumed = true;
    }

    if (resumed && !docyInterrupt.userDisabled) {
      docyInterrupt.start().catch(() => {});
    }
  }

  function stopSpeech(releaseMic = false) {
    docyInterrupt.stop(releaseMic);
    docyInterrupt.setCurrentSpeakingText('');
    if (chatterboxEnabled && activePort) {
      activePort.postMessage({ action: 'STOP_AUDIO' });
    }
    stopChatterboxAudio();
    clearInterval(speechKeepAliveInterval);
    speechKeepAliveInterval = null;
    activeUtterances = [];
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    isSpeaking = false;
    isPaused = false;
    updatePlayButtonState();
  }

  function startSpeechQueueFromText(fullText) {
    stopSpeech(false);
    const sentences = fullText.match(/[^.!?]+[.!?]+(\s|$)/g) || [fullText];
    const currentReq = activeRequestId || 'local_replay';
    sentences.forEach((s, idx) => {
      const cleaned = safeShapeSpeechText(s);
      if (cleaned) {
        queueSpeechSentence(cleaned, idx + 1, currentReq);
      }
    });
  }

  function resetStreamingTransportOnly(releaseMic = false) {
    stopSpeech(releaseMic);
    if (activePort) {
      try {
        activePort.postMessage({ action: 'ABORT_STREAM', requestId: activeRequestId });
      } catch {
        // Port may already be disconnected
      }
      try {
        activePort.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      activePort = null;
    }
    activeRequestId = null;
    chatterboxEnabled = true;
    updatePlayButtonState();
  }

  function stopCurrentTeachingSession(resetConversation = true, releaseMic = false) {
    resetStreamingTransportOnly(releaseMic);
    currentSessionIsFollowUp = false;
    currentSessionResumeOffset = 0;
    if (resetConversation) {
      conversationState?.reset();
    }
  }

  async function enterActivePromptListening() {
    await sharedModulesReady;
    resetStreamingTransportOnly(false);
    conversationState?.denyContinue();
    docyInterrupt.userDisabled = false;
    renderAwaitingPromptBanner();
    updateHUDStatus('🎙️ Listening for your instruction or question…');
    const started = await docyInterrupt.start();
    if (started) {
      docyInterrupt._setListeningStyle(true);
    }
  }

  function handleDenyContinue() {
    enterActivePromptListening();
  }

  function handleProceedPrevious() {
    hideDecisionBanner();
    if (!conversationState || !conversationState.hasMainSession()) {
      resumeSpeech();
      return;
    }
    const resumeData = conversationState.proceedMainSession();
    if (resumeData.remainingSentences && resumeData.remainingSentences.length > 0) {
      triggerTeaching(null, {
        continueSentences: resumeData.remainingSentences,
        restoredText: resumeData.fullText,
        resumeFromIndex: resumeData.resumeFromIndex,
      });
    } else if (resumeData.fullText) {
      updateHUDExplanation(resumeData.fullText);
      updateHUDStatus('✅ Back to previous explanation.');
    }
  }

  function submitUserPrompt(promptText) {
    const cleanPrompt = String(promptText || '').trim();
    if (!cleanPrompt) return;
    hideDecisionBanner();
    const followUpContext = conversationState ? conversationState.getFollowUpContext() : currentSpeechText;
    const followUpSelectedText = conversationState?.mainSession?.selectedText || '';
    conversationState?.startFollowUp(cleanPrompt);
    triggerTeaching(cleanPrompt, {
      isFollowUp: true,
      followUpContext,
      followUpSelectedText,
    });
  }

  // --- Main Teaching Flow ---
  let lastTriggerTime = 0;

  async function triggerTeaching(selectionOverride = null, flowOpts = {}) {
    await sharedModulesReady;

    const isFollowUp = Boolean(flowOpts.isFollowUp);
    const continueSentences = Array.isArray(flowOpts.continueSentences) ? flowOpts.continueSentences : [];
    const isContinueResume = continueSentences.length > 0;

    const now = performance.now();
    if (!isFollowUp && !isContinueResume && now - lastTriggerTime < 500) {
      return;
    }
    lastTriggerTime = now;

    let selectedText = (selectionOverride || '').trim();
    if (!isContinueResume) {
      if (!selectedText) {
        selectedText = (window.getSelection() ? window.getSelection().toString() : '').trim();
      }
      if (!selectedText && document.activeElement) {
        const el = document.activeElement;
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
          selectedText = (el.value || '').substring(el.selectionStart, el.selectionEnd).trim();
        }
      }

      if (!selectedText) {
        renderHUDSkeleton({
          status: 'No text selected',
          error: 'Select some text on the webpage first, then press Ctrl+Shift+S.',
        });
        return;
      }
    }

    // 1. Preserve main session across follow-ups & resumes; reset only on fresh selection
    if (isFollowUp || isContinueResume) {
      resetStreamingTransportOnly(false);
    } else {
      stopCurrentTeachingSession(true, false);
      conversationState?.startMainSession({ selectedText });
    }

    currentSessionIsFollowUp = isFollowUp;
    currentSessionResumeOffset = isContinueResume ? Number(flowOpts.resumeFromIndex || 0) : 0;
    followUpStreamDone = false;
    followUpAudioStarted = false;

    // 2. Setup new session ID & timing
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    activeRequestId = requestId;
    let activePlayingChatterboxIdx = -1;

    timingMetrics = {
      t0: performance.now(),
      t4: 0,
      t5: 0,
      t6: 0,
      t7: 0,
    };

    const initialStatus = isFollowUp
      ? `💭 Answering: "${selectedText.length > 40 ? selectedText.slice(0, 37) + '…' : selectedText}"`
      : (isContinueResume ? '▶ Continuing from previous explanation…' : 'Understanding selected text…');

    renderHUDSkeleton({ status: initialStatus });
    if (isContinueResume && flowOpts.restoredText) {
      currentSpeechText = flowOpts.restoredText;
      updateHUDExplanation(flowOpts.restoredText);
    }

    let accumulatedText = '';
    if (!isContinueResume) {
      currentSpeechText = '';
    }

    const SentenceBufferClass = speechCore?.SentenceBuffer;
    const sentenceBuffer = SentenceBufferClass
      ? new SentenceBufferClass({
          minSentenceLength: 4,
          onSentence: (sentence, index) => {
            if (requestId !== activeRequestId) return;

            if (index === 1 && timingMetrics.t5 === 0) {
              timingMetrics.t5 = performance.now();
              const latencyT5 = Math.round(timingMetrics.t5 - timingMetrics.t0);
              console.log(`[DocVex Timing] First Complete Sentence (T0->T5): ${latencyT5}ms: "${sentence}"`);
            }

            let localMainIndex = -1;
            if (!isFollowUp && !isContinueResume && conversationState) {
              localMainIndex = conversationState.recordMainSentence(sentence);
            } else if (isContinueResume) {
              localMainIndex = currentSessionResumeOffset + (index - 1);
            }

            // Chatterbox audio arrives through the background worker; use browser speech only as fallback.
            if (!chatterboxEnabled) {
              queueSpeechSentence(sentence, index, requestId, localMainIndex);
            }
          },
        })
      : null;

    // 4. Connect bidirectional port to background service worker
    try {
      activePort = chrome.runtime.connect({ name: 'docvex-stream' });
    } catch {
      renderHUDSkeleton({
        status: 'Extension error',
        error: 'Failed to connect to DocVex extension background service.',
      });
      return;
    }

    activePort.onMessage.addListener((msg) => {
      // Stale response protection: drop any message not matching current session
      if (msg.requestId !== activeRequestId) {
        return;
      }

      if (msg.action === 'STREAM_EVENT') {
        const { event, data } = msg;

        if (event === 'metadata') {
          chatterboxEnabled = Boolean(data.chatterbox?.enabled);
          updateHUDStatus(isFollowUp ? '🗣️ Preparing answer…' : (isContinueResume ? '▶ Resuming voice…' : '🎓 Analyzing concepts…'));
          if (data.groundingStatus) {
            updateHUDBadge(data.groundingStatus);
          }
          if (data.groundingStatus === 'grounded' && Array.isArray(data.sources)) {
            renderHUDSources(data.sources);
          }
          if (data.isHybrid && !isFollowUp && !isContinueResume) {
            showHUDInsightsShimmer();
          }
        } else if (event === 'token') {
          if (timingMetrics.t4 === 0) {
            timingMetrics.t4 = performance.now();
            const latencyT4 = Math.round(timingMetrics.t4 - timingMetrics.t0);
            console.log(`[DocVex Timing] First Token (T0->T4): ${latencyT4}ms`);
            updateHUDStatus(isFollowUp ? '✍️ Answering…' : (isContinueResume ? '▶ Continuing explanation…' : '✍️ Explaining…'));
          }

          accumulatedText += data.token;
          if (!isContinueResume) {
            currentSpeechText = accumulatedText;
            updateHUDExplanation(accumulatedText);
          }
          sentenceBuffer?.addToken(data.token);
        } else if (event === 'speech_done') {
          sentenceBuffer?.flush();
          if (!isSpeaking) {
            updateHUDStatus(chatterboxEnabled ? '🎙️ Synthesizing voice with Chatterbox…' : '🔊 Speaking explanation…');
          }
          if (data.explanation && !isContinueResume) {
            currentSpeechText = data.explanation;
            updateHUDExplanation(data.explanation);
          }
        } else if (event === 'local_insights') {
          if (data.insights) {
            renderHUDInsights(data.insights);
          }
        } else if (event === 'audio_error') {
          console.error('[DocVex audio_error event]', data);
          if (data.sentence && data.requestId === activeRequestId) {
            const rawIdx = Number(data.sentenceIndex ?? 1);
            const mappedIdx = isFollowUp ? -1 : (isContinueResume ? currentSessionResumeOffset + rawIdx : Math.max(0, rawIdx - 1));
            queueSpeechSentence(data.sentence, data.sentenceIndex, data.requestId, mappedIdx);
            updateHUDStatus('Local Chatterbox audio failed; using browser speech fallback.');
          }
        } else if (event === 'done') {
          timingMetrics.t7 = performance.now();
          const latencyT7 = Math.round(timingMetrics.t7 - timingMetrics.t0);
          console.log(`[DocVex Timing] Full Generation Finished (T0->T7): ${latencyT7}ms`);

          sentenceBuffer?.flush();

          if (!isFollowUp && !isContinueResume && conversationState) {
            conversationState.setMainFullText(data.explanation || currentSpeechText);
            conversationState.markMainStreamDone();
          }

          if (data.groundingStatus) {
            updateHUDBadge(data.groundingStatus);
          }

          if (data.explanation && !isContinueResume) {
            currentSpeechText = data.explanation;
            updateHUDExplanation(data.explanation);
          }

          if (data.insights) {
            renderHUDInsights(data.insights);
          }

          if (data.groundingStatus === 'grounded' && Array.isArray(data.sources)) {
            renderHUDSources(data.sources);
          }

          if (isFollowUp) {
            followUpStreamDone = true;
            if (!isSpeaking && chatterboxAudioQueue.length === 0 && activeUtterances.length === 0 && (!chatterboxEnabled || !followUpAudioStarted)) {
              onAudioQueueDrained();
              return;
            }
          }

          if (!chatterboxEnabled && !isSpeaking) {
            updateHUDStatus('Explanation complete.');
          } else if (chatterboxEnabled && !isSpeaking) {
            updateHUDStatus('🎙️ Synthesizing voice with Chatterbox…');
          }
        } else if (event === 'error') {
          const isOverload = data.statusCode === 503 || data.statusCode === 429;
          if (isOverload) {
            updateHUDStatus('⚡ Groq overloaded — switching to Ollama fallback…');
          } else {
            renderHUDSkeleton({
              status: 'Error',
              error: data.error || 'Server error occurred during streaming.',
            });
          }
        }
      } else if (msg.action === 'AUDIO_PLAYBACK') {
        const data = msg.data || {};
        if (msg.requestId !== activeRequestId) return;
        if (msg.event === 'started') {
          if (currentSessionIsFollowUp) {
            followUpAudioStarted = true;
          }
          if (typeof data.sentenceIndex === 'number') {
            activePlayingChatterboxIdx = data.sentenceIndex;
          }
          if (timingMetrics.t6 === 0) {
            timingMetrics.t6 = performance.now();
            console.log(`[DocVex Timing] Chatterbox Playback Started (T0->T6): ${Math.round(timingMetrics.t6 - timingMetrics.t0)}ms`);
          }
          isSpeaking = true;
          isPaused = false;
          updatePlayButtonState();
          updateHUDStatus(
            currentSessionIsFollowUp
              ? '🗣️ Answering with Chatterbox…'
              : `🔊 Speaking with local Chatterbox… (sentence ${data.sentenceIndex || 1})`
          );
          docyInterrupt.setCurrentSpeakingText(data.sentence || data.speechText || '');
          if (!docyInterrupt.userDisabled) {
            docyInterrupt.start().catch(() => {});
          }
        } else if (msg.event === 'ended') {
          const endedRawIdx = typeof data.sentenceIndex === 'number' ? data.sentenceIndex : activePlayingChatterboxIdx;
          if (!isFollowUp && conversationState && endedRawIdx >= 0) {
            const completedIdx = isContinueResume
              ? currentSessionResumeOffset + endedRawIdx
              : Math.max(0, endedRawIdx - 1);
            conversationState.markMainSentenceCompleted(completedIdx);
          }

          if (data.hasMore) {
            updateHUDStatus(currentSessionIsFollowUp ? '🗣️ Answering with Chatterbox…' : '🔊 Speaking with local Chatterbox…');
          } else {
            onAudioQueueDrained();
          }
        } else if (msg.event === 'error') {
          const rawIdx = Number(data.sentenceIndex ?? 1);
          const mappedIdx = isFollowUp ? -1 : (isContinueResume ? currentSessionResumeOffset + rawIdx : Math.max(0, rawIdx - 1));
          queueSpeechSentence(data.sentence, data.sentenceIndex, msg.requestId, mappedIdx);
          updateHUDStatus('Local Chatterbox audio failed; using browser speech fallback.');
        }
      } else if (msg.action === 'AUDIO_ERROR') {
        const data = msg.data || {};
        if (data.sentence && msg.requestId === activeRequestId) {
          const rawIdx = Number(data.sentenceIndex ?? 1);
          const mappedIdx = isFollowUp ? -1 : (isContinueResume ? currentSessionResumeOffset + rawIdx : Math.max(0, rawIdx - 1));
          queueSpeechSentence(data.sentence, data.sentenceIndex, msg.requestId, mappedIdx);
          updateHUDStatus('Local Chatterbox audio failed; using browser speech fallback.');
        }
      } else if (msg.action === 'STREAM_ERROR') {
        renderHUDSkeleton({
          status: 'Error',
          error: msg.error || 'Connection to DocVex backend failed.',
        });
      }
    });

    activePort.onDisconnect.addListener(() => {
      // If disconnected unexpectedly while still waiting for the same session
      if (activeRequestId === requestId && timingMetrics.t7 === 0) {
        console.warn('DocVex stream port disconnected.');
      }
    });

    // 5. Extract surrounding text for zero-latency fast path on allowlisted pages
    function extractSurroundingContext() {
      try {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          let container = range.commonAncestorContainer;
          if (container && container.nodeType === 3) {
            container = container.parentElement;
          }
          if (container) {
            const sectionEl =
              container.closest('article, main, section, [role="main"], .content, .documentation, .markdown-body') ||
              container;
            const text = (sectionEl.innerText || sectionEl.textContent || '').trim();
            return text.slice(0, 2000);
          }
        }
      } catch {
        // Ignore DOM traversal error
      }
      return '';
    }

    // 6. Dispatch START_STREAM to backend via port with chosen provider
    const sendStreamRequest = (preferredProvider) => {
      if (!activePort || requestId !== activeRequestId) return;
      const payload = {
        text: isContinueResume ? 'Continue previous explanation.' : selectedText,
        title: document.title || '',
        url: window.location.href || '',
        pageContext: extractSurroundingContext(),
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(isFollowUp ? {
          isFollowUp: true,
          followUpContext: flowOpts.followUpContext || '',
          followUpSelectedText: flowOpts.followUpSelectedText || '',
        } : {}),
        ...(isContinueResume ? { continueSentences } : {}),
      };

      activePort.postMessage({
        action: 'START_STREAM',
        requestId,
        payload,
      });
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['docvexProvider'], (result) => {
        sendStreamRequest(result?.docvexProvider || 'hybrid');
      });
    } else {
      sendStreamRequest('hybrid');
    }
  }

  function isKeyS(e) {
    return (
      e.code === 'KeyS' ||
      e.keyCode === 83 ||
      e.which === 83 ||
      e.key === 's' ||
      e.key === 'S' ||
      e.key === '\u0013' ||
      e.key === 'DeviceControl3'
    );
  }

  // In-page keyboard shortcut listener (captures Control+Shift+S and Command+Shift+S in capturing phase)
  document.addEventListener(
    'keydown',
    (e) => {
      const isModifier = e.ctrlKey || e.metaKey;
      if (isModifier && e.shiftKey && isKeyS(e)) {
        e.preventDefault();
        e.stopPropagation();
        triggerTeaching();
      }
    },
    true
  );

  // Floating Action Pill on text selection
  let floatingBtn = null;

  function removeFloatingBtn() {
    if (floatingBtn && floatingBtn.parentNode) {
      floatingBtn.parentNode.removeChild(floatingBtn);
      floatingBtn = null;
    }
  }

  document.addEventListener('selectionchange', () => {
    setTimeout(() => {
      const selection = window.getSelection();
      const text = (selection ? selection.toString() : '').trim();
      if (!text || text.length < 2) {
        removeFloatingBtn();
        return;
      }

      if (selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      if (!floatingBtn) {
        floatingBtn = document.createElement('button');
        floatingBtn.id = 'docvex-floating-trigger';
        floatingBtn.style.position = 'fixed';
        floatingBtn.style.zIndex = '2147483646';
        floatingBtn.style.background = '#4f46e5';
        floatingBtn.style.color = '#ffffff';
        floatingBtn.style.padding = '6px 14px';
        floatingBtn.style.borderRadius = '20px';
        floatingBtn.style.fontSize = '12px';
        floatingBtn.style.fontWeight = '600';
        floatingBtn.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        floatingBtn.style.cursor = 'pointer';
        floatingBtn.style.boxShadow = '0 4px 14px rgba(0,0,0,0.35)';
        floatingBtn.style.border = '1px solid #6366f1';
        floatingBtn.style.userSelect = 'none';
        floatingBtn.textContent = '🎓 Teach me (⌃⇧S)';

        floatingBtn.onmousedown = (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const currentText = (window.getSelection() ? window.getSelection().toString() : '').trim() || text;
          removeFloatingBtn();
          triggerTeaching(currentText);
        };

        document.body.appendChild(floatingBtn);
      }

      const top = Math.max(10, rect.top - 38);
      const left = Math.min(window.innerWidth - 180, Math.max(10, rect.left + rect.width / 2 - 75));
      floatingBtn.style.top = `${top}px`;
      floatingBtn.style.left = `${left}px`;
    }, 120);
  });

  document.addEventListener('mousedown', (e) => {
    if (floatingBtn && !floatingBtn.contains(e.target)) {
      removeFloatingBtn();
    }
  });

  // Listen for custom trigger message from webpage
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'DOCVEX_TRIGGER_TEACH') {
      triggerTeaching(e.data.text || null);
    }
  });

  // Listen for messages from background script (shortcut or context menu)
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'TRIGGER_TEACH') {
      triggerTeaching(request.selectedText);
    }
  });

  console.log('[DocVex] Content script active. Shortcuts: Control+Shift+S or ⌘⇧S');
})();
