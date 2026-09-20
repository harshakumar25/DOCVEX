/**
 * DocVex Chrome Extension — Background Service Worker
 * - Handles Command + Shift + S keyboard shortcut.
 * - Handles context menu click.
 * - Proxies requests to local backend (http://127.0.0.1:3000) to bypass webpage CSP policies.
 */

const BACKEND_URL = 'http://127.0.0.1:3000';

// Register Context Menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'docvex-teach-context-menu',
    title: '🎓 Teach me this',
    contexts: ['selection'],
  });
});

// Helper to reliably dispatch TRIGGER_TEACH to tab with dynamic injection fallback
async function sendTeachToTab(tabId, selectedText = null) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'TRIGGER_TEACH',
      selectedText,
    });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, {
          action: 'TRIGGER_TEACH',
          selectedText,
        }).catch(() => {});
      }, 100);
    } catch {
      // Tab might be restricted browser page
    }
  }
}

// Context Menu Trigger
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'docvex-teach-context-menu' && tab?.id) {
    sendTeachToTab(tab.id, info.selectionText);
  }
});

// Keyboard Shortcut Trigger
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'teach-selection') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      sendTeachToTab(activeTab.id);
    }
  }
});

// Proxy network requests from content scripts and popup to local backend
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'TEACH_REQUEST') {
    fetch(`${BACKEND_URL}/teach`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.payload),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({
            success: false,
            error: data.error || `Server error (${res.status})`,
          });
        } else {
          sendResponse({
            success: true,
            data,
          });
        }
      })
      .catch(() => {
        sendResponse({
          success: false,
          error:
            'DocVex backend is not running. Please start the local server with `npm start` in the DOCVEX directory.',
        });
      });

    return true; // Keep message channel open for async response
  }

  if (request.action === 'CHECK_HEALTH') {
    fetch(`${BACKEND_URL}/health`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        sendResponse({ success: res.ok, data });
      })
      .catch(() => {
        sendResponse({
          success: false,
          error: 'Cannot connect to DocVex backend on http://127.0.0.1:3000',
        });
      });

    return true;
  }
});

// Proxy streaming SSE connections between content script and backend
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'docvex-stream') return;

  let abortController = null;
  let isPortConnected = true;

  const safePostMessage = (msg) => {
    if (!isPortConnected) return;
    try {
      port.postMessage(msg);
    } catch {
      isPortConnected = false;
      if (abortController) {
        abortController.abort();
      }
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'START_STREAM') {
      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();
      const { requestId, payload } = msg;

      try {
        const response = await fetch(`${BACKEND_URL}/teach`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...payload, stream: true, requestId }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          safePostMessage({
            action: 'STREAM_ERROR',
            requestId,
            error: errData.error || `Server error (${response.status})`,
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (isPortConnected) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            const lines = part.split('\n');
            let event = 'message';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                event = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataStr = line.slice(6).trim();
              }
            }

            if (dataStr) {
              try {
                const parsed = JSON.parse(dataStr);
                safePostMessage({
                  action: 'STREAM_EVENT',
                  event,
                  data: parsed,
                  requestId,
                });
              } catch {
                // Ignore parse errors on partial or invalid chunks
              }
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          return;
        }
        safePostMessage({
          action: 'STREAM_ERROR',
          requestId,
          error:
            'DocVex backend is not running or connection was interrupted. Please start the server with `npm start`.',
        });
      }
    } else if (msg.action === 'ABORT_STREAM') {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    isPortConnected = false;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  });
});
