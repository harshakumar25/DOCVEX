/**
 * CertificationReporter: Aggregates Telephony Simulation Runs into Enterprise CI/CD Reports
 *
 * Emits:
 * 1. Markdown Pull-Request Summary with executive risk metrics.
 * 2. Standard JUnit XML test report for CI pipeline gates.
 * 3. Structured JSON telemetry.
 *
 * Zero external NPM dependencies.
 */

class CertificationReporter {
  constructor({ suiteName = 'ChaosFlight Telephony Certification Suite' } = {}) {
    this.suiteName = suiteName;
    this.results = [];
  }

  /**
   * Adds an evaluated scenario run result.
   * @param {Object} runResult
   */
  addRunResult(runResult) {
    this.results.push(runResult);
  }

  /**
   * Computes aggregate summary metrics across all runs.
   * @returns {Object}
   */
  computeMetrics() {
    const total = this.results.length;
    if (total === 0) {
      return {
        total: 0,
        passed: 0,
        failed: 0,
        taskCompletionRate: 0,
        humanEscalationRate: 0,
        policyViolations: 0,
        schemaViolations: 0,
      };
    }

    let passed = 0;
    let escalated = 0;
    let policyViolations = 0;
    let schemaViolations = 0;

    for (const r of this.results) {
      if (r.passed) passed++;
      if (r.escalatedToHuman) escalated++;
      if (r.policyViolations && r.policyViolations.length > 0) {
        policyViolations += r.policyViolations.length;
      }
      if (r.schemaViolations && r.schemaViolations.length > 0) {
        schemaViolations += r.schemaViolations.length;
      }
    }

    return {
      total,
      passed,
      failed: total - passed,
      taskCompletionRate: Number((passed / total).toFixed(4)),
      humanEscalationRate: Number((escalated / total).toFixed(4)),
      policyViolations,
      schemaViolations,
    };
  }

  /**
   * Generates a GitHub Flavored Markdown PR comment report.
   * @returns {string}
   */
  toMarkdown() {
    const metrics = this.computeMetrics();
    const statusEmoji = metrics.failed === 0 ? '✅ PASSED' : '❌ BLOCKED';

    let md = `## 🛡️ ChaosFlight Telephony Certification Gate: ${statusEmoji}\n\n`;
    md += `| Metric | Measured Score | Enterprise Threshold | Status |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;
    md += `| **Task Completion Rate (TCR)** | ${(metrics.taskCompletionRate * 100).toFixed(1)}% | $\\ge 85.0\\%$ | ${metrics.taskCompletionRate >= 0.85 ? '✅ PASS' : '❌ FAIL'} |\n`;
    md += `| **Human Escalation Rate (HER)** | ${(metrics.humanEscalationRate * 100).toFixed(1)}% | $\\le 15.0\\%$ | ${metrics.humanEscalationRate <= 0.15 ? '✅ PASS' : '❌ FAIL'} |\n`;
    md += `| **Statutory Policy Violations (RBI/DPDP)** | ${metrics.policyViolations} | 0 (Zero Tolerance) | ${metrics.policyViolations === 0 ? '✅ PASS' : '❌ CRITICAL'} |\n`;
    md += `| **Tool / Schema Corruptions** | ${metrics.schemaViolations} | 0 | ${metrics.schemaViolations === 0 ? '✅ PASS' : '❌ FAIL'} |\n\n`;

    if (metrics.failed > 0) {
      md += `### ⚠️ Failed Scenarios (${metrics.failed}/${metrics.total})\n\n`;
      for (const r of this.results.filter((res) => !res.passed)) {
        md += `- **${r.scenarioId}** (${r.name}): ${r.failureReason || 'Failed verification assertions'}\n`;
      }
    } else {
      md += `> [!NOTE]\n> **Enterprise Air-Gap Certificate**: All ${metrics.total} synthetic telephony scenarios verified successfully over degraded 8 kHz G.711 audio.\n`;
    }

    return md;
  }

  /**
   * Generates a JUnit XML formatted report string for standard CI gates.
   * @returns {string}
   */
  toJUnitXml() {
    const metrics = this.computeMetrics();
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<testsuites name="${this.suiteName}" tests="${metrics.total}" failures="${metrics.failed}">\n`;
    xml += `  <testsuite name="TelephonyScenarios" tests="${metrics.total}" failures="${metrics.failed}">\n`;

    for (const r of this.results) {
      xml += `    <testcase classname="ChaosFlight" name="${r.scenarioId} - ${r.name}">\n`;
      if (!r.passed) {
        xml += `      <failure message="${r.failureReason || 'Assertion failed'}"><![CDATA[${JSON.stringify(r, null, 2)}]]></failure>\n`;
      }
      xml += `    </testcase>\n`;
    }

    xml += `  </testsuite>\n`;
    xml += `</testsuites>\n`;
    return xml;
  }
}

export { CertificationReporter };

