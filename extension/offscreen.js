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

const playNext = () => {
  if (activeAudio || queue.length === 0) return;
  active = queue.shift();
  if (!active || active.requestId !== activeRequestId) {
    playNext();
    return;
  }

  const objectUrl = URL.createObjectURL(new Blob([active.audioBuffer], { type: 'audio/wav' }));
  const audio = new Audio(objectUrl);
  activeAudio = audio;

  const finish = (event) => {
    URL.revokeObjectURL(objectUrl);
    activeAudio = null;
    const completed = active;
    active = null;
    send({
      event,
      requestId: completed.requestId,
      sentence: completed.sentence,
      sentenceIndex: completed.sentenceIndex,
    });
    playNext();
  };

  audio.onplay = () => send({
    event: 'started',
    requestId: active.requestId,
    sentence: active.sentence,
    sentenceIndex: active.sentenceIndex,
  });
  audio.onended = () => finish('ended');
  audio.onerror = () => finish('error');
  audio.play().catch(() => finish('error'));
};

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'PLAY_AUDIO') {
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
    return;
  }
  if (message.action === 'PAUSE_AUDIO') {
    activeAudio?.pause();
  } else if (message.action === 'RESUME_AUDIO') {
    activeAudio?.play().catch(() => {});
  } else if (message.action === 'STOP_AUDIO') {
    queue.length = 0;
    activeAudio?.pause();
    activeAudio = null;
    active = null;
  }
});

let activeRequestId = null;
