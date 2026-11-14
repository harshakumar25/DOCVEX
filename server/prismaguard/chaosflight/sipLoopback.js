/**
 * SipLoopback: Virtual In-Memory Telephony Trunk & WebRTC Loopback Adapter
 *
 * Implements:
 * 1. Legal, Non-PSTN Telephony Testing:
 *    Simulates SIP (RFC 3261) and SDP (RFC 4566) session signaling entirely in memory.
 *    Eliminates illegal A2P spam violations and per-minute carrier PSTN tolls.
 * 2. 20ms RTP Frame Packetizer (160 samples/frame @ 8000 Hz).
 * 3. SIP Dialog State Machine (IDLE -> INVITE -> 180 RINGING -> 200 OK -> ESTABLISHED -> BYE).
 * 4. Millisecond Teardown Signaling Timer (verifying SIP BYE emission within statutory limits).
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID single-responsibility.
 */

export const SIP_STATES = {
  IDLE: 'IDLE',
  INVITE_SENT: 'INVITE_SENT',
  RINGING_180: 'RINGING_180',
  ANSWERED_200: 'ANSWERED_200',
  ESTABLISHED: 'ESTABLISHED',
  BYE_SENT: 'BYE_SENT',
  TERMINATED: 'TERMINATED',
};

/**
 * In-Memory Virtual SIP User Agent (UA) for Enterprise CI/CD Certification.
 */
export class SipLoopbackSession {
  /**
   * @param {Object} options
   * @param {string} [options.callerCli='+911408291000'] - Outbound CLI pre-declared under A2P
   * @param {string} [options.calleeNumber='+919876543210'] - Simulated recipient
   * @param {string} [options.codec='PCMU'] - PCMU (G.711 u-law) or PCMA (G.711 A-law)
   * @param {number} [options.sampleRate=8000]
   */
  constructor({
    callerCli = '+911408291000',
    calleeNumber = '+919876543210',
    codec = 'PCMU',
    sampleRate = 8000,
  } = {}) {
    this.callId = 'sip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    this.callerCli = callerCli;
    this.calleeNumber = calleeNumber;
    this.codec = codec === 'PCMA' ? 'PCMA' : 'PCMU';
    this.payloadType = this.codec === 'PCMA' ? 8 : 0;
    this.sampleRate = sampleRate;
    this.state = SIP_STATES.IDLE;

    this.establishedTime = null;
    this.terminatedTime = null;
    this.teardownLatencyMs = null;

    this.rtpSeq = 0;
    this.rtpTimestamp = 0;
    this.sentFrames = [];
    this.receivedFrames = [];
  }

  /**
   * Initiates SIP INVITE and completes 3-way handshake in memory.
   * @returns {{ status: number, sdp: string, state: string }}
   */
  invite() {
    this.state = SIP_STATES.INVITE_SENT;
    // Emulate 180 Ringing
    this.state = SIP_STATES.RINGING_180;
    // Emulate 200 OK
    this.state = SIP_STATES.ANSWERED_200;
    this.state = SIP_STATES.ESTABLISHED;
    this.establishedTime = performance.now();

    const sdp = [
      'v=0',
      `o=ChaosFlight ${this.callId} 1 IN IP4 127.0.0.1`,
      's=Sovereign Voice Certification',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=audio 10000 RTP/AVP ${this.payloadType}`,
      `a=rtpmap:${this.payloadType} ${this.codec}/${this.sampleRate}`,
      'a=sendrecv',
    ].join('\r\n');

    return {
      status: 200,
      callId: this.callId,
      sdp,
      state: this.state,
    };
  }

  /**
   * Packetizes a PCM buffer into 20ms RTP audio frames (160 samples per frame @ 8kHz).
   * @param {Int16Array|Uint8Array} pcmBuffer
   * @returns {Array<Object>} RTP packet descriptors
   */
  packetizeRtpFrames(pcmBuffer) {
    const frameSize = 160; // 20ms at 8000 Hz
    const frames = [];
    const totalFrames = Math.floor(pcmBuffer.length / frameSize);

    for (let i = 0; i < totalFrames; i++) {
      this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
      this.rtpTimestamp += frameSize;

      const frameData = pcmBuffer.subarray(i * frameSize, (i + 1) * frameSize);
      const packet = {
        sequenceNumber: this.rtpSeq,
        timestamp: this.rtpTimestamp,
        payloadType: this.payloadType,
        payloadSize: frameData.byteLength,
        durationMs: 20,
      };
      frames.push(packet);
      this.sentFrames.push(packet);
    }

    return frames;
  }

  /**
   * Terminates the SIP session via BYE signaling and calculates teardown latency.
   * @param {number} [stopSignalTime] - Timestamp when caller stop signal was asserted
   * @returns {{ status: number, state: string, teardownMs: number }}
   */
  hangup(stopSignalTime = null) {
    const byeTime = performance.now();
    this.state = SIP_STATES.BYE_SENT;
    this.terminatedTime = byeTime;

    if (typeof stopSignalTime === 'number' && Number.isFinite(stopSignalTime)) {
      this.teardownLatencyMs = Math.max(0, Math.round(byeTime - stopSignalTime));
    } else if (this.establishedTime) {
      this.teardownLatencyMs = Math.round(byeTime - this.establishedTime);
    } else {
      this.teardownLatencyMs = 0;
    }

    this.state = SIP_STATES.TERMINATED;

    return {
      status: 200,
      callId: this.callId,
      state: this.state,
      teardownMs: this.teardownLatencyMs,
    };
  }
}
