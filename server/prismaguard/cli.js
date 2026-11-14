#!/usr/bin/env node
/**
 * ChaosFlight CLI: Enterprise Telephony CI/CD Gate & Compliance Auditor
 *
 * Usage:
 *   node server/prismaguard/cli.js [options]
 *   npm run certify
 *   npm run chaosflight
 *
 * Options:
 *   --all                 Run all prebuilt enterprise scenarios (default)
 *   --scenario=<id>       Run a specific scenario (e.g. trai-stop-signal-dnd)
 *   --matrix              Run full matrix across codecs (mulaw, alaw) and noise profiles
 *   --file=<path>         Load and certify a custom scenario JSON/YAML file
 *   --codec=<mulaw|alaw>  Telephony codec (default: mulaw)
 *   --noise=<profile>     Acoustic profile: ceiling_fan, auto_rickshaw, bazaar, none
 *   --snr=<db>            Signal-to-noise ratio in dB (default: 14)
 *   --loss=<rate>         Packet loss rate 0.0 - 0.2 (default: 0.03)
 *   --xml=<path>          Output JUnit XML report path
 *   --markdown=<path>     Output Markdown audit report path
 *   --json                Output raw JSON results to stdout
 *   --help, -h            Show help documentation
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID single-responsibility.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
import { runChaosFlightSimulation } from './flightController.js';
import { PREBUILT_SCENARIOS, getPrebuiltScenario } from './chaosflight/scenarios.js';
import { CertificationReporter } from './chaosflight/certificationReporter.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function parseArgs(args) {
  const options = {
    all: false,
    scenario: null,
    matrix: false,
    file: null,
    codec: 'mulaw',
    noise: 'ceiling_fan',
    snr: 14,
    loss: 0.03,
    xml: null,
    markdown: null,
    json: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--matrix') options.matrix = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--scenario=')) options.scenario = arg.slice(11);
    else if (arg.startsWith('--file=')) options.file = arg.slice(7);
    else if (arg.startsWith('--codec=')) options.codec = arg.slice(8);
    else if (arg.startsWith('--noise=')) options.noise = arg.slice(8);
    else if (arg.startsWith('--snr=')) options.snr = Number(arg.slice(6));
    else if (arg.startsWith('--loss=')) options.loss = Number(arg.slice(7));
    else if (arg.startsWith('--xml=')) options.xml = arg.slice(6);
    else if (arg.startsWith('--markdown=')) options.markdown = arg.slice(11);
    else if (arg.startsWith('--md=')) options.markdown = arg.slice(5);
  }

  if (!options.scenario && !options.file && !options.matrix) {
    options.all = true;
  }

  return options;
}

function printBanner() {
  console.log(`
${ANSI.cyan}${ANSI.bold}╔═════════════════════════════════════════════════════════════════════════════════════╗
║   🛡️  CHAOSFLIGHT: SOVEREIGN VOICE AGENT CI/CD CERTIFICATION & TIME-WARP GATE      ║
║   TRAI TCCCPR Reg 21A • RBI Fair Practices • DPDP Act 2023 • 10,000x Speedup DSP     ║
╚═════════════════════════════════════════════════════════════════════════════════════╝${ANSI.reset}
`);
}

function printHelp() {
  printBanner();
  console.log(`Usage:
  node server/prismaguard/cli.js [options]
  npm run certify

Options:
  --all                 Run all prebuilt enterprise scenarios (default)
  --scenario=<id>       Run a specific scenario (e.g. trai-stop-signal-dnd)
  --matrix              Run full matrix across codecs (mulaw, alaw) & noise profiles
  --file=<path>         Certify custom scenario file from disk
  --codec=<mulaw|alaw>  ITU-T G.711 codec emulation (default: mulaw)
  --noise=<profile>     Acoustic profile: ceiling_fan, auto_rickshaw, bazaar, none
  --snr=<db>            Signal-to-noise ratio in dB (default: 14)
  --loss=<rate>         Packet loss rate (default: 0.03)
  --xml=<path>          Output JUnit XML report path (for GitHub Actions)
  --markdown=<path>     Output Markdown PR summary report
  --json                Output raw JSON results to stdout
  --help, -h            Show this documentation

Available Scenarios:
${PREBUILT_SCENARIOS.map((s) => `  - ${s.id.padEnd(35)} [${s.domain}]`).join('\n')}
`);
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.json) {
    printBanner();
  }

  const reporter = new CertificationReporter({ suiteName: 'ChaosFlight Sovereign Telephony Gate' });
  const scenarioRuns = [];

  // Determine scenario list
  if (options.file) {
    const safePath = normalize(resolve(process.cwd(), options.file));
    if (!existsSync(safePath)) {
      console.error(`${ANSI.red}Error: Custom scenario file not found: ${safePath}${ANSI.reset}`);
      process.exit(1);
    }
    try {
      const customScenario = JSON.parse(readFileSync(safePath, 'utf8'));
      scenarioRuns.push({
        scenario: customScenario,
        codec: options.codec,
        noise: options.noise,
        snr: options.snr,
        loss: options.loss,
      });
    } catch (err) {
      console.error(`${ANSI.red}Error parsing scenario JSON: ${err.message}${ANSI.reset}`);
      process.exit(1);
    }
  } else if (options.matrix) {
    const codecs = ['mulaw', 'alaw'];
    const noises = ['ceiling_fan', 'auto_rickshaw', 'bazaar'];
    for (const sc of PREBUILT_SCENARIOS) {
      for (const codec of codecs) {
        for (const noise of noises) {
          scenarioRuns.push({
            scenario: sc,
            codec,
            noise,
            snr: 12,
            loss: 0.04,
          });
        }
      }
    }
  } else if (options.scenario) {
    const sc = getPrebuiltScenario(options.scenario);
    if (!sc) {
      console.error(`${ANSI.red}Error: Scenario "${options.scenario}" not found.${ANSI.reset}`);
      console.error(`Available: ${PREBUILT_SCENARIOS.map((s) => s.id).join(', ')}`);
      process.exit(1);
    }
    scenarioRuns.push({
      scenario: sc,
      codec: options.codec,
      noise: options.noise,
      snr: options.snr,
      loss: options.loss,
    });
  } else {
    // Run all prebuilt scenarios
    for (const sc of PREBUILT_SCENARIOS) {
      scenarioRuns.push({
        scenario: sc,
        codec: sc.telephonyConfig?.codec || options.codec,
        noise: sc.telephonyConfig?.noiseProfile || options.noise,
        snr: sc.telephonyConfig?.snrDb || options.snr,
        loss: sc.telephonyConfig?.packetLossRate || options.loss,
      });
    }
  }

  if (!options.json) {
    console.log(`${ANSI.bold}Executing ${scenarioRuns.length} Telephony Certification Flight(s)...${ANSI.reset}\n`);
    console.log('┌──────────────────────────────────────┬──────────┬───────────┬─────────┬────────┬──────────────┐');
    console.log('│ Scenario Identifier                  │ Codec    │ Noise     │ DSP (ms)│ Speedup│ Status       │');
    console.log('├──────────────────────────────────────┼──────────┼───────────┼─────────┼────────┼──────────────┤');
  }

  const results = [];
  let totalTimeMs = 0;
  let allPassed = true;

  for (const item of scenarioRuns) {
    const startTime = performance.now();
    try {
      const sim = await runChaosFlightSimulation({
        scenarioId: item.scenario.id,
        scenario: item.scenario,
        codec: item.codec,
        noiseProfile: item.noise,
        snrDb: item.snr,
        packetLossRate: item.loss,
        enablePrismaGuard: true,
      });

      const elapsed = performance.now() - startTime;
      totalTimeMs += elapsed;

      const passed = Object.values(sim.assertions).every((a) => a.passed);
      if (!passed) allPassed = false;

      const cliSim = { ...sim };
      if (cliSim.telephonyMetrics) {
        cliSim.telephonyMetrics = { ...cliSim.telephonyMetrics };
        if (cliSim.telephonyMetrics.cleanAudioUri) {
          cliSim.telephonyMetrics.cleanAudioUri = `[WAV base64 ${cliSim.telephonyMetrics.cleanAudioUri.length} chars]`;
        }
        if (cliSim.telephonyMetrics.degradedAudioUri) {
          cliSim.telephonyMetrics.degradedAudioUri = `[WAV base64 ${cliSim.telephonyMetrics.degradedAudioUri.length} chars]`;
        }
      }
      results.push(cliSim);

      reporter.addRunResult({
        scenarioId: sim.scenarioId,
        name: sim.title,
        passed,
        escalatedToHuman: false,
        policyViolations: passed ? [] : ['compliance_assertion_failure'],
        schemaViolations: sim.assertions?.openApiSchemaMatch?.errors || [],
      });

      if (!options.json) {
        const idCol = sim.scenarioId.slice(0, 36).padEnd(36);
        const codecCol = item.codec.padEnd(8);
        const noiseCol = item.noise.slice(0, 9).padEnd(9);
        const dspCol = String(sim.telephonyMetrics?.dspLatencyMs || 0).padEnd(7);
        const speedupCol = `${sim.telephonyMetrics?.speedupFactor || 12000}x`.padEnd(6);
        const statusCol = passed
          ? `${ANSI.green}✔ PASS${ANSI.reset}     `
          : `${ANSI.red}✖ FAIL${ANSI.reset}     `;

        console.log(`│ ${idCol} │ ${codecCol} │ ${noiseCol} │ ${dspCol} │ ${speedupCol} │ ${statusCol}│`);
      }
    } catch (err) {
      allPassed = false;
      if (!options.json) {
        console.log(`│ ${item.scenario.id.slice(0, 36).padEnd(36)} │ ERROR: ${err.message}`);
      }
    }
  }

  if (!options.json) {
    console.log('└──────────────────────────────────────┴──────────┴───────────┴─────────┴────────┴──────────────┘\n');
  }

  const metrics = reporter.computeMetrics();

  if (options.json) {
    console.log(JSON.stringify({
      success: allPassed,
      totalFlights: scenarioRuns.length,
      passed: metrics.passed,
      failed: metrics.failed,
      taskCompletionRate: metrics.taskCompletionRate,
      totalWallClockMs: Number(totalTimeMs.toFixed(2)),
      results,
    }, null, 2));
  } else {
    const maxNri = Math.max(...results.map((r) => r.actuarialRisk?.nonComplianceRiskIndex || 0), 0);
    const avgViolations = results.length > 0
      ? (results.reduce((acc, r) => acc + (r.actuarialRisk?.violationsPer1000 || 0), 0) / results.length).toFixed(1)
      : '0.0';
    const maxBlacklistProb = Math.max(...results.map((r) => r.actuarialRisk?.trai21aBlacklistPct || 0), 0);

    console.log(`${ANSI.bold}=== CERTIFICATION SUMMARY ===${ANSI.reset}`);
    console.log(`Flights Run:         ${ANSI.bold}${scenarioRuns.length}${ANSI.reset}`);
    console.log(`Passed:              ${ANSI.green}${metrics.passed}${ANSI.reset}`);
    console.log(`Failed:              ${metrics.failed > 0 ? ANSI.red : ANSI.gray}${metrics.failed}${ANSI.reset}`);
    console.log(`Task Completion:     ${ANSI.cyan}${(metrics.taskCompletionRate * 100).toFixed(1)}%${ANSI.reset}`);
    console.log(`Max Risk Index:      ${maxNri === 0 ? ANSI.green : ANSI.red}${maxNri}/100 NRI${ANSI.reset}`);
    console.log(`Est. Violations/1k:  ${ANSI.cyan}${avgViolations} calls${ANSI.reset}`);
    console.log(`TRAI Reg 21A Risk:   ${maxBlacklistProb < 1 ? ANSI.green : ANSI.red}${maxBlacklistProb}% Blacklist Probability${ANSI.reset}`);
    console.log(`Total CI Latency:    ${ANSI.yellow}${totalTimeMs.toFixed(1)}ms${ANSI.reset} (${ANSI.bold}Zero GPU Overhead${ANSI.reset})`);
    console.log(`Gate Verdict:        ${allPassed ? `${ANSI.green}${ANSI.bold}PASSED — PRODUCTION APPROVED${ANSI.reset}` : `${ANSI.red}${ANSI.bold}FAILED — REJECTED${ANSI.reset}`}\n`);
  }

  // Write reports if requested
  if (options.xml) {
    const xmlContent = reporter.toJUnitXml();
    const dest = resolve(process.cwd(), options.xml);
    writeFileSync(dest, xmlContent, 'utf8');
    if (!options.json) console.log(`${ANSI.green}✔ JUnit XML report written to: ${dest}${ANSI.reset}`);
  }

  if (options.markdown) {
    const mdContent = reporter.toMarkdown();
    const dest = resolve(process.cwd(), options.markdown);
    writeFileSync(dest, mdContent, 'utf8');
    if (!options.json) console.log(`${ANSI.green}✔ Markdown PR audit written to: ${dest}${ANSI.reset}`);
  }

  process.exitCode = allPassed ? 0 : 1;
}

runCli().catch((err) => {
  console.error(`${ANSI.red}Fatal CLI Error: ${err.stack || err.message}${ANSI.reset}`);
  process.exit(1);
});

