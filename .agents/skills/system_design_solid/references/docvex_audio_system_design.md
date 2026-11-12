# DocVex Audio & Speech Pipeline System Design

## 1. Frequency & Acoustic Quality Contract (LawBuddy Parity)

- **Canonical Sample Rate**: `24000 Hz` (`S3GEN_SR`), matching LawBuddy (`/lawbuddy/teach` Chatterbox clips & Sarvam `speech_sample_rate: 24000`). If any model or prompt differs, resample cleanly once at the boundary (`torchaudio.functional.resample`) so downstream clients always receive deterministic `24000 Hz` mono WAV.
- **Spectral Clarity Envelope**:
  - Remove DC offset & sub-bass proximity rumble (`highpass_biquad` @ `85 Hz`).
  - Prevent bass-heavy reference mud (`studio_male_voiceover.wav` has ~76% energy `< 300 Hz` vs ~11% in clean broadcast speech like `human_male_narrator.wav` / official `conds.pt`): condition bass-heavy voice prompts *before* `prepare_conditionals()` and balance output mud/presence (`180 Hz` de-mud cut when low-band energy exceeds threshold + `2400 Hz` vocal presence clarity lift).
- **Broadcast Loudness & Dynamics**:
  - Measure active loudness with K-weighted LUFS (`pyloudnorm`, fallback to active-speech gated RMS so leading/trailing silence never over-boosts quiet clips).
  - Target `-19.0 LUFS` for clear, consistent sentence-to-sentence playback volume.
  - Apply a transparent soft-knee peak limiter at `-1.5 dBFS` (`<= 0.8414` linear) — never a hard clamp that crushes dynamics.
  - Apply 5ms Hann fade-in / fade-out at chunk boundaries to eliminate clicks in `offscreen.js` / LawBuddy playback.

## 2. Single-Source-of-Truth Module Map

### Python Neural Audio Subsystem (`chatterbox/`)
- `chatterbox/audio_mastering.py` (SRP):
  - `MasteringProfile` dataclass
  - `ReferenceConditioner`: analyzes & cleans bass-heavy reference voice prompts before `prepare_conditionals`
  - `AudioMasteringPipeline`: composable stages (`HighPassFilter`, `SpectralBalanceEQ`, `LoudnessNormalizer`, `SoftKneeLimiter`, `SampleRateAligner`, `BoundaryFade`)
  - `post_process_waveform(...)`: clean public facade maintaining backwards compatibility with `target_peak_db` and `target_lufs`.
- `chatterbox/model_runtime.py` (OCP / LSP / DRY):
  - Shared `choose_device()` and `load_model()` used by **both** `docvex_worker.py` and `benchmark_docvex.py` (eliminates duplication).
  - `SynthesisAdapter` base + `StandardSynthesisAdapter` + `MeanFlowSynthesisAdapter` (`turbo`/`nano`) so model-specific kwargs (`n_cfm_timesteps`, `top_k`, `norm_loudness` vs `exaggeration`, `cfg_weight`, `min_p`) are never misrouted.
- `chatterbox/docvex_worker.py` (SRP):
  - Pure IPC protocol, worker queue/cancellation lifecycle, and temp-file emission delegating model synthesis to `SynthesisAdapter` and DSP to `AudioMasteringPipeline`.

### Shared JavaScript Speech & Voice Domain (`extension/` + Server Re-Exports)
- `extension/speechCore.js`: Single canonical implementation of `NON_TERMINATING_ABBREVIATIONS`, `shapeSpeechText`, `isFalseBoundary`, `classifyPause`, `SentenceBuffer`, `DEFAULT_SPEECH_DICTIONARY`, `normalizeSpeechText`.
  - Imported directly by `server/prompt/*` (thin re-exports for backward-compatible server imports), `extension/speechNormalization.js`, `extension/content.js` (via Chrome MV3 `web_accessible_resources` dynamic `import()`), and served via `/assets/speechCore.js`.
- `extension/voiceSelector.js`: Single canonical voice selector reused by `extension/content.js`, `demo.html` (via static route `/assets/voiceSelector.js`), and `@docvex/lawbuddy`.

### Server Configuration & Provider DIP (`server/`)
- `server/config.js`: Explicit numeric parsers (`parsePositiveInteger`, `parseFiniteFloat`, `parseClampedFloat`) + single `CHATTERBOX_ARG_SPEC` descriptor mapping config keys to CLI flags and provider cache keys (eliminating manual drift between `config.js`, `pipeline.js`, and `chatterboxProvider.js`).

