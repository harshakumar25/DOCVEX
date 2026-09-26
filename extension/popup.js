/**
 * DocVex — Popup Controller
 * Manages provider selection, backend port, Docy mic status, debug toggle, and connection health
 */

const HINTS = {
  hybrid: '⚡ Instant speech in ~595ms with Groq + Ollama computes deep-dive gotchas in background!',
  groq: '⚡ First sentence spoken in ~595ms with Groq streaming cloud.',
  ollama: '🔒 100% offline & private with Ollama (takes ~30s on CPU due to reasoning tokens).',
};

let backendPort = 3000;

async function checkStatus() {
  const backendEl = document.getElementById('backend-status');
  const groqEl = document.getElementById('groq-status');
  const ollamaEl = document.getElementById('ollama-status');
  const modelEl = document.getElementById('model-status');

  backendEl.textContent = 'Checking...';
  backendEl.className = 'status-val';

  chrome.runtime.sendMessage({ action: 'CHECK_HEALTH', port: backendPort }, (response) => {
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

function initPortInput() {
  const portInput = document.getElementById('port-input');
  const portSaveBtn = document.getElementById('port-save-btn');
  const backendPortLabel = document.getElementById('backend-port-label');
  if (!portInput || !portSaveBtn) return;

  // Load saved port
  chrome.storage.local.get(['docvexBackendPort'], (result) => {
    backendPort = result?.docvexBackendPort || 3000;
    portInput.value = backendPort;
    if (backendPortLabel) backendPortLabel.textContent = `Backend (Port ${backendPort}):`;
  });

  portSaveBtn.addEventListener('click', () => {
    const parsed = parseInt(portInput.value, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      portInput.style.borderColor = '#f87171';
      setTimeout(() => { portInput.style.borderColor = ''; }, 1500);
      return;
    }
    backendPort = parsed;
    chrome.storage.local.set({ docvexBackendPort: parsed });
    if (backendPortLabel) backendPortLabel.textContent = `Backend (Port ${parsed}):`;

    portSaveBtn.textContent = '✓ Saved';
    portSaveBtn.classList.add('saved');
    setTimeout(() => {
      portSaveBtn.textContent = 'Save';
      portSaveBtn.classList.remove('saved');
    }, 1800);

    // Re-check health with the new port
    checkStatus();
  });
}

function initDocyMicStatus() {
  const docyMicEl = document.getElementById('docy-mic-status');
  if (!docyMicEl) return;

  chrome.storage.local.get(['docvexMicEnabled'], (result) => {
    if (result?.docvexMicEnabled) {
      docyMicEl.textContent = '🎙️ Active';
      docyMicEl.className = 'status-val indicator-mic';
    } else {
      docyMicEl.textContent = 'Not enabled';
      docyMicEl.className = 'status-val indicator-mic-off';
    }
  });
}

function initDebugToggle() {
  const toggle = document.getElementById('debug-toggle');
  if (!toggle) return;

  chrome.storage.local.get(['docvexDebug'], (result) => {
    toggle.checked = Boolean(result?.docvexDebug);
  });

  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ docvexDebug: toggle.checked });
  });
}

function initShortcutLabel() {
  const shortcutDisplay = document.getElementById('shortcut-display');
  if (!shortcutDisplay) return;
  shortcutDisplay.textContent = 'Control + Shift + S';
}

document.addEventListener('DOMContentLoaded', () => {
  initProviderSelect();
  initPortInput();
  initDocyMicStatus();
  initDebugToggle();
  initShortcutLabel();
  checkStatus();
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', checkStatus);
});
