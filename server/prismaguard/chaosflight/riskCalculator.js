/**
 * RiskCalculator: Actuarial Non-Compliance Risk Index (NRI) & TRAI 21A Blacklist Predictor
 *
 * Implements:
 * 1. TRAI Regulation 21A Cross-Operator Blacklisting Poisson Probability Model:
 *    Predicts the likelihood of accumulating >= 3 formal DND complaints in 10 days.
 * 2. Non-Compliance Risk Index (NRI) composite scoring (0.0 - 100.0 scale).
 * 3. Projected Violations per 1,000 Outbound Calls.
 *
 * Zero external NPM dependencies. Adheres strictly to SOLID single-responsibility.
 */

/**
 * Calculates Poisson cumulative probability P(K >= threshold) for complaint accumulation.
 * Under TRAI Regulation 21A, threshold is 3 complaints in 10 days.
 *
 * @param {number} lambda - Expected complaints over campaign period (N * violationRate * complaintPropensity)
 * @param {number} [threshold=3] - Critical complaint threshold
 * @returns {number} Probability between 0.0 and 1.0
 */
function calculatePoissonBlacklistProbability(lambda, threshold = 3) {
  if (lambda <= 0) return 0.0;
  if (lambda > 50) return 1.0;

  // P(K < threshold) = sum_{k=0}^{threshold - 1} (e^-lambda * lambda^k / k!)
  let sumLess = 0;
  for (let k = 0; k < threshold; k++) {
    let term = Math.exp(-lambda);
    for (let i = 1; i <= k; i++) {
      term *= lambda / i;
    }
    sumLess += term;
  }

  const pAtLeast = 1 - sumLess;
  return Math.max(0.0, Math.min(1.0, Number(pAtLeast.toFixed(4))));
}

/**
 * Computes the Non-Compliance Risk Index (NRI) and TRAI 21A Blacklist Exposure.
 *
 * @param {Object} assertionsSummary - Summary of assertion results from ChaosFlight
 * @param {Object} [campaignParams] - Campaign scale parameters
 * @param {number} [campaignParams.callVolume=10000] - Planned 10-day call volume
 * @param {number} [campaignParams.complaintPropensity=0.04] - Est. 4% complaint rate per violation
 * @returns {Object} Comprehensive actuarial risk assessment
 */
function computeActuarialRisk(assertionsSummary = {}, {
  callVolume = 10000,
  complaintPropensity = 0.04,
} = {}) {
  // Extract individual assertion states
  const ttdPassed = assertionsSummary.timeToTeardown?.passed ?? true;
  const thirdPartyPassed = assertionsSummary.thirdPartyDebtDisclosure?.passed ?? true;
  const dpdpPassed = assertionsSummary.dpdpCleartextPii?.passed ?? true;
  const rbiWindowPassed = assertionsSummary.rbiCallingWindow?.passed ?? true;
  const schemaPassed = assertionsSummary.openApiSchemaMatch?.passed ?? true;
  const staleToolPassed = assertionsSummary.atomicBargeInAudit?.passed ?? true;

  // 1. Calculate Non-Compliance Risk Index (NRI) [0 - 100]
  // Weighted actuarial penalties:
  // - TRAI TTD Failure: 35 points (direct UCC / spam flag trigger)
  // - Third-Party Debt Leak: 25 points (RBI lending license risk)
  // - DPDP Cleartext PII Leak: 20 points (statutory penalty up to ₹250 Cr)
  // - RBI Calling Hours Window: 10 points (Fair Practices Code breach)
  // - Schema / Stale Tool Mutation: 10 points (financial reconciliation error)
  let nriScore = 0;
  const violationCategories = [];

  if (!ttdPassed) {
    nriScore += 35;
    violationCategories.push('TRAI_REG_21A_TEARDOWN_OVERRUN');
  }
  if (!thirdPartyPassed) {
    nriScore += 25;
    violationCategories.push('RBI_THIRD_PARTY_DEBT_DISCLOSURE');
  }
  if (!dpdpPassed) {
    nriScore += 20;
    violationCategories.push('DPDP_CLEARTEXT_PII_LEAK');
  }
  if (!rbiWindowPassed) {
    nriScore += 10;
    violationCategories.push('RBI_CALLING_WINDOW_BREACH');
  }
  if (!schemaPassed || !staleToolPassed) {
    nriScore += 10;
    violationCategories.push('CORE_BANKING_SCHEMA_MUTATION_ERROR');
  }

  nriScore = Math.min(100, nriScore);

  // 2. Projected Violations per 1,000 Outbound Calls
  // Base rate is derived from active failure weights
  const violationRate = nriScore / 100; // 0.0 to 1.0
  const violationsPer1000 = Number((violationRate * 1000).toFixed(1));

  // 3. Expected complaints over campaign call volume
  const expectedComplaints = callVolume * violationRate * complaintPropensity;

  // 4. TRAI Regulation 21A Blacklist Probability (>= 3 complaints in 10 days)
  const blacklistProbability = calculatePoissonBlacklistProbability(expectedComplaints, 3);

  // 5. Categorical Risk Tier
  let riskTier = 'MINIMAL_RISK';
  if (blacklistProbability >= 0.15 || nriScore >= 35) {
    riskTier = 'CRITICAL_BLACKLIST_IMMINENT';
  } else if (blacklistProbability >= 0.03 || nriScore >= 15) {
    riskTier = 'ELEVATED_REGULATORY_EXPOSURE';
  }

  return {
    nonComplianceRiskIndex: nriScore,
    riskScore: nriScore,
    riskTier,
    violationsPer1000,
    expected10DayComplaints: Number(expectedComplaints.toFixed(2)),
    trai21aBlacklistProbability: blacklistProbability,
    blacklistProbability,
    trai21aBlacklistPct: Number((blacklistProbability * 100).toFixed(2)),
    campaignCallVolume: callVolume,
    activeViolations: violationCategories,
    productionCertified: nriScore === 0 && blacklistProbability < 0.01,
  };
}

export {
  calculatePoissonBlacklistProbability,
  computeActuarialRisk,
};

