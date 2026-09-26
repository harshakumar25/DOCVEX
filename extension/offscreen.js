let activeRequestId = null;
const queue = [];
let active = null;
let activeAudio = null;
let pauseTimer = null;
// Prefetch cache: sentenceIndex -> { objectUrl, promise }
const prefetchCache = new Map();

const send = (message) => {
  try {
    const result = chrome.runtime.sendMessage({ action: 'AUDIO_PLAYBACK_EVENT', ...message });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // The playback owner may disconnect while a request is being replaced.
  }
};

const BACKEND_URL = 'http://127.0.0.1:3000';

/**
 * Fetch audio for an item and return a blob objectURL.
 * Stores the result in prefetchCache keyed by sentenceIndex so subsequent calls resolve instantly.
 */
const prefetchAudio = (item) => {
  const key = `${item.requestId}-${item.sentenceIndex}`;
  if (prefetchCache.has(key)) return prefetchCache.get(key);

  const promise = (async () => {
    if (item.audioBuffer instanceof Blob) {
      return URL.createObjectURL(item.audioBuffer);
    } else if (item.audioBuffer instanceof ArrayBuffer) {
      return URL.createObjectURL(new Blob([item.audioBuffer], { type: 'audio/wav' }));
    } else if (item.audioBuffer && item.audioBuffer.buffer instanceof ArrayBuffer) {
      return URL.createObjectURL(new Blob([item.audioBuffer.buffer], { type: 'audio/wav' }));
    } else if (item.fileName) {
      const extOrigin = chrome.runtime.getURL('').replace(/\/+$/, '');
      const response = await fetch(`${BACKEND_URL}/audio/${encodeURIComponent(item.fileName)}`, {
        headers: {
          Accept: 'audio/wav',
          'X-DocVex-Extension-Origin': extOrigin,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch audio from backend (${response.status})`);
      }
      const blob = await response.blob();
      console.log(`[DocVex Offscreen] Prefetch done for sentence ${item.sentenceIndex} (${blob.size} bytes)`);
      return URL.createObjectURL(blob);
    } else {
      throw new Error('No valid audio data or fileName provided');
    }
  })();

  prefetchCache.set(key, promise);
  return promise;
};

/** Revoke and remove a prefetch entry */
const releasePrefetch = (item) => {
  const key = `${item.requestId}-${item.sentenceIndex}`;
  prefetchCache.delete(key);
};

/** Kick off prefetch for the next item in the queue without awaiting. */
const prefetchNext = () => {
  if (queue.length === 0) return;
  const next = queue[0];
  if (next && (!activeRequestId || next.requestId === activeRequestId)) {
    prefetchAudio(next).catch(() => {});
  }
};

const playNext = async () => {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  if (activeAudio || queue.length === 0) return;
  active = queue.shift();
  if (!active || (activeRequestId && active.requestId !== activeRequestId)) {
    releasePrefetch(active);
    playNext();
    return;
  }

  const current = active;
  console.log(`[DocVex Offscreen] Playing sentence ${current.sentenceIndex}: "${current.sentence?.slice(0, 50)}..."`);

  // Kick off prefetch for the next item immediately
  prefetchNext();

  let objectUrl = null;
  try {
    objectUrl = await prefetchAudio(current);
    releasePrefetch(current);
  } catch (err) {
    console.error(`[DocVex Offscreen] Audio preparation error:`, err);
    send({
      event: 'error',
      requestId: current.requestId,
      sentence: current.sentence,
      sentenceIndex: current.sentenceIndex,
      error: err.message,
    });
    active = null;
    playNext();
    return;
  }

  const audio = new Audio(objectUrl);
  activeAudio = audio;

  let finished = false;
  const finish = (event) => {
    if (finished) return;
    finished = true;
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {}
    if (activeAudio === audio) {
      activeAudio = null;
    }
    if (active === current) {
      active = null;
    }
    console.log(`[DocVex Offscreen] Playback ${event} for sentence ${current.sentenceIndex}`);
    send({
      event,
      requestId: current.requestId,
      sentence: current.sentence,
      sentenceIndex: current.sentenceIndex,
      hasMore: queue.length > 0,
    });

    // Smart gap: paragraph break = 1000ms pause, intra-paragraph = play immediately
    const pauseMs = (event === 'ended' && typeof current.pauseAfterMs === 'number')
      ? current.pauseAfterMs
      : 0;

    if (pauseMs > 0) {
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        playNext();
      }, pauseMs);
    } else {
      playNext();
    }
  };

  audio.onplay = () => {
    if (activeRequestId && current.requestId !== activeRequestId) {
      finish('stale');
      return;
    }
    console.log(`[DocVex Offscreen] Audio onplay for sentence ${current.sentenceIndex}`);
    send({
      event: 'started',
      requestId: current.requestId,
      sentence: current.sentence,
      sentenceIndex: current.sentenceIndex,
      hasMore: queue.length > 0,
    });
  };

  audio.onended = () => finish('ended');
  audio.onerror = (e) => {
    console.error(`[DocVex Offscreen] Audio element error:`, e);
    finish('error');
  };

  audio.play().catch((err) => {
    console.error('[DocVex Offscreen] audio.play() failed:', err);
    finish('error');
  });
};

chrome.runtime.onMessage.addListener((message) => {
  console.log(`[DocVex Offscreen] Message received: ${message.action}`, message.requestId);

  if (message.action === 'PLAY_AUDIO') {
    if (!activeRequestId) {
      activeRequestId = message.requestId;
    }
    if (activeRequestId && message.requestId !== activeRequestId) {
      console.warn(`[DocVex Offscreen] Dropping stale PLAY_AUDIO: ${message.requestId} !== ${activeRequestId}`);
      return;
    }
    queue.push(message);
    // Prefetch this item immediately if idle, otherwise it'll be prefetched when current finishes
    if (!activeAudio) {
      playNext();
    } else {
      // Current audio is playing — start prefetching the newly arrived item if it's next
      prefetchNext();
    }
    return;
  }
  if (message.action === 'SET_ACTIVE_REQUEST') {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    // Clear prefetch cache for old request
    for (const key of prefetchCache.keys()) {
      if (!key.startsWith(message.requestId)) {
        prefetchCache.delete(key);
      }
    }
    queue.length = 0;
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
    active = null;
    activeRequestId = message.requestId;
    console.log(`[DocVex Offscreen] Active request set to: ${activeRequestId}`);
    return;
  }
  if (message.action === 'PAUSE_AUDIO') {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    activeAudio?.pause();
  } else if (message.action === 'RESUME_AUDIO') {
    if (activeAudio) {
      activeAudio.play().catch(() => {});
    } else if (queue.length > 0) {
      playNext();
    }
  } else if (message.action === 'STOP_AUDIO') {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    prefetchCache.clear();
    queue.length = 0;
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
    active = null;
    console.log('[DocVex Offscreen] Audio stopped.');
  }
});

console.log('[DocVex Offscreen] Offscreen playback context ready.');
