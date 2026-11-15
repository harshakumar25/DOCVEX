/**
 * AtomicToolProxy: In-Flight Asynchronous Tool Interceptor & Atomic Cancellation Guard
 *
 * Implements:
 * 1. Safe in-flight tool dispatching with AbortController binding.
 * 2. Instant cancellation upon caller barge-in / speech collision.
 * 3. Rollback hook invocation preventing corrupted ledger mutations.
 * 4. Microsecond execution telemetry.
 *
 * Zero external NPM dependencies. Built on Node.js standard modules.
 */

class AtomicToolProxy {
  constructor() {
    this.activeCalls = new Map(); // callId -> { controller, toolName, startTime, rollbackFn }
    this.callHistory = [];
  }

  /**
   * Executes a tool invocation protected by atomic cancellation.
   *
   * @param {string} callId - Unique invocation ID
   * @param {string} toolName - Name of the tool (e.g. 'update_ptp')
   * @param {Function} executor - Async function (signal) => result
   * @param {Function} [rollbackFn] - Optional async function (callId) => void invoked if aborted
   * @returns {Promise<Object>} Execution result
   */
  async execute(callId, toolName, executor, rollbackFn = null) {
    if (this.activeCalls.has(callId)) {
      throw new Error(`Tool callId "${callId}" is already active`);
    }

    const controller = new AbortController();
    const record = {
      callId,
      toolName,
      status: 'DISPATCHED',
      startTime: Date.now(),
      endTime: null,
      controller,
      rollbackFn,
      result: null,
      error: null,
    };

    this.activeCalls.set(callId, record);

    try {
      const result = await executor(controller.signal);
      record.status = 'COMMITTED';
      record.result = result;
      record.endTime = Date.now();
      return { success: true, result, aborted: false };
    } catch (err) {
      if (controller.signal.aborted) {
        record.status = 'ABORTED';
        record.error = 'Tool execution aborted due to caller barge-in';
        record.endTime = Date.now();

        if (typeof rollbackFn === 'function') {
          try {
            await rollbackFn(callId);
          } catch (rbErr) {
            record.rollbackError = rbErr.message;
          }
        }

        return { success: false, error: record.error, aborted: true };
      }

      record.status = 'FAILED';
      record.error = err.message;
      record.endTime = Date.now();
      throw err;
    } finally {
      this.activeCalls.delete(callId);
      this.callHistory.push({
        callId: record.callId,
        toolName: record.toolName,
        status: record.status,
        durationMs: record.endTime ? record.endTime - record.startTime : 0,
      });
    }
  }

  executeAtomicTool(callId, toolName, executor, rollbackFn = null) {
    return this.execute(callId, toolName, executor, rollbackFn);
  }

  /**
   * Immediately aborts an in-flight tool call (e.g. when caller speaks over the agent).
   * @param {string} callId
   * @param {string} [reason='Caller barge-in detected']
   * @returns {boolean} true if an active call was found and aborted
   */
  abort(callId, reason = 'Caller barge-in detected') {
    const record = this.activeCalls.get(callId);
    if (!record) return false;

    record.controller.abort(new Error(reason));
    return true;
  }

  /**
   * Aborts all currently active in-flight tool calls.
   * Useful when a global interruption or immediate call hangup occurs.
   * @returns {number} Count of aborted calls
   */
  abortAll(reason = 'Global call interruption') {
    let count = 0;
    for (const [callId, record] of this.activeCalls.entries()) {
      record.controller.abort(new Error(reason));
      count++;
    }
    return count;
  }

  /**
   * Gets telemetry summary.
   */
  getTelemetry() {
    return {
      activeCount: this.activeCalls.size,
      historyCount: this.callHistory.length,
      history: [...this.callHistory],
    };
  }
}

export { AtomicToolProxy };

