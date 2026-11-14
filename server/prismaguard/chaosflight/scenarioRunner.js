/**
 * ScenarioRunner: Indic Sociolinguistic Synthetic Caller & Scenario Orchestrator
 *
 * Implements:
 * 1. Stateful Synthetic Caller with dynamic patience meter and frustration modeling.
 * 2. Indic vowel epenthesis injector (/ɪs.kuːl/, /sə.plɪt/).
 * 3. Indic "Un-Series" numeral ambiguity generator (29, 39, 49, 59, 69, 79, 89).
 * 4. Asynchronous barge-in trigger with exact millisecond interruption offset.
 *
 * Zero external NPM dependencies. Built on Node.js standard modules.
 */

import { injectIndicCodeSwitching, calculateCodeSwitchingIndex } from './dialectEngine.js';

// Common English consonant cluster words that undergo Indic vowel epenthesis
const EPENTHESIS_DICTIONARY = [
  { regex: /\bscript\b/gi, epenthesized: 'iskript' },
  { regex: /\bschool\b/gi, epenthesized: 'iskool' },
  { regex: /\bspecial\b/gi, epenthesized: 'ispeshal' },
  { regex: /\bsplit\b/gi, epenthesized: 'saplit' },
  { regex: /\bstart\b/gi, epenthesized: 'istaart' },
  { regex: /\bstatement\b/gi, epenthesized: 'istatement' },
  { regex: /\bstatus\b/gi, epenthesized: 'istatus' },
  { regex: /\bscreen\b/gi, epenthesized: 'iskreen' },
];

// Indic Un-series numerals with phonetic collision pairings
const INDIC_UN_NUMERALS = {
  29: { hindi: 'untees', collision: 'chhattis', meaning: 29 },
  39: { hindi: 'unchalis', collision: 'paintalis', meaning: 39 },
  49: { hindi: 'unchaas', collision: 'pachaas', meaning: 49 },
  59: { hindi: 'unsath', collision: 'saath', meaning: 59 },
  69: { hindi: 'unhatthar', collision: 'ikyattar', meaning: 69 },
  79: { hindi: 'uniyasi', collision: 'nauasi', meaning: 79 },
  89: { hindi: 'nauasi', collision: 'uniyasi', meaning: 89 },
};

/**
 * Injects vowel epenthesis into English words within an Indic sentence.
 * Simulates realistic acoustic phonotactics of Indian callers.
 * @param {string} text
 * @returns {string}
 */
function injectVowelEpenthesis(text) {
  if (typeof text !== 'string') return text;
  let modified = text;
  for (const { regex, epenthesized } of EPENTHESIS_DICTIONARY) {
    modified = modified.replace(regex, epenthesized);
  }
  return modified;
}

/**
 * Injects Un-series numeral phonetic variations into test prompts.
 * @param {number} number - e.g. 79, 29, 49
 * @returns {{ phrase: string, intendedNumber: number, collisionTarget: string }}
 */
function getIndicNumeralVariation(number) {
  const item = INDIC_UN_NUMERALS[number];
  if (!item) {
    return { phrase: String(number), intendedNumber: number, collisionTarget: String(number) };
  }
  return {
    phrase: item.hindi,
    intendedNumber: item.meaning,
    collisionTarget: item.collision,
  };
}

/**
 * Stateful Synthetic Caller simulating realistic human behaviors.
 */
class SyntheticCaller {
  /**
   * @param {Object} spec
   * @param {string} spec.id
   * @param {string} spec.persona
   * @param {string} [spec.language='hi-IN']
   * @param {number} [spec.initialPatience=100] - 0-100 patience scale
   * @param {Array<Object>} spec.turns - Pre-scripted turn trajectory
   */
  constructor({
    id = 'caller-default',
    persona = 'evasive_debtor',
    language = 'hi-IN',
    initialPatience = 100,
    turns = [],
  } = {}) {
    this.id = id;
    this.persona = persona;
    this.language = language;
    this.patience = initialPatience;
    this.turns = turns;
    this.currentTurnIndex = 0;
    this.isFrustrated = false;
  }

  /**
   * Generates the caller's next spoken turn based on agent response.
   * @param {string} [agentResponse=''] - Agent's previous spoken turn
   * @returns {Object|null}
   */
  nextTurn(agentResponse = '') {
    if (this.currentTurnIndex >= this.turns.length) {
      return null; // Dialogue finished
    }

    const turnConfig = this.turns[this.currentTurnIndex++];

    // Simulate patience decay if agent was repetitive or unresponsive
    if (agentResponse.includes('dobara boliye') || agentResponse.includes('samajh nahi')) {
      this.patience -= 25;
    } else {
      this.patience -= 5;
    }

    if (this.patience <= 30) {
      this.isFrustrated = true;
    }

    let spokenText = turnConfig.speak || turnConfig.text || '';
    if (turnConfig.applyEpenthesis) {
      spokenText = injectVowelEpenthesis(spokenText);
    }

    return {
      turnNumber: this.currentTurnIndex,
      text: spokenText,
      triggerBargeIn: Boolean(turnConfig.triggerBargeIn),
      bargeInAtMs: turnConfig.bargeInAtMs || 400,
      patience: this.patience,
      isFrustrated: this.isFrustrated,
      expectedIntent: turnConfig.expectedIntent || 'reply',
    };
  }

  reset() {
    this.currentTurnIndex = 0;
    this.patience = 100;
    this.isFrustrated = false;
  }
}

/**
 * Executes a declarative scenario against an agent dialogue handler.
 *
 * @param {Object} scenarioSpec - The scenario definition
 * @param {Function} agentTurnHandler - Async function (callerUtterance) => agentTurnResult
 * @param {Object} [options={}] - Optional runtime stressors (e.g. dialect)
 * @param {string} [options.dialect] - Indic dialect to stress-test ('hinglish'|'tanglish'|'kanglish'|'monolingual')
 * @returns {Promise<Object>} Completed session transcript and execution trace
 */
async function executeScenario(scenarioSpec, agentTurnHandler, options = {}) {
  const caller = new SyntheticCaller({
    id: scenarioSpec.id,
    persona: scenarioSpec.callerPersona?.persona || 'default',
    language: scenarioSpec.callerPersona?.language || 'hi-IN',
    turns: scenarioSpec.callerPersona?.turns || [],
  });

  const sessionTrace = {
    scenarioId: scenarioSpec.id,
    startTime: Date.now(),
    turns: [],
    toolInvocations: [],
    abortedToolInvocations: [],
    completed: false,
    terminationReason: 'normal',
    dialect: options.dialect || 'monolingual',
    averageCsi: 0.0,
  };

  let lastAgentSpoken = '';
  let turn = caller.nextTurn(lastAgentSpoken);

  while (turn) {
    const callerOffset = typeof turn.offsetMs === 'number' ? turn.offsetMs : (turn.turnNumber - 1) * 3000;
    
    let callerSpoken = turn.text;
    let turnCsi = 0.0;
    if (options.dialect && options.dialect !== 'monolingual') {
      const switched = injectIndicCodeSwitching(callerSpoken, options.dialect);
      callerSpoken = switched.text;
      turnCsi = switched.csi;
    } else {
      turnCsi = calculateCodeSwitchingIndex(callerSpoken);
    }

    const callerTurnRecord = {
      turnNumber: turn.turnNumber,
      speaker: 'caller',
      text: callerSpoken,
      csi: turnCsi,
      bargeIn: turn.triggerBargeIn,
      bargeInAtMs: turn.bargeInAtMs,
      timestamp: Date.now(),
      offsetMs: callerOffset,
    };
    sessionTrace.turns.push(callerTurnRecord);

    // Call agent handler
    let agentResult;
    try {
      agentResult = await agentTurnHandler({
        callerText: callerSpoken,
        turnNumber: turn.turnNumber,
        bargeIn: turn.triggerBargeIn,
        bargeInAtMs: turn.bargeInAtMs,
        sessionTrace,
      });
    } catch (err) {
      sessionTrace.terminationReason = 'agent_error: ' + err.message;
      break;
    }

    if (agentResult) {
      const agentOffset = typeof agentResult.offsetMs === 'number'
        ? callerOffset + agentResult.offsetMs
        : callerOffset + 1400;

      const agentTurnRecord = {
        turnNumber: turn.turnNumber,
        speaker: 'agent',
        text: agentResult.spokenText || '',
        toolCalls: agentResult.toolCalls || [],
        interrupted: Boolean(agentResult.interrupted),
        hangup: Boolean(agentResult.hangup),
        timestamp: Date.now(),
        offsetMs: agentOffset,
      };
      sessionTrace.turns.push(agentTurnRecord);

      if (Array.isArray(agentResult.toolCalls)) {
        for (const tc of agentResult.toolCalls) {
          sessionTrace.toolInvocations.push(tc);
        }
      }

      if (Array.isArray(agentResult.abortedToolCalls)) {
        for (const atc of agentResult.abortedToolCalls) {
          sessionTrace.abortedToolInvocations.push(atc);
        }
      }

      lastAgentSpoken = agentResult.spokenText || '';

      if (agentResult.hangup) {
        sessionTrace.terminationReason = 'agent_hangup';
        break;
      }
    }

    turn = caller.nextTurn(lastAgentSpoken);
  }

  sessionTrace.endTime = Date.now();
  sessionTrace.durationMs = sessionTrace.endTime - sessionTrace.startTime;
  sessionTrace.completed = sessionTrace.terminationReason !== 'agent_error';

  const callerTurns = sessionTrace.turns.filter((t) => t.speaker === 'caller');
  if (callerTurns.length > 0) {
    const totalCsi = callerTurns.reduce((sum, t) => sum + (t.csi || 0), 0);
    sessionTrace.averageCsi = Number((totalCsi / callerTurns.length).toFixed(3));
  }

  return sessionTrace;
}

export {
  EPENTHESIS_DICTIONARY,
  INDIC_UN_NUMERALS,
  injectVowelEpenthesis,
  getIndicNumeralVariation,
  SyntheticCaller,
  executeScenario,
};
