/**
 * PrismaGuard & ChaosFlight Sovereign Voice Agent Reliability Suite
 *
 * Unified Entrypoint:
 * - ChaosFlight: Pre-Deploy Telephony Chaos Flight Simulator
 * - PrismaGuard: In-Flight Runtime Deterministic Tool-Call Firewall & Floor-Holder
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID principles.
 */

import {
  linearToMuLaw,
  muLawToLinear,
  linearToALaw,
  aLawToLinear,
  resampleTo8kHz,
  createTelephonyBandpassFilter,
  GilbertElliottLossSimulator,
  applyNetworkLossAndPLC,
  processTelephonyChannel,
} from './chaosflight/carrierDigitalTwin.js';

import {
  calculateRms,
  synthesizeCeilingFanNoise,
  synthesizeAutoRickshawNoise,
  synthesizeBazaarBabble,
  applySpeakerphoneEcho,
  mixAcousticEnvironment,
} from './chaosflight/acousticConvolver.js';

import {
  EPENTHESIS_DICTIONARY,
  INDIC_UN_NUMERALS,
  injectVowelEpenthesis,
  getIndicNumeralVariation,
  SyntheticCaller,
  executeScenario,
} from './chaosflight/scenarioRunner.js';

import {
  PREBUILT_SCENARIOS,
  getPrebuiltScenario,
} from './chaosflight/scenarios.js';

import { runChaosFlightSimulation } from './flightController.js';

import {
  assertRbiCallingWindow,
  assertRbiAgentIdentification,
  assertDpdpNoCleartextPii,
  assertOpenApiSchemaMatch,
  assertNoStaleToolExecution,
  detectStopSignal,
  assertTimeToTeardown,
  assertCrmSuppression,
  assertNoThirdPartyDebtDisclosure,
  parseIndicIdiomaticAmount,
  assertOutcomeFidelity,
} from './chaosflight/telephonyAssertions.js';

import { CertificationReporter } from './chaosflight/certificationReporter.js';
import {
  calculatePoissonBlacklistProbability,
  computeActuarialRisk,
} from './chaosflight/riskCalculator.js';
import {
  SIP_STATES,
  SipLoopbackSession,
} from './chaosflight/sipLoopback.js';
import {
  DIALECT_DISCOURSE_MARKERS,
  CODE_SWITCH_PATTERNS,
  calculateCodeSwitchingIndex,
  injectIndicCodeSwitching,
} from './chaosflight/dialectEngine.js';

import { FloorHolder, DEFAULT_FILLERS } from './sidecar/floorHolder.js';
import {
  extractJsonString,
  compileSchemaSpec,
  sanitizeAndCastToolArguments,
  isTokenAllowedUnderCFG,
} from './sidecar/cfgLogitMasker.js';
import { AtomicToolProxy } from './sidecar/atomicToolProxy.js';

/**
 * High-level ChaosFlight Telephony Simulator API.
 */
const ChaosFlight = {
  processTelephonyChannel,
  resampleTo8kHz,
  createTelephonyBandpassFilter,
  GilbertElliottLossSimulator,
  mixAcousticEnvironment,
  applySpeakerphoneEcho,
  injectVowelEpenthesis,
  getIndicNumeralVariation,
  SyntheticCaller,
  executeScenario,
  runChaosFlightSimulation,
  PREBUILT_SCENARIOS,
  getPrebuiltScenario,
  assertions: {
    assertRbiCallingWindow,
    assertRbiAgentIdentification,
    assertDpdpNoCleartextPii,
    assertOpenApiSchemaMatch,
    assertNoStaleToolExecution,
    detectStopSignal,
    assertTimeToTeardown,
    assertCrmSuppression,
    assertNoThirdPartyDebtDisclosure,
    parseIndicIdiomaticAmount,
    assertOutcomeFidelity,
  },
  risk: {
    calculatePoissonBlacklistProbability,
    computeActuarialRisk,
  },
  sip: {
    SIP_STATES,
    SipLoopbackSession,
  },
  dialect: {
    DIALECT_DISCOURSE_MARKERS,
    CODE_SWITCH_PATTERNS,
    calculateCodeSwitchingIndex,
    injectIndicCodeSwitching,
  },
  CertificationReporter,
};

/**
 * High-level PrismaGuard Runtime Sidecar API.
 */
const PrismaGuard = {
  FloorHolder,
  DEFAULT_FILLERS,
  extractJsonString,
  compileSchemaSpec,
  sanitizeAndCastToolArguments,
  isTokenAllowedUnderCFG,
  AtomicToolProxy,
};

export {
  ChaosFlight,
  PrismaGuard,
  // Direct module exports
  linearToMuLaw,
  muLawToLinear,
  linearToALaw,
  aLawToLinear,
  resampleTo8kHz,
  createTelephonyBandpassFilter,
  GilbertElliottLossSimulator,
  applyNetworkLossAndPLC,
  processTelephonyChannel,
  calculateRms,
  synthesizeCeilingFanNoise,
  synthesizeAutoRickshawNoise,
  synthesizeBazaarBabble,
  applySpeakerphoneEcho,
  mixAcousticEnvironment,
  EPENTHESIS_DICTIONARY,
  INDIC_UN_NUMERALS,
  injectVowelEpenthesis,
  getIndicNumeralVariation,
  SyntheticCaller,
  executeScenario,
  runChaosFlightSimulation,
  PREBUILT_SCENARIOS,
  getPrebuiltScenario,
  assertRbiCallingWindow,
  assertRbiAgentIdentification,
  assertDpdpNoCleartextPii,
  assertOpenApiSchemaMatch,
  assertNoStaleToolExecution,
  detectStopSignal,
  assertTimeToTeardown,
  assertCrmSuppression,
  assertNoThirdPartyDebtDisclosure,
  parseIndicIdiomaticAmount,
  assertOutcomeFidelity,
  calculatePoissonBlacklistProbability,
  computeActuarialRisk,
  SIP_STATES,
  SipLoopbackSession,
  DIALECT_DISCOURSE_MARKERS,
  CODE_SWITCH_PATTERNS,
  calculateCodeSwitchingIndex,
  injectIndicCodeSwitching,
  CertificationReporter,
  FloorHolder,
  DEFAULT_FILLERS,
  extractJsonString,
  compileSchemaSpec,
  sanitizeAndCastToolArguments,
  isTokenAllowedUnderCFG,
  AtomicToolProxy,
};

