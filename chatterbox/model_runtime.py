"""Shared Chatterbox device resolution, model loading, and polymorphic synthesis adapters.

Single canonical owner of:
  - `choose_device(requested)`
  - `resolve_voice_prompt(explicit_path, voices_dir)`
  - `load_model(model_name, device, voice_prompt_path=None)`
  - `SynthesisAdapter` hierarchy (`StandardSynthesisAdapter`, `MeanFlowSynthesisAdapter`)
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any, Protocol

import torch

from audio_mastering import ReferenceConditioner


CHECKOUT_ROOT = Path(__file__).resolve().parent
SRC_ROOT = CHECKOUT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

MODEL_NAMES = ("standard", "turbo", "nano")

# Quality defaults tuned for MeanFlow (turbo/nano) & Standard Chatterbox broadcast output.
DEFAULT_CFM_STEPS = 8
DEFAULT_TEMPERATURE = 0.65
DEFAULT_TOP_K = 500
DEFAULT_TOP_P = 0.90
DEFAULT_REP_PENALTY = 1.3

# Preferred bundled voice references ordered by clean broadcast spectral balance.
DEFAULT_VOICE_CANDIDATES = (
    "human_male_narrator.wav",
    "studio_male_voiceover.wav",
)


@dataclass(frozen=True)
class SynthesisConfig:
    """Cohesive inference parameters passed to a SynthesisAdapter."""

    cfm_steps: int = DEFAULT_CFM_STEPS
    temperature: float = DEFAULT_TEMPERATURE
    top_k: int = DEFAULT_TOP_K
    top_p: float = DEFAULT_TOP_P
    repetition_penalty: float = DEFAULT_REP_PENALTY
    exaggeration: float = 0.5
    cfg_weight: float = 0.5
    min_p: float = 0.05
    norm_loudness: bool = True


class SynthesisAdapter(Protocol):
    """Liskov-substitutable synthesis contract hiding model-specific kwargs."""

    def synthesize(self, text: str, config: SynthesisConfig) -> torch.Tensor:
        ...


class StandardSynthesisAdapter:
    """Adapter for standard ChatterboxTTS (supports exaggeration/cfg_weight/min_p; no top_k/cfm)."""

    def __init__(self, model: Any):
        self.model = model

    def synthesize(self, text: str, config: SynthesisConfig) -> torch.Tensor:
        return self.model.generate(
            text.strip(),
            temperature=config.temperature,
            top_p=config.top_p,
            min_p=config.min_p,
            exaggeration=config.exaggeration,
            cfg_weight=config.cfg_weight,
            repetition_penalty=config.repetition_penalty,
        )


class MeanFlowSynthesisAdapter:
    """Adapter for distilled MeanFlow ChatterboxTurboTTS ('turbo' and 'nano')."""

    def __init__(self, model: Any):
        self.model = model

    def synthesize(self, text: str, config: SynthesisConfig) -> torch.Tensor:
        return self.model.generate(
            text.strip(),
            n_cfm_timesteps=config.cfm_steps,
            norm_loudness=config.norm_loudness,
            temperature=config.temperature,
            top_k=config.top_k,
            top_p=config.top_p,
            repetition_penalty=config.repetition_penalty,
        )


def create_synthesis_adapter(model_name: str, model: Any) -> SynthesisAdapter:
    """Factory returning the appropriate SynthesisAdapter for the configured model family."""
    if model_name == "standard":
        return StandardSynthesisAdapter(model)
    if model_name in {"turbo", "nano"}:
        return MeanFlowSynthesisAdapter(model)
    raise ValueError(f"Unsupported Chatterbox model: {model_name}")


def choose_device(requested: str = "auto") -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def resolve_voice_prompt(
    voice_prompt_path: Path | None = None,
    voices_dir: Path | None = None,
) -> Path | None:
    if voice_prompt_path is not None:
        return Path(voice_prompt_path)
    base_dir = voices_dir or (CHECKOUT_ROOT / "voices")
    for candidate in DEFAULT_VOICE_CANDIDATES:
        candidate_path = base_dir / candidate
        if candidate_path.exists():
            return candidate_path
    return None


def load_model(
    model_name: str,
    device: str,
    voice_prompt_path: Path | None = None,
    prepare_voice: bool = True,
    conditioner: ReferenceConditioner | None = None,
) -> Any:
    """Load the requested Chatterbox model once and optionally condition its reference voice."""
    if model_name == "standard":
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_pretrained(device=device)
    elif model_name in {"turbo", "nano"}:
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        model = ChatterboxTurboTTS.from_pretrained(device=device, nano=model_name == "nano")
    else:
        raise ValueError(f"Unsupported Chatterbox model: {model_name}")

    if not prepare_voice:
        return model

    ref_voice = resolve_voice_prompt(voice_prompt_path)
    if ref_voice is not None and ref_voice.exists():
        active_conditioner = conditioner or ReferenceConditioner()
        try:
            with active_conditioner.prepared_prompt(ref_voice) as clean_prompt:
                with contextlib.redirect_stdout(sys.stderr):
                    model.prepare_conditionals(str(clean_prompt))
        except Exception as exc:
            sys.stderr.write(f"[Chatterbox Worker] Warning: failed to prepare reference voice {ref_voice}: {exc}\n")

    return model

