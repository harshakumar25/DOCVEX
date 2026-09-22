"""Benchmark the checked-out Chatterbox models for DocVex.

Run one model per process for a meaningful cold-load measurement:

    .venv/bin/python benchmark_docvex.py --model standard --runs 3
    .venv/bin/python benchmark_docvex.py --model turbo --runs 3
    .venv/bin/python benchmark_docvex.py --model nano --runs 3

The generated JSON is evidence for model selection, not a claim about audio
quality. Record human listening observations alongside the result files.
"""

from __future__ import annotations

import argparse
import gc
import json
import platform
import resource
import sys
import time
from pathlib import Path
from typing import Any

import torch
import torchaudio as ta

CHECKOUT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(CHECKOUT_ROOT / "src"))


SENTENCES = (
    "Kubernetes describes the state you want and continuously works to make reality match that state.",
    "A hash table usually provides constant average-time lookup by mapping a key to a bucket.",
    "The browser sends an HTTP request, and the server returns a response with a status code and a body.",
)


def choose_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def max_rss_bytes() -> int:
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(usage if platform.system() == "Darwin" else usage * 1024)


def mps_memory() -> int | None:
    if not hasattr(torch, "mps") or not torch.backends.mps.is_available():
        return None
    return int(torch.mps.current_allocated_memory())


def load_model(model_name: str, device: str) -> Any:
    if model_name == "standard":
        from chatterbox.tts import ChatterboxTTS

        return ChatterboxTTS.from_pretrained(device=device)
    if model_name in {"turbo", "nano"}:
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        return ChatterboxTurboTTS.from_pretrained(device=device, nano=model_name == "nano")
    raise ValueError(f"Unknown model: {model_name}")


def benchmark(model_name: str, device: str, runs: int, output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rss_before = max_rss_bytes()
    mps_before = mps_memory()

    load_started = time.perf_counter()
    model = load_model(model_name, device)
    load_seconds = time.perf_counter() - load_started

    results: list[dict[str, Any]] = []
    for sentence_index, sentence in enumerate(SENTENCES, start=1):
        sentence_runs = []
        for run_index in range(1, runs + 1):
            started = time.perf_counter()
            with torch.inference_mode():
                waveform = model.generate(sentence)
            elapsed = time.perf_counter() - started

            if waveform.ndim != 2 or waveform.shape[0] != 1:
                raise RuntimeError(
                    f"{model_name} returned unexpected waveform shape: {tuple(waveform.shape)}"
                )

            audio_seconds = waveform.shape[-1] / model.sr
            output_path = output_dir / f"{model_name}-sentence-{sentence_index}-run-{run_index}.wav"
            ta.save(str(output_path), waveform.cpu(), model.sr)
            sentence_runs.append(
                {
                    "run": run_index,
                    "generated_audio_available_seconds": elapsed,
                    "audio_duration_seconds": audio_seconds,
                    "real_time_factor": elapsed / audio_seconds if audio_seconds else None,
                    "sample_rate": model.sr,
                    "audio_path": str(output_path),
                    "rss_bytes": max_rss_bytes(),
                    "mps_allocated_bytes": mps_memory(),
                }
            )

        results.append(
            {
                "sentence": sentence,
                "runs": sentence_runs,
            }
        )

    evidence = {
        "model": model_name,
        "device": device,
        "python": platform.python_version(),
        "torch": torch.__version__,
        "mps_available": bool(torch.backends.mps.is_available()),
        "cold_load_seconds": load_seconds,
        "rss_before_bytes": rss_before,
        "rss_after_bytes": max_rss_bytes(),
        "mps_before_bytes": mps_before,
        "mps_after_bytes": mps_memory(),
        "runs_per_sentence": runs,
        "sentences": results,
        "native_incremental_generation_verified": False,
        "quality_observations_required": [
            "pronunciation",
            "intelligibility",
            "stability",
            "voice_naturalness",
            "technical_term_handling",
        ],
        "notes": (
            "The checked-out public TTS wrappers expose synchronous generate() methods. "
            "Do not interpret generated_audio_available_seconds as native streaming."
        ),
    }
    evidence_path = output_dir / f"{model_name}-benchmark.json"
    evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    return evidence


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=("standard", "turbo", "nano"), required=True)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "mps", "cuda"))
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output-dir", type=Path, default=Path("benchmark-results"))
    args = parser.parse_args()

    if args.runs < 2:
        parser.error("--runs must be at least 2 for repeated evidence")

    device = choose_device(args.device)
    print(json.dumps({"model": args.model, "device": device, "status": "loading"}), flush=True)
    try:
        evidence = benchmark(args.model, device, args.runs, args.output_dir)
    finally:
        gc.collect()
        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()

    print(
        json.dumps(
            {
                "model": evidence["model"],
                "device": evidence["device"],
                "cold_load_seconds": evidence["cold_load_seconds"],
                "output": str(args.output_dir / f"{args.model}-benchmark.json"),
                "status": "complete",
            }
        )
    )


if __name__ == "__main__":
    main()
