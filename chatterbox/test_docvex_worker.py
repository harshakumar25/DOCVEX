import tempfile
import threading
import time
import unittest
from pathlib import Path

import torch
import torchaudio as ta

import docvex_worker
from audio_mastering import (
    AudioMasteringPipeline,
    CANONICAL_SAMPLE_RATE,
    MasteringProfile,
    ReferenceConditioner,
    SampleRateAligner,
    post_process_waveform,
)
from docvex_worker import ChatterboxWorker, validate_request
from model_runtime import SynthesisConfig, create_synthesis_adapter


class FakeModel:
    sr = 24000

    def generate(self, _text, *args, **kwargs):
        time.sleep(0.02)
        return torch.zeros(1, self.sr // 10)


class FakeStandardModel:
    sr = 24000

    def __init__(self):
        self.last_kwargs = None

    def generate(self, _text, *, temperature=0.8, top_p=1.0, min_p=0.05, exaggeration=0.5, cfg_weight=0.5, repetition_penalty=1.2):
        self.last_kwargs = {
            "temperature": temperature,
            "top_p": top_p,
            "min_p": min_p,
            "exaggeration": exaggeration,
            "cfg_weight": cfg_weight,
            "repetition_penalty": repetition_penalty,
        }
        return torch.zeros(1, 2400)


class FakeTurboModel:
    sr = 24000

    def __init__(self):
        self.last_kwargs = None

    def generate(self, _text, *, n_cfm_timesteps=4, norm_loudness=True, temperature=0.8, top_k=1000, top_p=0.95, repetition_penalty=1.2):
        self.last_kwargs = {
            "n_cfm_timesteps": n_cfm_timesteps,
            "norm_loudness": norm_loudness,
            "temperature": temperature,
            "top_k": top_k,
            "top_p": top_p,
            "repetition_penalty": repetition_penalty,
        }
        return torch.zeros(1, 2400)


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

    def test_synthesis_adapters_respect_model_kwargs_contracts(self):
        cfg = SynthesisConfig(cfm_steps=8, temperature=0.65, top_k=500, top_p=0.9, repetition_penalty=1.3)

        std_model = FakeStandardModel()
        std_adapter = create_synthesis_adapter("standard", std_model)
        std_adapter.synthesize("Article 21.", cfg)
        self.assertEqual(std_model.last_kwargs["temperature"], 0.65)
        self.assertNotIn("top_k", std_model.last_kwargs)
        self.assertNotIn("n_cfm_timesteps", std_model.last_kwargs)

        turbo_model = FakeTurboModel()
        nano_adapter = create_synthesis_adapter("nano", turbo_model)
        nano_adapter.synthesize("Article 21.", cfg)
        self.assertEqual(turbo_model.last_kwargs["n_cfm_timesteps"], 8)
        self.assertEqual(turbo_model.last_kwargs["top_k"], 500)
        self.assertTrue(turbo_model.last_kwargs["norm_loudness"])

    def test_sample_rate_aligner_and_mastering_maintain_canonical_24khz(self):
        sr_in = 44100
        t = torch.linspace(0, 0.5, int(sr_in * 0.5))
        tone = 0.2 * torch.sin(2 * torch.pi * 800.0 * t).unsqueeze(0)

        pipeline = AudioMasteringPipeline.from_profile(MasteringProfile(target_sample_rate=CANONICAL_SAMPLE_RATE))
        out, out_sr = pipeline.process(tone, sr_in)
        self.assertEqual(out_sr, 24000)
        self.assertEqual(out.shape[0], 1)
        self.assertLessEqual(out.abs().max().item(), 0.85)

        aligned, same_sr = SampleRateAligner(24000).process(torch.zeros(1, 1000), 24000)
        self.assertEqual(same_sr, 24000)
        self.assertEqual(aligned.shape[-1], 1000)

    def test_reference_conditioner_reduces_sub_300hz_mud(self):
        sr = 24000
        t = torch.linspace(0, 1.0, sr)
        muddy_signal = (0.6 * torch.sin(2 * torch.pi * 160.0 * t) + 0.05 * torch.sin(2 * torch.pi * 1500.0 * t)).unsqueeze(0)

        with tempfile.TemporaryDirectory() as tmpdir:
            src = Path(tmpdir) / "muddy.wav"
            ta.save(str(src), muddy_signal, sr)

            with ReferenceConditioner().prepared_prompt(src) as clean_path:
                self.assertNotEqual(clean_path, src)
                cleaned, clean_sr = ta.load(str(clean_path))
                self.assertEqual(clean_sr, sr)
                spec_before = torch.abs(torch.fft.rfft(muddy_signal.squeeze(0))) ** 2
                spec_after = torch.abs(torch.fft.rfft(cleaned.squeeze(0))) ** 2
                freqs = torch.fft.rfftfreq(sr, 1.0 / sr)
                mud_before = spec_before[(freqs >= 100) & (freqs < 300)].sum() / spec_before.sum()
                mud_after = spec_after[(freqs >= 100) & (freqs < 300)].sum() / spec_after.sum()
                self.assertLess(mud_after.item(), mud_before.item())
                temp_copy = clean_path

            self.assertFalse(temp_copy.exists())


if __name__ == "__main__":
    unittest.main()
