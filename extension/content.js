/**
 * DocVex — Content Script
 * - Captures user selection and webpage context
 * - Injects isolated Shadow DOM HUD floating tutor
 * - Controls speech synthesis (Play, Pause, Stop)
 */

(() => {
  // Prevent duplicate script execution
  if (window.__DOCVEX_INITIALIZED__) return;
  window.__DOCVEX_INITIALIZED__ = true;

  // State
  let hudContainer = null;
  let shadowRoot = null;
  let currentUtterance = null;
  let isSpeaking = false;
  let isPaused = false;
  let currentSpeechText = '';

  // Ensure Shadow DOM container exists
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

    // Styles isolated inside Shadow DOM
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
      .btn-secondary {
        background: #1e293b;
        color: #cbd5e1;
        border: 1px solid #334155;
      }
      .btn-secondary:hover {
        background: #334155;
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
    `;

    shadowRoot.appendChild(style);
    document.body.appendChild(hudContainer);

    return { hudContainer, shadowRoot };
  }

  // Close / remove HUD
  function closeHUD() {
    stopSpeech();
    if (hudContainer && hudContainer.parentNode) {
      hudContainer.parentNode.removeChild(hudContainer);
      hudContainer = null;
      shadowRoot = null;
    }
  }

  // Render HUD content
  function renderHUD({ status, statusType = 'info', explanation = '', sources = [], error = null }) {
    const { shadowRoot } = getOrCreateHUD();

    let existingCard = shadowRoot.querySelector('.hud-card');
    if (!existingCard) {
      existingCard = document.createElement('div');
      existingCard.className = 'hud-card';
      shadowRoot.appendChild(existingCard);
    }

    let sourcesHtml = '';
    if (sources && sources.length > 0) {
      sourcesHtml = `
        <div class="sources-list">
          <strong>Verified Sources:</strong><br>
          ${sources
            .map(
              (s) =>
                `<a class="source-link" href="${s.url || '#'}" target="_blank" rel="noopener noreferrer">${
                  s.domain || s.title || 'Official Source'
                }</a>`
            )
            .join('')}
        </div>
      `;
    }

    let errorHtml = error ? `<div class="error-msg">${error}</div>` : '';

    let controlsHtml = '';
    if (explanation) {
      controlsHtml = `
        <div class="hud-controls">
          <button id="docvex-btn-play" class="btn btn-primary">${isSpeaking && !isPaused ? '⏸ Pause' : '▶ Play'}</button>
          <button id="docvex-btn-stop" class="btn btn-danger">⏹ Stop</button>
        </div>
      `;
    }

    existingCard.innerHTML = `
      <div class="hud-header">
        <div class="hud-title">
          <span>🎓 DocVex</span>
          <span class="hud-badge">Local Tutor</span>
        </div>
        <button id="docvex-btn-close" class="hud-close" title="Close">✕</button>
      </div>
      <div class="hud-status">
        <span class="status-pulse"></span>
        <span>${status}</span>
      </div>
      ${errorHtml}
      ${explanation ? `<div class="hud-content">${explanation}</div>` : ''}
      ${controlsHtml}
      ${sourcesHtml}
    `;

    // Bind event listeners
    const closeBtn = existingCard.querySelector('#docvex-btn-close');
    if (closeBtn) closeBtn.onclick = closeHUD;

    const playBtn = existingCard.querySelector('#docvex-btn-play');
    if (playBtn) {
      playBtn.onclick = () => {
        if (isSpeaking && !isPaused) {
          pauseSpeech();
          playBtn.innerText = '▶ Resume';
        } else if (isPaused) {
          resumeSpeech();
          playBtn.innerText = '⏸ Pause';
        } else {
          startSpeech(currentSpeechText);
          playBtn.innerText = '⏸ Pause';
        }
      };
    }

    const stopBtn = existingCard.querySelector('#docvex-btn-stop');
    if (stopBtn) {
      stopBtn.onclick = () => {
        stopSpeech();
        if (playBtn) playBtn.innerText = '▶ Play';
      };
    }
  }

  // --- Speech Synthesis Engine ---
  let speechKeepAliveInterval = null;

  function startSpeech(text) {
    if (!text || !('speechSynthesis' in window)) return;

    stopSpeech();

    currentSpeechText = text;
    currentUtterance = new SpeechSynthesisUtterance(text);
    currentUtterance.rate = 1.0;
    currentUtterance.pitch = 1.0;

    // Pick a natural English voice if available
    const voices = window.speechSynthesis.getVoices();
    const englishVoice =
      voices.find((v) => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Siri') || v.name.includes('Google'))) ||
      voices.find((v) => v.lang.startsWith('en'));
    if (englishVoice) {
      currentUtterance.voice = englishVoice;
    }

    currentUtterance.onstart = () => {
      isSpeaking = true;
      isPaused = false;
      renderHUD({
        status: '🔊 Speaking explanation...',
        explanation: currentSpeechText,
      });

      // Keepalive for Chrome's 15-second speech synthesis pause bug
      clearInterval(speechKeepAliveInterval);
      speechKeepAliveInterval = setInterval(() => {
        if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 10000);
    };

    currentUtterance.onend = () => {
      isSpeaking = false;
      isPaused = false;
      clearInterval(speechKeepAliveInterval);
      renderHUD({
        status: 'Finished speaking',
        explanation: currentSpeechText,
      });
    };

    currentUtterance.onerror = (e) => {
      isSpeaking = false;
      isPaused = false;
      clearInterval(speechKeepAliveInterval);
      if (e.error !== 'canceled') {
        renderHUD({
          status: 'Speech error',
          explanation: currentSpeechText,
          error: `Audio playback notice: ${e.error || 'Speech synthesis was interrupted.'}`,
        });
      }
    };

    window.speechSynthesis.speak(currentUtterance);
  }

  function pauseSpeech() {
    if (window.speechSynthesis && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      isPaused = true;
      renderHUD({
        status: '⏸ Audio paused',
        explanation: currentSpeechText,
      });
    }
  }

  function resumeSpeech() {
    if (window.speechSynthesis && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      isPaused = false;
      renderHUD({
        status: '🔊 Speaking explanation...',
        explanation: currentSpeechText,
      });
    }
  }

  function stopSpeech() {
    clearInterval(speechKeepAliveInterval);
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    isSpeaking = false;
    isPaused = false;
    currentUtterance = null;
  }

  // --- Main Teaching Flow Triggered by Shortcut or Context Menu ---
  async function triggerTeaching(selectionOverride = null) {
    const selectedText = selectionOverride || window.getSelection().toString().trim();

    if (!selectedText) {
      renderHUD({
        status: 'No text selected',
        error: 'Select some text on the webpage first, then press ⌘⇧S.',
      });
      return;
    }

    renderHUD({
      status: 'Understanding selected text…',
    });

    const payload = {
      text: selectedText,
      title: document.title || '',
      url: window.location.href || '',
    };

    // Send to background service worker
    chrome.runtime.sendMessage(
      { action: 'TEACH_REQUEST', payload },
      (response) => {
        if (!response || !response.success) {
          renderHUD({
            status: 'Error',
            error: response?.error || 'Could not connect to DocVex backend. Start Ollama and local server.',
          });
          return;
        }

        const { explanation, speechFriendly, sources } = response.data;

        renderHUD({
          status: '🔊 Teaching concept…',
          explanation,
          sources,
        });

        // Start speaking speech-optimized text
        startSpeech(speechFriendly || explanation);
      }
    );
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'TRIGGER_TEACH') {
      triggerTeaching(request.selectedText);
    }
  });
})();
