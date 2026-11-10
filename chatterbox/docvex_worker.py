"""Long-lived local Chatterbox worker for DocVex.

Focused solely on the newline-delimited JSON control protocol, request queueing,
cancellation lifecycle, and temporary WAV output. Model loading/adaptation lives
in `model_runtime.py` and broadcast audio mastering lives in `audio_mastering.py`.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import queue
import re
import signal
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import torch
import torchaudio as ta

CHECKOUT_ROOT = Path(__file__).resolve().parent
for import_root in (CHECKOUT_ROOT, CHECKOUT_ROOT / "src"):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from audio_mastering import (  # noqa: E402
    AudioMasteringPipeline,
    CANONICAL_SAMPLE_RATE,
    MasteringProfile,
    post_process_waveform,
)
from model_runtime import (  # noqa: E402
    DEFAULT_CFM_STEPS,
    DEFAULT_REP_PENALTY,
    DEFAULT_TEMPERATURE,
    DEFAULT_TOP_K,
    DEFAULT_TOP_P,
    MODEL_NAMES,
    SynthesisAdapter,
    SynthesisConfig,
    choose_device,
    create_synthesis_adapter,
    load_model,
)

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
CONTROL_OUTPUT = sys.stdout


def write_message(message: dict[str, Any], output_lock: threading.Lock) -> None:
    with output_lock:
        CONTROL_OUTPUT.write(json.dumps(message, separators=(",", ":")) + "\n")
        CONTROL_OUTPUT.flush()


class ChatterboxWorker:
    """Thread-safe sequential synthesis worker managing queue and cancellation state."""

    def __init__(
        self,
        model_name: str,
        device: str,
        temp_dir: Path,
        synthesis_config: SynthesisConfig | None = None,
        mastering_profile: MasteringProfile | None = None,
    ):
        self.model_name = model_name
        self.device = device
        self.temp_dir = temp_dir.resolve()
        self.temp_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.output_lock = threading.Lock()
        self.requests: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.cancelled: set[str] = set()
        self.cancel_lock = threading.Lock()
        self.stopping = threading.Event()
        self.model: Any = None
        self.adapter: SynthesisAdapter | None = None
        self.synthesis_config = synthesis_config or SynthesisConfig()
        self.mastering_profile = mastering_profile or MasteringProfile()
        self.mastering_pipeline = AudioMasteringPipeline.from_profile(self.mastering_profile)

    def attach_model(self, model: Any) -> None:
        self.model = model
        try:
            self.adapter = create_synthesis_adapter(self.model_name, model)
        except ValueError:
            # Test fakes may pass arbitrary model names such as "test".
            self.adapter = None

    def is_cancelled(self, request_id: str) -> bool:
        with self.cancel_lock:
            return request_id in self.cancelled

    def cancel(self, request_id: str) -> None:
        with self.cancel_lock:
            self.cancelled.add(request_id)

    def emit_error(self, request_id: str, message: str, code: str) -> None:
        write_message(
            {"type": "error", "id": request_id, "code": code, "error": message},
            self.output_lock,
        )

    def _synthesize_waveform(self, text: str) -> torch.Tensor:
        if self.adapter is not None:
            return self.adapter.synthesize(text, self.synthesis_config)
        return self.model.generate(text.strip())

    def synthesize(self, request: dict[str, Any]) -> None:
        request_id = request["id"]
        started = time.perf_counter()
        output_path: Path | None = None

        try:
            if self.is_cancelled(request_id):
                self.emit_error(request_id, "Request was cancelled before synthesis.", "CANCELLED")
                return

            with torch.inference_mode():
                with contextlib.redirect_stdout(sys.stderr):
                    waveform = self._synthesize_waveform(request["text"])

            if self.is_cancelled(request_id):
                return
            if waveform.ndim != 2 or waveform.shape[0] != 1:
                raise RuntimeError(f"Unexpected waveform shape: {tuple(waveform.shape)}")

            waveform, output_sr = self.mastering_pipeline.process(waveform, self.model.sr)

            filename = f"{request_id}-{uuid.uuid4().hex}.wav"
            output_path = self.temp_dir / filename
            ta.save(str(output_path), waveform.detach().cpu(), output_sr)

            if self.is_cancelled(request_id):
                output_path.unlink(missing_ok=True)
                return

            duration = waveform.shape[-1] / output_sr
            write_message(
                {
                    "type": "audio",
                    "id": request_id,
                    "file": filename,
                    "sample_rate": output_sr,
                    "duration_seconds": duration,
                    "generated_audio_available_seconds": time.perf_counter() - started,
                },
                self.output_lock,
            )
        except Exception as exc:
            if output_path:
                output_path.unlink(missing_ok=True)
            if not self.is_cancelled(request_id):
                self.emit_error(request_id, str(exc), "SYNTHESIS_FAILED")
        finally:
            with self.cancel_lock:
                self.cancelled.discard(request_id)
            if self.device == "mps" and hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                torch.mps.empty_cache()
            elif self.device == "cuda" and hasattr(torch, "cuda") and hasattr(torch.cuda, "empty_cache"):
                torch.cuda.empty_cache()

    def run(self) -> None:
        while not self.stopping.is_set():
            request = self.requests.get()
            if request is None:
                return
            self.synthesize(request)

    def submit(self, request: dict[str, Any]) -> None:
        self.requests.put(request)

    def stop(self) -> None:
        if not self.stopping.is_set():
            self.stopping.set()
            self.requests.put(None)


def validate_request(message: Any) -> tuple[str, dict[str, Any] | None, str | None]:
    if not isinstance(message, dict):
        return "", None, "Control message must be a JSON object."

    request_id = message.get("id")
    if not isinstance(request_id, str) or not REQUEST_ID_PATTERN.fullmatch(request_id):
        return "", None, "Request id is invalid."

    message_type = message.get("type")
    if message_type == "synthesize":
        text = message.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            return request_id, None, "Synthesis text must be a non-empty string of at most 2000 characters."
        return request_id, {"id": request_id, "type": "synthesize", "text": text}, None

    if message_type in {"cancel", "shutdown"}:
        return request_id, {"id": request_id, "type": message_type}, None

    return request_id, None, "Unsupported worker message type."


def run_worker(
    model_name: str,
    device: str,
    temp_dir: Path,
    voice_prompt: Path | None = None,
    synthesis_config: SynthesisConfig | None = None,
    mastering_profile: MasteringProfile | None = None,
) -> None:
    output_lock = threading.Lock()
    worker = ChatterboxWorker(
        model_name,
        device,
        temp_dir,
        synthesis_config=synthesis_config,
        mastering_profile=mastering_profile,
    )

    try:
        load_started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            model = load_model(model_name, device, voice_prompt_path=voice_prompt)
            worker.attach_model(model)
        write_message(
            {
                "type": "ready",
                "model": model_name,
                "device": device,
                "sample_rate": worker.mastering_profile.target_sample_rate,
                "load_seconds": time.perf_counter() - load_started,
                "temp_dir": str(worker.temp_dir),
                "native_incremental_generation": False,
            },
            output_lock,
        )
    except Exception as exc:
        write_message({"type": "error", "id": "startup", "code": "LOAD_FAILED", "error": str(exc)}, output_lock)
        return

    synthesis_thread = threading.Thread(target=worker.run, name="docvex-chatterbox", daemon=True)
    synthesis_thread.start()

    def handle_signal(_signum: int, _frame: Any) -> None:
        worker.stop()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        for line in sys.stdin:
            if worker.stopping.is_set():
                break
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                write_message({"type": "error", "id": "control", "code": "INVALID_JSON", "error": str(exc)}, output_lock)
                continue

            request_id, request, error = validate_request(message)
            if error:
                write_message({"type": "error", "id": request_id or "control", "code": "INVALID_REQUEST", "error": error}, output_lock)
                continue
            if request["type"] == "synthesize":
                worker.submit(request)
            elif request["type"] == "cancel":
                worker.cancel(request_id)
                write_message({"type": "cancelled", "id": request_id}, output_lock)
            elif request["type"] == "shutdown":
                worker.stop()
                break
    finally:
        worker.stop()
        synthesis_thread.join(timeout=5)
        for output_path in worker.temp_dir.glob("*.wav"):
            output_path.unlink(missing_ok=True)
        try:
            worker.temp_dir.rmdir()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=MODEL_NAMES, required=True)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    parser.add_argument("--temp-dir", type=Path, default=Path(tempfile.gettempdir()) / "docvex-chatterbox")
    parser.add_argument("--voice-prompt", type=Path, default=None)
    parser.add_argument("--cfm-steps", type=int, default=DEFAULT_CFM_STEPS)
    parser.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--top-p", type=float, default=DEFAULT_TOP_P)
    parser.add_argument("--rep-penalty", type=float, default=DEFAULT_REP_PENALTY)
    parser.add_argument("--target-sr", type=int, default=CANONICAL_SAMPLE_RATE)
    parser.add_argument("--target-lufs", type=float, default=-19.0)
    args = parser.parse_args()

    synthesis_config = SynthesisConfig(
        cfm_steps=max(1, args.cfm_steps),
        temperature=args.temperature,
        top_k=args.top_k,
        top_p=args.top_p,
        repetition_penalty=args.rep_penalty,
    )
    mastering_profile = MasteringProfile(
        target_sample_rate=max(8000, args.target_sr),
        target_lufs=args.target_lufs,
    )
    run_worker(
        args.model,
        choose_device(args.device),
        args.temp_dir,
        voice_prompt=args.voice_prompt,
        synthesis_config=synthesis_config,
        mastering_profile=mastering_profile,
    )


if __name__ == "__main__":
    main()
