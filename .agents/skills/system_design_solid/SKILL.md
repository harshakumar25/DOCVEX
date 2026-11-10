---
name: system_design_solid
description: >-
  Enforces SOLID principles, single-source-of-truth module boundaries, and zero-duplication
  system design before writing or refactoring any DocVex backend, extension, or neural audio
  worker code. Use before designing features, refactoring duplicated logic, or modifying
  the TTS/audio pipeline.
---

# DocVex System Design & SOLID Engineering Skill

Design the module boundaries, ownership, and data contracts **before** writing code. Never duplicate processing logic that has a single canonical action across server, extension, dashboard, or Python workers.

## Core Design Mandate (SOLID + DRY)

1. **Single Responsibility (SRP)**: Every module owns exactly one axis of change:
   - **Speech Text Shaping & Phonetics**: One canonical tokenizer/normalizer/sentence-buffer — never separate copies in `server/`, `extension/`, and `demo.html`.
   - **Voice Selection**: One canonical voice scorer/selector (`voiceSelector.js`) — never inline `pickBestVoice` or duplicated banlists.
   - **TTS Model Adapter (Python)**: One model-adapter hierarchy separating model loading/conditioning and synthesis parameter translation from IPC/queue orchestration.
   - **Audio Mastering & Frequency Pipeline (Python)**: One composable DSP mastering chain enforcing sample-rate consistency, reference spectral conditioning, de-mud/presence shaping, K-weighted LUFS normalization, soft-knee peak limiting, and boundary anti-click fades.
2. **Open/Closed & Liskov Substitution (OCP / LSP)**:
   - Model-specific generation arguments (`MeanFlow` `n_cfm_timesteps`, `top_k`, `norm_loudness` vs. `Standard` `exaggeration`, `cfg_weight`, `min_p`) MUST live behind a polymorphic model adapter (`SynthesisAdapter`) so adding or switching models never crashes unsupported kwargs.
   - Audio mastering stages MUST implement a uniform stage contract (`process(waveform, sr, context) -> waveform`).
3. **Interface Segregation (ISP)**:
   - Workers and adapters receive structured configuration objects (`ChatterboxSettings`, `MasteringProfile`) rather than bloated positional/keyword parameter lists duplicated across layers.
   - Public test/caller entry points keep clean, minimal signatures with backwards-compatible options where needed.
4. **Dependency Inversion (DIP)**:
   - High-level pipelines (`streamTeachPipeline`, `ChatterboxWorker`) depend on abstractions (`SynthesisAdapter`, `AudioMasteringPipeline`, config builders) rather than concrete model quirks or duplicated config key arrays.

## Mandatory Pre-Implementation Workflow

1. **Map Duplication & Coupling**: Run the duplication/architecture audit script:
   `node .agents/skills/system_design_solid/scripts/audit_duplication.mjs`
2. **Read Reference Architecture**:
   - [SOLID Architecture Checklist](./references/solid_architecture_checklist.md)
   - [DocVex Audio & Speech System Design](./references/docvex_audio_system_design.md)
3. **Specify Single-Action Modules**: Before writing a single edit, write down which file is the **single owner** of each action and how callers import/reuse it.
4. **Implement Incrementally (with `docvex_engineering`)**: One cohesive subsystem at a time, preserving all existing contracts and passing both Python and Node test suites after each step.
5. **Verify & Audit**:
   - Run `npm test` (Node test suite)
   - Run Python worker tests (`unittest discover -s chatterbox -p "test_*.py"`)
   - Run `npm run lint`
   - Re-run `node .agents/skills/system_design_solid/scripts/audit_duplication.mjs` to confirm zero regression in duplication.

