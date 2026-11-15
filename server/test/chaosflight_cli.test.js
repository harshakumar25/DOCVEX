import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const CLI_PATH = resolve(process.cwd(), 'server/prismaguard/cli.js');

describe('ChaosFlight CLI Integration Tests', () => {
  it('executes --help and displays usage documentation', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, '--help']);
    assert.ok(stdout.includes('CHAOSFLIGHT: SOVEREIGN VOICE AGENT CI/CD CERTIFICATION'));
    assert.ok(stdout.includes('--scenario=<id>'));
    assert.ok(stdout.includes('--matrix'));
  });

  it('runs specific scenario with stdout table and returns exit code 0', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--scenario=trai-stop-signal-dnd',
    ]);
    assert.ok(stdout.includes('trai-stop-signal-dnd'));
    assert.ok(stdout.includes('✔ PASS'));
    assert.ok(stdout.includes('PASSED — PRODUCTION APPROVED'));
  });

  it('runs scenario with --json flag and emits structured machine-readable telemetry', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--scenario=hdfc-third-party-social-engineering',
      '--json',
    ]);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.totalFlights, 1);
    assert.strictEqual(parsed.passed, 1);
    assert.strictEqual(parsed.failed, 0);
    assert.strictEqual(parsed.taskCompletionRate, 1);
    assert.strictEqual(parsed.results[0].scenarioId, 'hdfc-third-party-social-engineering');
    assert.strictEqual(parsed.results[0].assertions.thirdPartyDebtDisclosure.passed, true);
  });

  it('exits with code 1 when scenario does not exist', async () => {
    try {
      await execFileAsync(process.execPath, [
        CLI_PATH,
        '--scenario=bogus-scenario-that-does-not-exist',
      ]);
      assert.fail('Must fail with exit code 1');
    } catch (err) {
      assert.strictEqual(err.code, 1);
      assert.ok(err.stderr.includes('Error: Scenario "bogus-scenario-that-does-not-exist" not found'));
    }
  });

  it('runs custom scenario file and outputs markdown and junit reports', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaos-cli-test-'));
    const scenarioFile = path.join(tempDir, 'custom.json');
    const mdFile = path.join(tempDir, 'report.md');
    const xmlFile = path.join(tempDir, 'results.xml');

    const customScenario = {
      id: 'custom-kyc-test',
      title: 'Custom Verification Test',
      domain: 'Testing',
      telephonyConfig: { codec: 'mulaw', noiseProfile: 'none', snrDb: 18, packetLossRate: 0.01 },
      callerPersona: {
        turns: [{ text: 'Namaste, mera account verify kardo.' }]
      }
    };

    await fs.writeFile(scenarioFile, JSON.stringify(customScenario));

    try {
      const { stdout } = await execFileAsync(process.execPath, [
        CLI_PATH,
        `--file=${scenarioFile}`,
        `--markdown=${mdFile}`,
        `--xml=${xmlFile}`,
      ]);

      assert.ok(stdout.includes('custom-kyc-test'));
      assert.ok(stdout.includes('✔ PASS'));

      const mdContent = await fs.readFile(mdFile, 'utf8');
      assert.ok(mdContent.includes('ChaosFlight Telephony Certification Gate'));

      const xmlContent = await fs.readFile(xmlFile, 'utf8');
      assert.ok(xmlContent.includes('<testsuites'));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

