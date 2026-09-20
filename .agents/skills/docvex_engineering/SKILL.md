---
name: docvex_engineering
description: Incremental, verified, production-quality engineering workflow for DocVex.
---

# DocVex Engineering Skill

## Feature Development Loop
1. **Plan Feature**: Specify exact functional objective and scope.
2. **Implement Feature**: Minimal, clean code required for this single feature.
3. **Execute & Test**: Run automated tests and manual verification.
4. **Audit**:
   - Hardcode audit (check for hardcoded keys, model names, URLs, magic numbers).
   - Junk/Unused code audit (remove unused variables, commented code, debugging statements).
   - Security audit (check input validation, secret leakage, HTML/code sanitization).
5. **Report**: Output the structured Feature Report before proceeding to the next feature.
