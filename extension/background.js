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

// Context Menu Trigger
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'docvex-teach-context-menu' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'TRIGGER_TEACH',
      selectedText: info.selectionText,
    });
  }
});

// Keyboard Shortcut Trigger (Command+Shift+S)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'teach-selection') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      chrome.tabs.sendMessage(activeTab.id, {
        action: 'TRIGGER_TEACH',
      });
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
      .catch((err) => {
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
      .catch((err) => {
        sendResponse({
          success: false,
          error: 'Cannot connect to DocVex backend on http://127.0.0.1:3000',
        });
      });

    return true;
  }
});
