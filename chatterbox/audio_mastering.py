"""Composable DSP mastering and reference-prompt conditioning for DocVex Chatterbox audio.

Follows Single Responsibility and Open/Closed principles:
  - Each DSP transformation is an independent stage with a uniform `process(waveform, sr)` method.
  - `AudioMasteringPipeline` composes stages to maintain LawBuddy-grade frequency alignment
    (canonical 24 kHz sample rate, clean vocal clarity, consistent K-weighted LUFS loudness,
    transparent soft-knee peak limiting, and click-free 5 ms Hann boundary fades).
  - `ReferenceConditioner` prevents bass-heavy reference prompts from producing muffled output.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import math
from pathlib import Path
import tempfile
from typing import Iterator, Protocol

import torch
import torchaudio as ta
import torchaudio.functional as AF

try:
    import pyloudnorm as ln
except ImportError:  # pragma: no cover - optional fallback when pyloudnorm is absent
    ln = None


CANONICAL_SAMPLE_RATE = 24000


@dataclass(frozen=True)
class MasteringProfile:
    """Immutable configuration for DocVex broadcast audio mastering."""

    target_sample_rate: int = CANONICAL_SAMPLE_RATE
    target_lufs: float = -19.0
    target_peak_db: float = -1.5
    highpass_hz: float = 85.0
    mud_threshold: float = 0.30
    mud_center_hz: float = 180.0
    mud_cut_db: float = -5.0
    presence_hz: float = 2400.0
    presence_gain_db: float = 2.5
    fade_ms: float = 5.0
    max_gain_db: float = 18.0


class AudioStage(Protocol):
    """Uniform contract for composable waveform processing stages."""

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        ...


def _ensure_mono_2d(waveform: torch.Tensor) -> torch.Tensor:
    wav = waveform.float()
    if wav.ndim == 1:
        return wav.unsqueeze(0)
    if wav.shape[0] > 1:
        return wav.mean(dim=0, keepdim=True)
    return wav


def _low_band_energy_ratio(waveform: torch.Tensor, sr: int, low_hz: float = 100.0, high_hz: float = 300.0) -> float:
    """Return fraction of total spectral power residing in [low_hz, high_hz)."""
    if waveform.shape[-1] < 64:
        return 0.0
    mono = waveform.squeeze(0)
    spec = torch.abs(torch.fft.rfft(mono))
    freqs = torch.fft.rfftfreq(mono.numel(), 1.0 / sr).to(spec.device)
    power = spec ** 2
    total = power.sum().item()
    if total <= 1e-12:
        return 0.0
    band_power = power[(freqs >= low_hz) & (freqs < high_hz)].sum().item()
    return band_power / total


class SampleRateAligner:
    """Ensures every output clip matches the canonical LawBuddy/Chatterbox frequency (24 kHz)."""

    def __init__(self, target_sr: int = CANONICAL_SAMPLE_RATE):
        self.target_sr = target_sr

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        if self.target_sr <= 0 or sr == self.target_sr or waveform.shape[-1] < 4:
            return waveform, sr
        resampled = AF.resample(waveform, orig_freq=sr, new_freq=self.target_sr)
        return resampled, self.target_sr


class HighPassFilter:
    """Removes DC offset and sub-bass proximity rumble below cutoff_hz."""

    def __init__(self, cutoff_hz: float = 85.0):
        self.cutoff_hz = cutoff_hz

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        if waveform.shape[-1] == 0:
            return waveform, sr
        wav = waveform - waveform.mean(dim=-1, keepdim=True)
        if self.cutoff_hz > 0 and wav.shape[-1] >= 16 and sr > self.cutoff_hz * 2:
            wav = AF.highpass_biquad(wav, sr, cutoff_freq=self.cutoff_hz)
        return wav, sr


class SpectralBalanceEQ:
    """Reduces low-mid boxiness/mud when excessive and adds subtle vocal presence clarity."""

    def __init__(
        self,
        mud_threshold: float = 0.30,
        mud_center_hz: float = 180.0,
        mud_cut_db: float = -5.0,
        presence_hz: float = 2400.0,
        presence_gain_db: float = 2.5,
    ):
        self.mud_threshold = mud_threshold
        self.mud_center_hz = mud_center_hz
        self.mud_cut_db = mud_cut_db
        self.presence_hz = presence_hz
        self.presence_gain_db = presence_gain_db

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        if waveform.shape[-1] < 64:
            return waveform, sr
        wav = waveform
        mud_ratio = _low_band_energy_ratio(wav, sr, 100.0, 300.0)
        if mud_ratio > self.mud_threshold and self.mud_cut_db < 0:
            wav = AF.equalizer_biquad(wav, sr, center_freq=self.mud_center_hz, gain=self.mud_cut_db, Q=0.8)
        if self.presence_gain_db != 0 and sr > self.presence_hz * 2:
            wav = AF.equalizer_biquad(wav, sr, center_freq=self.presence_hz, gain=self.presence_gain_db, Q=0.9)
        return wav, sr


class LoudnessNormalizer:
    """Normalizes active speech loudness using K-weighted LUFS (with gated RMS fallback)."""

    def __init__(self, target_lufs: float = -19.0, max_gain_db: float = 18.0):
        self.target_lufs = target_lufs
        self.max_gain_db = max_gain_db

    def _measure_loudness_db(self, waveform: torch.Tensor, sr: int) -> float | None:
        mono = waveform.squeeze(0)
        if mono.numel() < 16:
            return None

        # pyloudnorm requires > 0.4s block length for ITU-R BS.1770 gating.
        if ln is not None and mono.numel() >= int(sr * 0.45):
            try:
                lufs = float(ln.Meter(sr).integrated_loudness(mono.detach().cpu().numpy()))
                if math.isfinite(lufs):
                    return lufs
            except Exception:
                pass

        # Gated active-speech RMS fallback: ignore silent samples (< -35 dB relative to peak).
        peak = torch.max(torch.abs(mono)).item()
        if peak <= 1e-5:
            return None
        active = mono[torch.abs(mono) >= peak * (10.0 ** (-35.0 / 20.0))]
        samples = active if active.numel() > 0 else mono
        rms = torch.sqrt(torch.mean(samples ** 2)).item()
        if rms <= 1e-6:
            return None
        return 20.0 * math.log10(rms)

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        if waveform.numel() == 0:
            return waveform, sr
        loudness_db = self._measure_loudness_db(waveform, sr)
        if loudness_db is None:
            return waveform, sr
        gain_db = max(min(self.target_lufs - loudness_db, self.max_gain_db), -self.max_gain_db)
        return waveform * (10.0 ** (gain_db / 20.0)), sr


class SoftKneeLimiter:
    """Transparent soft-knee peak limiter preventing digital clipping while preserving dynamics."""

    def __init__(self, target_peak_db: float = -1.5):
        self.target_peak_db = target_peak_db

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        if waveform.numel() == 0:
            return waveform, sr
        ceiling = 10.0 ** (self.target_peak_db / 20.0)
        knee = ceiling * 0.85
        magnitude = torch.abs(waveform)
        over = magnitude > knee
        wav = waveform
        if over.any():
            headroom = max(ceiling - knee, 1e-6)
            compressed = knee + headroom * torch.tanh(torch.clamp(magnitude - knee, min=0.0) / headroom)
            wav = torch.where(over, torch.sign(waveform) * compressed, waveform)
        return torch.clamp(wav, -ceiling, ceiling), sr


class BoundaryFade:
    """Applies short Hann fade-in and fade-out to eliminate clicks between concatenated sentences."""

    def __init__(self, fade_ms: float = 5.0):
        self.fade_ms = fade_ms

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        if waveform.numel() == 0 or self.fade_ms <= 0:
            return waveform, sr
        fade_len = min(int(sr * (self.fade_ms / 1000.0)), waveform.shape[-1] // 4)
        if fade_len <= 1:
            return waveform, sr
        hann = torch.hann_window(
            fade_len * 2,
            device=waveform.device,
            dtype=waveform.dtype,
            periodic=False,
        )
        wav = waveform.clone()
        wav[..., :fade_len] *= hann[:fade_len]
        wav[..., -fade_len:] *= hann[fade_len:]
        return wav, sr


class AudioMasteringPipeline:
    """Executes an ordered sequence of AudioStage transformations."""

    def __init__(self, stages: tuple[AudioStage, ...] | list[AudioStage]):
        self.stages = tuple(stages)

    @classmethod
    def from_profile(cls, profile: MasteringProfile | None = None) -> "AudioMasteringPipeline":
        cfg = profile or MasteringProfile()
        return cls(
            stages=(
                HighPassFilter(cutoff_hz=cfg.highpass_hz),
                SpectralBalanceEQ(
                    mud_threshold=cfg.mud_threshold,
                    mud_center_hz=cfg.mud_center_hz,
                    mud_cut_db=cfg.mud_cut_db,
                    presence_hz=cfg.presence_hz,
                    presence_gain_db=cfg.presence_gain_db,
                ),
                LoudnessNormalizer(target_lufs=cfg.target_lufs, max_gain_db=cfg.max_gain_db),
                SoftKneeLimiter(target_peak_db=cfg.target_peak_db),
                SampleRateAligner(target_sr=cfg.target_sample_rate),
                BoundaryFade(fade_ms=cfg.fade_ms),
            )
        )

    def process(self, waveform: torch.Tensor, sr: int) -> tuple[torch.Tensor, int]:
        wav = _ensure_mono_2d(waveform).cpu()
        current_sr = sr
        for stage in self.stages:
            wav, current_sr = stage.process(wav, current_sr)
        return wav, current_sr


class ReferenceConditioner:
    """Conditions bass-heavy or unnormalized reference voice prompts before speaker embedding."""

    def __init__(self, mud_threshold: float = 0.35, highpass_hz: float = 90.0):
        self.mud_threshold = mud_threshold
        self.highpass_hz = highpass_hz

    @contextmanager
    def prepared_prompt(self, prompt_path: Path) -> Iterator[Path]:
        """Yield a spectrally clean prompt path, cleaning up any temporary file afterwards."""
        wav, sr = ta.load(str(prompt_path))
        wav = _ensure_mono_2d(wav)
        mud_ratio = _low_band_energy_ratio(wav, sr, 100.0, 300.0)
        sub_ratio = _low_band_energy_ratio(wav, sr, 0.0, 100.0)

        if mud_ratio <= self.mud_threshold and sub_ratio <= 0.02:
            yield prompt_path
            return

        cleaned, _ = HighPassFilter(cutoff_hz=self.highpass_hz).process(wav, sr)
        if mud_ratio > self.mud_threshold and sr > 4400:
            cleaned = AF.equalizer_biquad(cleaned, sr, center_freq=180.0, gain=-8.0, Q=0.8)
            cleaned = AF.equalizer_biquad(cleaned, sr, center_freq=2200.0, gain=4.0, Q=0.8)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            ta.save(str(tmp_path), cleaned.cpu(), sr)
            yield tmp_path
        finally:
            tmp_path.unlink(missing_ok=True)


def post_process_waveform(
    waveform: torch.Tensor,
    sr: int,
    target_peak_db: float = -1.5,
    target_lufs: float = -19.0,
    target_sample_rate: int | None = None,
    profile: MasteringProfile | None = None,
) -> torch.Tensor:
    """Master synthesized waveform with broadcast loudness, clarity EQ, soft limiting, and anti-click fades.

    Preserves backward compatibility for callers/tests supplying `target_peak_db` while supporting
    full `MasteringProfile` customization.
    """
    if waveform.numel() == 0:
        return waveform

    effective_profile = profile or MasteringProfile(
        target_sample_rate=target_sample_rate if target_sample_rate is not None else sr,
        target_lufs=target_lufs,
        target_peak_db=target_peak_db,
    )
    mastered, _ = AudioMasteringPipeline.from_profile(effective_profile).process(waveform, sr)
    return mastered

