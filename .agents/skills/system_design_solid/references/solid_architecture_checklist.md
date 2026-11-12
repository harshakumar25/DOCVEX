# SOLID Architecture Checklist

## 1. Single Responsibility Principle (SRP)
- Does any file combine IPC/HTTP transport, business orchestration, and low-level DSP/string processing? Split into focused modules.
- Is any helper (`shapeSpeechText`, `normalizeSpeechText`, `SentenceBuffer`, `selectBestSpeechVoice`, `choose_device`, `load_model`) defined in more than one place? Consolidate to one canonical owner.

## 2. Open/Closed Principle (OCP)
- Does adding a new TTS model (`standard`, `turbo`, `nano`, or future models) require editing `if/elif` chains inside `synthesize()`? Encapsulate model differences in a `SynthesisAdapter` registry.
- Does adding a new Chatterbox configuration field require editing 4 files manually (`config.js`, `pipeline.js`, `chatterboxProvider.js`, `docvex_worker.py`)? Derive cache keys and CLI arg mapping from a shared `CHATTERBOX_OPTION_SPEC` / settings descriptor.

## 3. Liskov Substitution Principle (LSP)
- Can every `SynthesisAdapter` be invoked through `adapter.synthesize(text, generationOptions)` without throwing `TypeError` for model-specific kwargs? Each adapter filters/maps options to its underlying model signature cleanly.

## 4. Interface Segregation Principle (ISP)
- Avoid wide parameter lists (`pythonPath, workerPath, model, device, tempDir, voicePrompt, cfmSteps, ...`) duplicated across callers; group cohesive audio synthesis options.
- Keep DSP stage functions focused on `(waveform, sr)` transformation rather than coupling them to file I/O or JSON protocol.

## 5. Dependency Inversion Principle (DIP)
- Depend on injected providers/adapters (`chatterboxProvider`, `SynthesisAdapter`, `AudioMasteringPipeline`) in pipelines and tests.
- Never silently swallow invalid numeric env overrides (e.g. `parseFloat("0") || fallback` treats `0` as falsy). Use explicit finite-number parsers.

