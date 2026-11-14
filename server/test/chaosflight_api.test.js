import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { runChaosFlightSimulation } from '../prismaguard/index.js';

const startTestServer = async (options = {}) => {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(resolve);
  });
  return { baseUrl, close };
};

test('ChaosFlight API: GET /api/chaosflight/scenarios returns list of enterprise scenarios', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/chaosflight/scenarios`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.scenarios));
    assert.ok(body.scenarios.length >= 4);
    assert.ok(body.scenarios.some((s) => s.id === 'hdfc-debt-recovery'));
    assert.ok(body.scenarios.some((s) => s.id === 'axis-card-dispute-bargein'));
  } finally {
    await close();
  }
});

test('ChaosFlight API: POST /api/chaosflight/simulate runs time-warped simulation and returns telemetry', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/chaosflight/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarioId: 'hdfc-debt-recovery',
        codec: 'mulaw',
        noiseProfile: 'ceiling_fan',
        snrDb: 14,
        packetLossRate: 0.03,
        enablePrismaGuard: true,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.scenarioId, 'hdfc-debt-recovery');

    // Telephony DSP metrics
    assert.ok(data.telephonyMetrics);
    assert.equal(data.telephonyMetrics.codec, 'mulaw');
    assert.equal(data.telephonyMetrics.sampleRate, 8000);
    assert.ok(data.telephonyMetrics.dspLatencyMs >= 0);
    assert.ok(data.telephonyMetrics.speedupFactor >= 10);

    // Sidecar metrics
    assert.ok(data.sidecarMetrics);
    assert.equal(data.sidecarMetrics.floorHolderEmitted, true);
    assert.ok(data.sidecarMetrics.cfgSanitizationsCount >= 1);

    // Statutory assertions
    assert.ok(data.assertions);
    assert.equal(data.assertions.rbiCallingWindow.passed, true);
    assert.equal(data.assertions.rbiAgentIdentification.passed, true);
    assert.equal(data.assertions.dpdpCleartextPii.passed, true);
    assert.equal(data.assertions.openApiSchemaMatch.passed, true);

    // Reports
    assert.ok(typeof data.markdownReport === 'string');
    assert.ok(data.markdownReport.includes('Task Completion Rate (TCR)'));
    assert.ok(typeof data.junitXml === 'string');
    assert.ok(data.junitXml.includes('<testsuites'));
  } finally {
    await close();
  }
});

test('ChaosFlight API: POST /api/chaosflight/simulate verifies atomic barge-in abort in Axis scenario', async () => {
  const simulation = await runChaosFlightSimulation({
    scenarioId: 'axis-card-dispute-bargein',
    codec: 'mulaw',
    noiseProfile: 'bazaar',
    snrDb: 8,
    packetLossRate: 0.05,
    enablePrismaGuard: true,
  });

  assert.equal(simulation.success, true);
  assert.equal(simulation.scenarioId, 'axis-card-dispute-bargein');
  assert.ok(simulation.sidecarMetrics.atomicAbortsCount >= 1);
  assert.equal(simulation.assertions.atomicBargeInAudit.passed, true);
  assert.ok(simulation.abortedToolInvocations.length >= 1);
  assert.equal(simulation.abortedToolInvocations[0].name, 'freeze_card');
});

test('ChaosFlight API: POST /api/chaosflight/simulate verifies dialect stressor, CSI, and actuarial risk', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/chaosflight/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarioId: 'hdfc-debt-recovery',
        codec: 'alaw',
        dialect: 'tanglish',
        noiseProfile: 'bazaar',
        snrDb: 10,
        packetLossRate: 0.04,
        enablePrismaGuard: true,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.scenarioId, 'hdfc-debt-recovery');

    // Dialect telemetry
    assert.ok(data.dialectTelemetry);
    assert.equal(data.dialectTelemetry.dialect, 'tanglish');
    assert.ok(data.dialectTelemetry.averageCsi >= 0);

    // Actuarial risk model
    assert.ok(data.actuarialRisk);
    assert.equal(data.actuarialRisk.riskScore, 0);
    assert.equal(data.actuarialRisk.riskTier, 'MINIMAL_RISK');
    assert.equal(data.actuarialRisk.blacklistProbability, 0);

    // Outcome fidelity
    assert.ok(data.assertions.outcomeFidelity);
    assert.equal(data.assertions.outcomeFidelity.passed, true);
    assert.equal(data.assertions.outcomeFidelity.parsedAmount, 7900);
    assert.equal(data.assertions.outcomeFidelity.expectedAmount, 7900);

    // SIP Telemetry
    assert.ok(data.sipTelemetry);
    assert.equal(data.sipTelemetry.dialogState, 'TERMINATED');
    assert.equal(data.sipTelemetry.payloadType, 8); // PCMA (A-law)
  } finally {
    await close();
  }
});

test('ChaosFlight API: rejects invalid json payload gracefully with 400', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/chaosflight/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json{{{',
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
