/**
 * DocVex — Popup Controller
 * Manages provider selection, connection health, and shortcut hints
 */

const HINTS = {
  hybrid: '⚡ Instant speech in ~595ms with Groq + Ollama computes deep-dive gotchas in background!',
  groq: '⚡ First sentence spoken in ~595ms with Groq streaming cloud.',
  ollama: '🔒 100% offline & private with Ollama (takes ~30s on CPU due to reasoning tokens).',
};

async function checkStatus() {
  const backendEl = document.getElementById('backend-status');
  const groqEl = document.getElementById('groq-status');
  const ollamaEl = document.getElementById('ollama-status');
  const modelEl = document.getElementById('model-status');

  backendEl.textContent = 'Checking...';
  backendEl.className = 'status-val';

  chrome.runtime.sendMessage({ action: 'CHECK_HEALTH' }, (response) => {
    if (!response || !response.success) {
      backendEl.textContent = 'Offline';
      backendEl.className = 'status-val indicator-offline';
      groqEl.textContent = '—';
      groqEl.className = 'status-val';
      ollamaEl.textContent = 'Offline';
      ollamaEl.className = 'status-val indicator-offline';
      modelEl.textContent = '—';
      return;
    }

    const data = response.data;
    backendEl.textContent = 'Connected';
    backendEl.className = 'status-val indicator-online';

    if (data.groq?.configured) {
      groqEl.textContent = `Online (${data.groq.model})`;
      groqEl.className = 'status-val indicator-online';
    } else {
      groqEl.textContent = 'Not configured';
      groqEl.className = 'status-val';
    }

    if (data.ollama?.running) {
      ollamaEl.textContent = 'Online';
      ollamaEl.className = 'status-val indicator-online';

      if (data.ollama.modelAvailable) {
        modelEl.textContent = data.ollama.model;
        modelEl.className = 'status-val indicator-online';
      } else {
        modelEl.textContent = `${data.ollama.model} (not pulled)`;
        modelEl.className = 'status-val indicator-offline';
      }
    } else {
      ollamaEl.textContent = 'Offline';
      ollamaEl.className = 'status-val indicator-offline';
      modelEl.textContent = `${data.ollama?.model || 'qwen3:4b'} (offline)`;
      modelEl.className = 'status-val indicator-offline';
    }
  });
}

function initProviderSelect() {
  const select = document.getElementById('provider-select');
  const hint = document.getElementById('provider-hint');
  if (!select || !hint) return;

  chrome.storage.local.get(['docvexProvider'], (result) => {
    const activeProvider = result?.docvexProvider || 'hybrid';
    select.value = activeProvider;
    hint.textContent = HINTS[activeProvider] || '';
  });

  select.addEventListener('change', () => {
    const val = select.value;
    chrome.storage.local.set({ docvexProvider: val });
    hint.textContent = HINTS[val] || '';
  });
}

function initShortcutLabel() {
  const shortcutDisplay = document.getElementById('shortcut-display');
  if (!shortcutDisplay) return;
  shortcutDisplay.textContent = 'Control + Shift + S';
}

document.addEventListener('DOMContentLoaded', () => {
  initProviderSelect();
  initShortcutLabel();
  checkStatus();
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', checkStatus);
});

