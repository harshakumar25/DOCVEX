/**
 * DocVex — Popup Controller
 * Checks health of backend, Ollama, and Groq
 */

async function checkStatus() {
  const backendEl = document.getElementById('backend-status');
  const ollamaEl = document.getElementById('ollama-status');
  const modelEl = document.getElementById('model-status');
  const groqEl = document.getElementById('groq-status');

  backendEl.textContent = 'Checking...';
  backendEl.className = 'status-val';

  chrome.runtime.sendMessage({ action: 'CHECK_HEALTH' }, (response) => {
    if (!response || !response.success) {
      backendEl.textContent = 'Offline';
      backendEl.className = 'status-val indicator-offline';
      ollamaEl.textContent = 'Unknown';
      ollamaEl.className = 'status-val indicator-offline';
      modelEl.textContent = '—';
      groqEl.textContent = '—';
      return;
    }

    const data = response.data;
    backendEl.textContent = 'Connected';
    backendEl.className = 'status-val indicator-online';

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
      modelEl.textContent = `${data.ollama?.model || 'qwen3:4b'} (not running)`;
      modelEl.className = 'status-val indicator-offline';
    }

    if (data.groq?.configured) {
      groqEl.textContent = `Configured (${data.groq.model})`;
      groqEl.className = 'status-val indicator-online';
    } else {
      groqEl.textContent = 'Not configured';
      groqEl.className = 'status-val';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', checkStatus);
});
