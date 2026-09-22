"""Long-lived local Chatterbox worker for DocVex.

The worker uses newline-delimited JSON for control messages. Generated audio
is written to a dedicated temporary directory and only controlled metadata is
returned. The configured model is loaded once at startup.
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
sys.path.insert(0, str(CHECKOUT_ROOT / "src"))

REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
MODEL_NAMES = ("standard", "turbo", "nano")
CONTROL_OUTPUT = sys.stdout


def write_message(message: dict[str, Any], output_lock: threading.Lock) -> None:
    with output_lock:
        CONTROL_OUTPUT.write(json.dumps(message, separators=(",", ":")) + "\n")
        CONTROL_OUTPUT.flush()


def choose_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(model_name: str, device: str) -> Any:
    if model_name == "standard":
        from chatterbox.tts import ChatterboxTTS

        return ChatterboxTTS.from_pretrained(device=device)
    if model_name in {"turbo", "nano"}:
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        return ChatterboxTurboTTS.from_pretrained(device=device, nano=model_name == "nano")
    raise ValueError(f"Unsupported Chatterbox model: {model_name}")


class ChatterboxWorker:
    def __init__(self, model_name: str, device: str, temp_dir: Path):
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
                    waveform = self.model.generate(request["text"].strip())

            if self.is_cancelled(request_id):
                return
            if waveform.ndim != 2 or waveform.shape[0] != 1:
                raise RuntimeError(f"Unexpected waveform shape: {tuple(waveform.shape)}")

            filename = f"{request_id}-{uuid.uuid4().hex}.wav"
            output_path = self.temp_dir / filename
            ta.save(str(output_path), waveform.detach().cpu(), self.model.sr)

            if self.is_cancelled(request_id):
                output_path.unlink(missing_ok=True)
                return

            duration = waveform.shape[-1] / self.model.sr
            write_message(
                {
                    "type": "audio",
                    "id": request_id,
                    "file": filename,
                    "sample_rate": self.model.sr,
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


def run_worker(model_name: str, device: str, temp_dir: Path) -> None:
    output_lock = threading.Lock()
    worker = ChatterboxWorker(model_name, device, temp_dir)

    try:
        load_started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            worker.model = load_model(model_name, device)
        write_message(
            {
                "type": "ready",
                "model": model_name,
                "device": device,
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
    args = parser.parse_args()
    run_worker(args.model, choose_device(args.device), args.temp_dir)


if __name__ == "__main__":
    main()
