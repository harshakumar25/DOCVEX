let activeRequestId = null;
const queue = [];
let active = null;
let activeAudio = null;

const send = (message) => {
  try {
    const result = chrome.runtime.sendMessage({ action: 'AUDIO_PLAYBACK_EVENT', ...message });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // The playback owner may disconnect while a request is being replaced.
  }
};

const BACKEND_URL = 'http://127.0.0.1:3000';

const playNext = async () => {
  if (activeAudio || queue.length === 0) return;
  active = queue.shift();
  if (!active || (activeRequestId && active.requestId !== activeRequestId)) {
    playNext();
    return;
  }

  const current = active;
  console.log(`[DocVex Offscreen] Starting audio playback for sentence ${current.sentenceIndex}: "${current.sentence?.slice(0, 50)}..."`);

  let objectUrl = null;
  try {
    if (current.audioBuffer instanceof Blob) {
      objectUrl = URL.createObjectURL(current.audioBuffer);
    } else if (current.audioBuffer instanceof ArrayBuffer) {
      objectUrl = URL.createObjectURL(new Blob([current.audioBuffer], { type: 'audio/wav' }));
    } else if (current.audioBuffer && current.audioBuffer.buffer instanceof ArrayBuffer) {
      objectUrl = URL.createObjectURL(new Blob([current.audioBuffer.buffer], { type: 'audio/wav' }));
    } else if (current.fileName) {
      const extOrigin = chrome.runtime.getURL('').replace(/\/+$/, '');
      const response = await fetch(`${BACKEND_URL}/audio/${encodeURIComponent(current.fileName)}`, {
        headers: {
          Accept: 'audio/wav',
          'X-DocVex-Extension-Origin': extOrigin,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch audio from backend (${response.status})`);
      }
      const blob = await response.blob();
      console.log(`[DocVex Offscreen] Audio fetched successfully (${blob.size} bytes, type ${blob.type})`);
      objectUrl = URL.createObjectURL(blob);
    } else {
      throw new Error('No valid audio data or fileName provided');
    }
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
    playNext();
  };

  audio.onplay = () => {
    if (activeRequestId && current.requestId !== activeRequestId) {
      finish('stale');
      return;
    }
    console.log(`[DocVex Offscreen] Audio onplay event fired for sentence ${current.sentenceIndex}!`);
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
    playNext();
    return;
  }
  if (message.action === 'SET_ACTIVE_REQUEST') {
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
    activeAudio?.pause();
  } else if (message.action === 'RESUME_AUDIO') {
    activeAudio?.play().catch(() => {});
  } else if (message.action === 'STOP_AUDIO') {
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
