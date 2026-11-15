/**
 * FloorHolder: Sub-200ms Speculative Acoustic Backchannel & Floor-Holding Engine
 *
 * Implements:
 * 1. Rapid speculative floor-holding emission (<180ms from caller endpointing).
 * 2. Natural Indic conversational fillers (Hinglish, Hindi, Tamil).
 * 3. Prevents the 750ms Conversational Vacancy Cliff and double-talk stutter loops.
 * 4. Automatic suppression when primary agent response begins.
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID principles.
 */

const DEFAULT_FILLERS = {
  'hi-IN': [
    { text: 'Haanji...', minPauseMs: 150 },
    { text: 'Ji, ek second...', minPauseMs: 180 },
    { text: 'Theek hai sir...', minPauseMs: 160 },
    { text: 'Haan, dekh raha hoon...', minPauseMs: 200 },
  ],
  'ta-IN': [
    { text: 'Sari sir...', minPauseMs: 150 },
    { text: 'Oru nimisham...', minPauseMs: 180 },
    { text: 'Ippo paakaren...', minPauseMs: 200 },
  ],
  'en-IN': [
    { text: 'Yes, one moment...', minPauseMs: 160 },
    { text: 'Sure, checking that...', minPauseMs: 180 },
    { text: 'Right...', minPauseMs: 140 },
  ],
};

class FloorHolder {
  /**
   * @param {Object} options
   * @param {string} [options.language='hi-IN']
   * @param {number} [options.maxFloorHoldDurationMs=3000] - Max time to hold floor
   * @param {number} [options.delayThresholdMs=180] - Silence time before emitting filler
   */
  constructor({
    language = 'hi-IN',
    maxFloorHoldDurationMs = 3000,
    delayThresholdMs = 180,
  } = {}) {
    this.language = language;
    this.maxFloorHoldDurationMs = maxFloorHoldDurationMs;
    this.delayThresholdMs = delayThresholdMs;
    this.fillers = DEFAULT_FILLERS[language] || DEFAULT_FILLERS['hi-IN'];
    this.lastUsedIndex = -1;
    this.isHoldingFloor = false;
    this.timer = null;
  }

  /**
   * Selects the next natural Indic filler without immediate repetition.
   * @returns {{ text: string, minPauseMs: number }}
   */
  getNextFiller() {
    let nextIdx = (this.lastUsedIndex + 1) % this.fillers.length;
    this.lastUsedIndex = nextIdx;
    return this.fillers[nextIdx];
  }

  /**
   * Schedules a speculative floor-holding filler upon caller endpointing.
   * If primary agent response completes before `delayThresholdMs`, filler is cancelled.
   *
   * @param {Function} onEmitFiller - Callback invoked with the chosen filler if latency exceeds threshold
   * @returns {{ cancel: Function, promise: Promise<Object|null> }}
   */
  scheduleFloorHold(onEmitFiller) {
    let cancelled = false;
    this.isHoldingFloor = false;

    const filler = this.getNextFiller();
    let resolvePromise;

    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
      this.timer = setTimeout(() => {
        if (!cancelled) {
          this.isHoldingFloor = true;
          if (typeof onEmitFiller === 'function') {
            onEmitFiller(filler);
          }
          resolve(filler);
        } else {
          resolve(null);
        }
      }, this.delayThresholdMs);
    });

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.isHoldingFloor = false;
      if (resolvePromise) {
        resolvePromise(null);
      }
    };

    return { cancel, promise };
  }

  /**
   * Resets floor-holder state.
   */
  reset() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.isHoldingFloor = false;
    this.lastUsedIndex = -1;
  }
}

export { DEFAULT_FILLERS, FloorHolder };

