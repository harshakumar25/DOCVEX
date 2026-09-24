import tempfile
import threading
import time
import unittest
from pathlib import Path

import torch

import docvex_worker
from docvex_worker import ChatterboxWorker, validate_request


class FakeModel:
    sr = 24000

    def generate(self, _text):
        time.sleep(0.02)
        return torch.zeros(1, self.sr // 10)


class WorkerProtocolTests(unittest.TestCase):
    def test_validate_request(self):
        request_id, request, error = validate_request(
            {"type": "synthesize", "id": "request-1", "text": "Hello."}
        )
        self.assertEqual(request_id, "request-1")
        self.assertIsNone(error)
        self.assertEqual(request["type"], "synthesize")

        _, _, error = validate_request(
            {"type": "synthesize", "id": "request 1", "text": "Hello."}
        )
        self.assertIsNotNone(error)

    def test_cancelled_queued_request_does_not_create_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            output = []
            original_write_message = docvex_worker.write_message
            docvex_worker.write_message = lambda message, _lock: output.append(message)
            worker = ChatterboxWorker("test", "cpu", Path(directory))
            worker.model = FakeModel()
            worker.output_lock = threading.Lock()

            try:
                thread = threading.Thread(target=worker.run)
                thread.start()
                worker.submit({"id": "active", "type": "synthesize", "text": "Active sentence."})
                worker.submit({"id": "stale", "type": "synthesize", "text": "Stale sentence."})
                worker.cancel("stale")

                deadline = time.time() + 2
                while not output and time.time() < deadline:
                    time.sleep(0.01)
                worker.stop()
                thread.join(timeout=2)

                audio_messages = [message for message in output if message.get("type") == "audio"]
                self.assertEqual(len(audio_messages), 1)
                self.assertEqual(audio_messages[0]["id"], "active")
                files = list(Path(directory).glob("*.wav"))
                self.assertEqual(len(files), 1)
                self.assertTrue(files[0].name.startswith("active-"))
            finally:
                docvex_worker.write_message = original_write_message

    def test_post_process_waveform_limits_peaks_and_applies_fade(self):
        # A test tensor exceeding 1.0 peak
        raw = torch.tensor([[1.5, -2.0, 1.2, 0.5, -0.8]])
        processed = docvex_worker.post_process_waveform(raw, sr=24000, target_peak_db=-1.5)
        # Verify peak does not exceed headroom
        self.assertLessEqual(processed.max().item(), 0.85)
        self.assertGreaterEqual(processed.min().item(), -0.85)

        long_waveform = torch.ones(1, 1000)
        faded = docvex_worker.post_process_waveform(long_waveform, sr=24000)
        self.assertAlmostEqual(faded[0, 0].item(), 0.0, places=6)
        self.assertAlmostEqual(faded[0, -1].item(), 0.0, places=6)


if __name__ == "__main__":
    unittest.main()
