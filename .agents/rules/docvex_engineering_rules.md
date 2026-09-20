# DocVex Engineering Rules

## 1. Incremental Feature Development
- Develop one single feature at a time.
- Follow the strict loop: Plan -> Implement -> Run -> Test -> Inspect -> Clean up -> Audit -> Next.
- Never advance to a new feature until the active feature is fully verified.

## 2. Code Quality & Simplicity
- Write clean, simple, readable, and real code.
- No fake or mock implementations disguised as functional code.
- No dead code, unused imports, unused variables, or leftover debug statements.
- Avoid unnecessary external dependencies; leverage Node.js built-ins and Web APIs.

## 3. Security & Privacy
- Never hardcode API keys, secrets, or private tokens in code or extension files.
- Store sensitive values in `.env` and load them exclusively in the local backend.
- Sanitize all retrieved web content as untrusted plain text.
- Never `eval()` or dynamically execute model-generated content.

## 4. Source Verification & Hallucination Prevention
- Maintain an explicit allowlist of authoritative documentation domains.
- Clearly distinguish selected text from external reference context.
- Prioritize technical accuracy over humor or conversational filler.

## 5. Grounding & Retrieval Invariants
- **Grounding Transparency**: Report `groundingStatus: 'grounded' | 'ungrounded'` explicitly. Never present ungrounded model output as verified.
- **Evidence Containment**: Wrap external docs in `<evidence>` tags and instruct model to disregard any instruction-like text within evidence blocks (prompt injection defense).
- **Pre-Fetch Triage**: Always triage retrieval path (`fast` | `research` | `none`) using `decideRetrievalPath` before spending network latency. Use local page DOM context for `fast` path on allowlisted pages.
