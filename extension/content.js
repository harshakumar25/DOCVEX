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
  let chatterboxEnabled = false;
  let activeAudio = null;
  let chatterboxAudioQueue = [];
  let isChatterboxPlaying = false;
  let chatterboxObjectUrls = new Set();

  // Timing metrics
  let timingMetrics = {
    t0: 0, // shortcut pressed / trigger
    t4: 0, // first model token
    t5: 0, // first complete sentence emitted
    t6: 0, // speech synthesis started
    t7: 0, // full generation finished
  };

  // --- Text & Boundary Helpers ---
  const NON_TERMINATING_ABBREVIATIONS = new Set([
    'e.g', 'i.e', 'vs', 'etc', 'dr', 'mr', 'mrs', 'ms', 'prof', 'inc', 'ltd', 'co', 'approx', 'dept', 'fig', 'no', 'vol', 'al'
  ]);

  function isSafeUrl(urlString) {
    try {
      const parsed = new URL(urlString);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function shapeSpeechText(text) {
    if (!text || typeof text !== 'string') return '';
    let spoken = text;
    // Remove raw URLs
    spoken = spoken.replace(/https?:\/\/\S+/gi, '');
    // Remove markdown headers
    spoken = spoken.replace(/^#{1,6}\s+/gm, '');
    // Remove code blocks and inline backticks
    spoken = spoken.replace(/```[a-zA-Z]*\n?/g, '');
    spoken = spoken.replace(/`/g, '');
    // Remove bold / italics
    spoken = spoken.replace(/\*\*([^*]+)\*\*/g, '$1');
    spoken = spoken.replace(/\*([^*]+)\*/g, '$1');
    spoken = spoken.replace(/__([^_]+)__/g, '$1');
    spoken = spoken.replace(/_([^_]+)_/g, '$1');
    // Remove citation formatting [Source 1], [1], [link](url)
    spoken = spoken.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    spoken = spoken.replace(/\[(?:Source\s*)?\d+[^\]]*\]/gi, '');
    // Convert list bullets at start of line into natural pauses
    spoken = spoken.replace(/^[\*\-]\s+/gm, 'Also, ');
    // Normalize spaces and line breaks
    spoken = spoken.replace(/[ \t]+/g, ' ');
    spoken = spoken.replace(/\n\s*\n+/g, ' ');
    return spoken.trim();
  }

  function isFalseBoundary(text, punctuationIndex) {
    const char = text[punctuationIndex];

    if (char === '.') {
      const prevChar = text[punctuationIndex - 1];
      const nextChar = text[punctuationIndex + 1];

      // Decimal number (e.g. 3.14) or version (e.g. 1.2)
      if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
        return true;
      }

      // Ellipsis (...)
      if (prevChar === '.' || nextChar === '.') {
        return true;
      }

      // URL or domain suffix
      const surrounding = text.slice(Math.max(0, punctuationIndex - 15), Math.min(text.length, punctuationIndex + 15));
      if (/https?:\/\/|\.com|\.org|\.net|\.io|\.edu|\.gov/i.test(surrounding)) {
        return true;
      }

      // Preceding abbreviation word
      const preceding = text.slice(Math.max(0, punctuationIndex - 10), punctuationIndex);
      const lastWordMatch = preceding.match(/([a-zA-Z0-9\._]+)$/);
      if (lastWordMatch) {
        const candidate = lastWordMatch[1].toLowerCase().replace(/\.$/, '');
        if (NON_TERMINATING_ABBREVIATIONS.has(candidate)) {
          return true;
        }
      }
    }

    return false;
  }

  // --- SentenceBuffer Class ---
  class ClientSentenceBuffer {
    constructor({ onSentence, minSentenceLength = 10, maxUtteranceLength = 360 }) {
      this.buffer = '';
      this.onSentence = onSentence;
      this.minSentenceLength = minSentenceLength;
      this.maxUtteranceLength = maxUtteranceLength;
      this.sentenceIndex = 0;
    }

    addToken(token) {
      if (!token || typeof token !== 'string') return;
      this.buffer += token;
      this.process();
    }

    emitClamped(candidate) {
      const cleaned = shapeSpeechText(candidate);
      if (!cleaned || cleaned.length < this.minSentenceLength) return;

      if (cleaned.length <= this.maxUtteranceLength) {
        this.sentenceIndex++;
        this.onSentence(cleaned, this.sentenceIndex);
        return;
      }

      let remaining = cleaned;
      while (remaining.length > this.maxUtteranceLength) {
        const slice = remaining.slice(0, this.maxUtteranceLength);
        const match = slice.match(/.*([,;:—]|\s-\s)\s*/);
        let splitAt = -1;
        if (match && match[0].length >= this.minSentenceLength) {
          splitAt = match[0].length;
        } else {
          splitAt = slice.lastIndexOf(' ');
        }

        if (splitAt <= 0 || splitAt < this.minSentenceLength) {
          splitAt = this.maxUtteranceLength;
        }

        const part = remaining.slice(0, splitAt).trim();
        if (part.length > 0) {
          this.sentenceIndex++;
          this.onSentence(part, this.sentenceIndex);
        }
        remaining = remaining.slice(splitAt).trim();
      }

      if (remaining.length >= this.minSentenceLength) {
        this.sentenceIndex++;
        this.onSentence(remaining, this.sentenceIndex);
      }
    }

    process() {
      const boundaryRegex = /([.?!]+)(\s+|\n+|$)/g;
      let match;

      while ((match = boundaryRegex.exec(this.buffer)) !== null) {
        const punctIndex = match.index;
        const punctLength = match[1].length;
        const spaceLength = match[2].length;
        const splitIndex = punctIndex + punctLength + spaceLength;

        if (splitIndex >= this.buffer.length && spaceLength === 0) {
          break;
        }

        if (isFalseBoundary(this.buffer, punctIndex)) {
          continue;
        }

        const candidate = this.buffer.slice(0, splitIndex).trim();

        if (candidate.length >= this.minSentenceLength) {
          this.emitClamped(candidate);
          this.buffer = this.buffer.slice(splitIndex);
          boundaryRegex.lastIndex = 0;
        }
      }
    }

    flush() {
      const remaining = this.buffer.trim();
      if (remaining.length > 0) {
        this.emitClamped(remaining);
      }
      this.buffer = '';
    }

    reset() {
      this.buffer = '';
      this.sentenceIndex = 0;
    }
  }

  // --- HUD DOM Management ---
  function getOrCreateHUD() {
    if (hudContainer && shadowRoot) {
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
      }
      @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.5); opacity: 0.5; }
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
    `;

    shadowRoot.appendChild(style);
    document.body.appendChild(hudContainer);

    return { hudContainer, shadowRoot };
  }

  function closeHUD() {
    stopCurrentTeachingSession();
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
      stopCurrentTeachingSession();
      updateHUDStatus('Teaching stopped.');
    };

    controlsDiv.appendChild(playBtn);
    controlsDiv.appendChild(stopBtn);
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

  // Filter out harsh, robotic novelty voices and prioritize warm, natural human voices
  const NOVELTY_OR_ROBOTIC_VOICE_NAMES = new Set([
    'albert', 'alex', 'bad news', 'bahh', 'bells', 'boing', 'bubbles',
    'cellos', 'deranged', 'fred', 'good news', 'hysterical', 'jester',
    'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox', 'junior', 'ralph'
  ]);

  const PREFERRED_VOICE_NAMES = [
    'samantha', 'ava', 'daniel', 'oliver', 'serena', 'karen', 'moira', 'tessa',
    'natural', 'neural', 'premium', 'enhanced', 'google', 'siri'
  ];

  function selectBestSpeechVoice(voices) {
    if (!voices || voices.length === 0) return null;
    const qualityVoices = voices.filter((v) => {
      const lowerName = (v.name || '').toLowerCase();
      return !Array.from(NOVELTY_OR_ROBOTIC_VOICE_NAMES).some((bad) => lowerName === bad || lowerName.startsWith(`${bad} `) || lowerName.includes(` ${bad}`));
    });
    if (qualityVoices.length === 0) return null;

    const englishVoices = qualityVoices.filter((v) => v.lang && v.lang.startsWith('en'));
    const candidatePool = englishVoices.length > 0 ? englishVoices : qualityVoices;
    for (const preferred of PREFERRED_VOICE_NAMES) {
      const match = candidatePool.find((v) => (v.name || '').toLowerCase().includes(preferred));
      if (match) return match;
    }
    return candidatePool[0];
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
  function queueSpeechSentence(sentence, index, requestId) {
    if (!sentence || !('speechSynthesis' in window)) return;
    if (requestId !== activeRequestId) return; // Discard stale requests

    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.rate = 0.97;
    utterance.pitch = 1.0;

    const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
    const naturalVoice = selectBestSpeechVoice(voices);
    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    utterance.onstart = () => {
      if (requestId !== activeRequestId) {
        window.speechSynthesis.cancel();
        return;
      }

      if (index === 1 && timingMetrics.t6 === 0) {
        timingMetrics.t6 = performance.now();
        const latency = Math.round(timingMetrics.t6 - timingMetrics.t0);
        console.log(`[DocVex Timing] First Audible Speech (T0->T6): ${latency}ms`);
      }

      isSpeaking = true;
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking explanation…');

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

      if (activeUtterances.length === 0 && !window.speechSynthesis.speaking) {
        isSpeaking = false;
        isPaused = false;
        clearInterval(speechKeepAliveInterval);
        speechKeepAliveInterval = null;
        updatePlayButtonState();
        updateHUDStatus('Finished speaking.');
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
        isSpeaking = false;
        isPaused = false;
        clearInterval(speechKeepAliveInterval);
        speechKeepAliveInterval = null;
        updatePlayButtonState();
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
    };

    const finish = () => {
      isChatterboxPlaying = false;
      activeAudio = null;
      URL.revokeObjectURL(objectUrl);
      chatterboxObjectUrls.delete(objectUrl);
      if (item.requestId === activeRequestId) {
        playNextChatterboxAudio();
        if (!isChatterboxPlaying && chatterboxAudioQueue.length === 0) {
          isSpeaking = false;
          isPaused = false;
          updatePlayButtonState();
          updateHUDStatus('Finished speaking.');
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
    if (chatterboxEnabled && activePort && isPaused) {
      activePort.postMessage({ action: 'RESUME_AUDIO' });
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking with local Chatterbox…');
      return;
    }
    if (activeAudio && isPaused) {
      activeAudio.play().catch(() => {});
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking with local Chatterbox…');
      return;
    }
    if (window.speechSynthesis && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      isPaused = false;
      updatePlayButtonState();
      updateHUDStatus('🔊 Speaking explanation…');
    }
  }

  function stopSpeech() {
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
    stopSpeech();
    const sentences = fullText.match(/[^.!?]+[.!?]+(\s|$)/g) || [fullText];
    const currentReq = activeRequestId || 'local_replay';
    sentences.forEach((s, idx) => {
      const cleaned = shapeSpeechText(s);
      if (cleaned) {
        queueSpeechSentence(cleaned, idx + 1, currentReq);
      }
    });
  }

  function stopCurrentTeachingSession() {
    stopSpeech();
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
    chatterboxEnabled = false;
    updatePlayButtonState();
  }

  // --- Main Teaching Flow ---
  let lastTriggerTime = 0;

  function triggerTeaching(selectionOverride = null) {
    const now = performance.now();
    if (now - lastTriggerTime < 500) {
      return;
    }
    lastTriggerTime = now;

    const selectedText = (selectionOverride || window.getSelection().toString()).trim();

    if (!selectedText) {
      renderHUDSkeleton({
        status: 'No text selected',
        error: 'Select some text on the webpage first, then press Ctrl+Shift+S.',
      });
      return;
    }

    // 1. Invalidate any existing session and stop active speech immediately
    stopCurrentTeachingSession();

    // 2. Setup new session ID & timing
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    activeRequestId = requestId;

    timingMetrics = {
      t0: performance.now(),
      t4: 0,
      t5: 0,
      t6: 0,
      t7: 0,
    };

    renderHUDSkeleton({
      status: 'Understanding selected text…',
    });

    let accumulatedText = '';
    currentSpeechText = '';

    // 3. Initialize SentenceBuffer for this session
    const sentenceBuffer = new ClientSentenceBuffer({
      minSentenceLength: 10,
      onSentence: (sentence, index) => {
        if (requestId !== activeRequestId) return;

        if (index === 1 && timingMetrics.t5 === 0) {
          timingMetrics.t5 = performance.now();
          const latencyT5 = Math.round(timingMetrics.t5 - timingMetrics.t0);
          console.log(`[DocVex Timing] First Complete Sentence (T0->T5): ${latencyT5}ms: "${sentence}"`);
        }

        // Chatterbox audio arrives through the background worker; use browser speech only as fallback.
        if (!chatterboxEnabled) {
          queueSpeechSentence(sentence, index, requestId);
        }
      },
    });

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
          if (data.groundingStatus) {
            updateHUDBadge(data.groundingStatus);
          }
          if (data.groundingStatus === 'grounded' && Array.isArray(data.sources)) {
            renderHUDSources(data.sources);
          }
          if (data.isHybrid) {
            showHUDInsightsShimmer();
          }
        } else if (event === 'token') {
          if (timingMetrics.t4 === 0) {
            timingMetrics.t4 = performance.now();
            const latencyT4 = Math.round(timingMetrics.t4 - timingMetrics.t0);
            console.log(`[DocVex Timing] First Token (T0->T4): ${latencyT4}ms`);
          }

          accumulatedText += data.token;
          currentSpeechText = accumulatedText;
          updateHUDExplanation(accumulatedText);
          sentenceBuffer.addToken(data.token);
        } else if (event === 'speech_done') {
          // Voice explanation stream finished; flush speech buffer so all sentences play cleanly
          sentenceBuffer.flush();
          if (data.explanation) {
            currentSpeechText = data.explanation;
            updateHUDExplanation(data.explanation);
          }
        } else if (event === 'local_insights') {
          // Background Ollama deep-dive reasoning completed
          if (data.insights) {
            renderHUDInsights(data.insights);
          }
        } else if (event === 'audio_error') {
          console.error('[DocVex audio_error event]', data);
          if (data.sentence && data.requestId === activeRequestId) {
            queueSpeechSentence(data.sentence, data.sentenceIndex, data.requestId);
            updateHUDStatus('Local Chatterbox audio failed; using browser speech fallback.');
          }
        } else if (event === 'done') {
          timingMetrics.t7 = performance.now();
          const latencyT7 = Math.round(timingMetrics.t7 - timingMetrics.t0);
          console.log(`[DocVex Timing] Full Generation Finished (T0->T7): ${latencyT7}ms`);

          // Flush any remaining characters in the sentence buffer
          sentenceBuffer.flush();

          if (data.groundingStatus) {
            updateHUDBadge(data.groundingStatus);
          }

          if (data.explanation) {
            currentSpeechText = data.explanation;
            updateHUDExplanation(data.explanation);
          }

          if (data.insights) {
            renderHUDInsights(data.insights);
          }

          if (data.groundingStatus === 'grounded' && Array.isArray(data.sources)) {
            renderHUDSources(data.sources);
          }

          if (!chatterboxEnabled && !isSpeaking) {
            updateHUDStatus('Explanation complete.');
          } else if (chatterboxEnabled && !isSpeaking) {
            updateHUDStatus('🎙️ Synthesizing voice with Chatterbox…');
          }
        } else if (event === 'error') {
          renderHUDSkeleton({
            status: 'Error',
            error: data.error || 'Server error occurred during streaming.',
          });
        }
      } else if (msg.action === 'AUDIO_PLAYBACK') {
        const data = msg.data || {};
        if (msg.requestId !== activeRequestId) return;
        if (msg.event === 'started') {
          if (timingMetrics.t6 === 0) {
            timingMetrics.t6 = performance.now();
            console.log(`[DocVex Timing] Chatterbox Playback Started (T0->T6): ${Math.round(timingMetrics.t6 - timingMetrics.t0)}ms`);
          }
          isSpeaking = true;
          isPaused = false;
          updatePlayButtonState();
          updateHUDStatus(`🔊 Speaking with local Chatterbox… (sentence ${data.sentenceIndex || 1})`);
        } else if (msg.event === 'ended') {
          if (data.hasMore) {
            updateHUDStatus('🔊 Speaking with local Chatterbox…');
          } else {
            isSpeaking = false;
            isPaused = false;
            updatePlayButtonState();
            updateHUDStatus('Explanation complete.');
          }
        } else if (msg.event === 'error') {
          queueSpeechSentence(data.sentence, data.sentenceIndex, msg.requestId);
          updateHUDStatus('Local Chatterbox audio failed; using browser speech fallback.');
        }
      } else if (msg.action === 'AUDIO_ERROR') {
        const data = msg.data || {};
        if (data.sentence && msg.requestId === activeRequestId) {
          queueSpeechSentence(data.sentence, data.sentenceIndex, msg.requestId);
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
        text: selectedText,
        title: document.title || '',
        url: window.location.href || '',
        pageContext: extractSurroundingContext(),
        ...(preferredProvider ? { provider: preferredProvider } : {}),
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
      if (!text || text.length < 5) {
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
