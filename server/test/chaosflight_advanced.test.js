import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculatePoissonBlacklistProbability,
  computeActuarialRisk,
} from '../prismaguard/chaosflight/riskCalculator.js';

import {
  SIP_STATES,
  SipLoopbackSession,
} from '../prismaguard/chaosflight/sipLoopback.js';

import {
  DIALECT_DISCOURSE_MARKERS,
  calculateCodeSwitchingIndex,
  injectIndicCodeSwitching,
} from '../prismaguard/chaosflight/dialectEngine.js';

describe('ChaosFlight Advanced: Actuarial Risk, SIP Loopback & Indic Dialects', () => {
  describe('Actuarial Risk & TRAI 21A Blacklist Predictor', () => {
    it('calculates Poisson blacklist probability correctly across complaint thresholds', () => {
      // 0 expected complaints -> 0% probability
      assert.strictEqual(calculatePoissonBlacklistProbability(0), 0.0);

      // Low expected complaints (0.2 complaints) -> very low probability
      const pLow = calculatePoissonBlacklistProbability(0.2, 3);
      assert.ok(pLow < 0.01, 'P(K >= 3) for lambda=0.2 must be < 1%');

      // High expected complaints (5 complaints) -> high probability
      const pHigh = calculatePoissonBlacklistProbability(5, 3);
      assert.ok(pHigh > 0.85, 'P(K >= 3) for lambda=5 must be > 85%');

      // Extreme expected complaints (15 complaints) -> 100% certainty
      const pExtreme = calculatePoissonBlacklistProbability(15, 3);
      assert.ok(pExtreme > 0.99);
    });

    it('computes zero NRI and MINIMAL_RISK for 100% compliant assertion suite', () => {
      const cleanAssertions = {
        timeToTeardown: { passed: true },
        thirdPartyDebtDisclosure: { passed: true },
        dpdpCleartextPii: { passed: true },
        rbiCallingWindow: { passed: true },
        openApiSchemaMatch: { passed: true },
        atomicBargeInAudit: { passed: true },
      };

      const risk = computeActuarialRisk(cleanAssertions, { callVolume: 25000 });
      assert.strictEqual(risk.nonComplianceRiskIndex, 0);
      assert.strictEqual(risk.riskTier, 'MINIMAL_RISK');
      assert.strictEqual(risk.violationsPer1000, 0);
      assert.strictEqual(risk.trai21aBlacklistProbability, 0);
      assert.strictEqual(risk.productionCertified, true);
    });

    it('flags CRITICAL_BLACKLIST_IMMINENT when TRAI TTD or third-party disclosure fails', () => {
      const failingAssertions = {
        timeToTeardown: { passed: false }, // 35 points penalty
        thirdPartyDebtDisclosure: { passed: true },
        dpdpCleartextPii: { passed: true },
        rbiCallingWindow: { passed: true },
        openApiSchemaMatch: { passed: true },
        atomicBargeInAudit: { passed: true },
      };

      const risk = computeActuarialRisk(failingAssertions, { callVolume: 10000 });
      assert.strictEqual(risk.nonComplianceRiskIndex, 35);
      assert.strictEqual(risk.riskTier, 'CRITICAL_BLACKLIST_IMMINENT');
      assert.ok(risk.activeViolations.includes('TRAI_REG_21A_TEARDOWN_OVERRUN'));
      assert.strictEqual(risk.productionCertified, false);
    });
  });

  describe('In-Memory SIP Loopback & Virtual RTP Packetizer', () => {
    it('executes 3-way SIP handshake and generates RFC-compliant SDP', () => {
      const session = new SipLoopbackSession({
        callerCli: '+911408291000',
        codec: 'PCMU',
        sampleRate: 8000,
      });

      assert.strictEqual(session.state, SIP_STATES.IDLE);
      const res = session.invite();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(session.state, SIP_STATES.ESTABLISHED);
      assert.ok(res.sdp.includes('m=audio 10000 RTP/AVP 0'));
      assert.ok(res.sdp.includes('a=rtpmap:0 PCMU/8000'));
    });

    it('packetizes PCM buffer into exact 20ms RTP audio frames (160 samples per frame)', () => {
      const session = new SipLoopbackSession();
      session.invite();

      // 800 samples = 5 frames of 160 samples (100ms total)
      const pcmBuffer = new Int16Array(800);
      const frames = session.packetizeRtpFrames(pcmBuffer);

      assert.strictEqual(frames.length, 5);
      assert.strictEqual(frames[0].durationMs, 20);
      assert.strictEqual(frames[0].payloadType, 0);
      assert.strictEqual(frames[4].sequenceNumber, 5);
    });

    it('terminates call via SIP BYE and records teardown latency', () => {
      const session = new SipLoopbackSession();
      session.invite();

      const stopTime = performance.now() - 400; // 400ms ago
      const byeRes = session.hangup(stopTime);

      assert.strictEqual(byeRes.status, 200);
      assert.strictEqual(byeRes.state, SIP_STATES.TERMINATED);
      assert.ok(byeRes.teardownMs >= 350, 'Teardown latency must be measured from stopSignalTime');
    });
  });

  describe('Indic Dialect Engine & Code-Switching Index (CSI)', () => {
    it('calculates Code-Switching Index (CSI) for monolingual vs code-mixed speech', () => {
      const monolingual = 'Please send the account statement to my bank';
      const csiMono = calculateCodeSwitchingIndex(monolingual);
      assert.strictEqual(csiMono, 0.0, 'Pure English must have 0.0 CSI');

      const codeMixed = 'Mera account number check karke statement please send karo';
      const csiMixed = calculateCodeSwitchingIndex(codeMixed);
      assert.ok(csiMixed > 0.2, 'Code-mixed sentence must have non-zero CSI');
    });

    it('injectIndicCodeSwitching morphs utterances across Hinglish, Tanglish, and Kanglish', () => {
      const base = 'Sir, your payment pending. Please statement send immediately.';

      const hinglish = injectIndicCodeSwitching(base, 'hinglish');
      assert.strictEqual(hinglish.dialect, 'hinglish');
      assert.ok(hinglish.text.includes('payment pending hai'));
      assert.ok(hinglish.csi > 0);

      const tanglish = injectIndicCodeSwitching(base, 'tanglish');
      assert.strictEqual(tanglish.dialect, 'tanglish');
      assert.ok(tanglish.text.includes('payment pending-a iruku'));

      const kanglish = injectIndicCodeSwitching(base, 'kanglish');
      assert.strictEqual(kanglish.dialect, 'kanglish');
      assert.ok(kanglish.text.includes('payment pending ide'));
    });
  });
});

