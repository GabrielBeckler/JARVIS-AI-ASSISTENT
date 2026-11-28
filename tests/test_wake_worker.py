import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "wake_worker", Path(__file__).resolve().parents[1] / "src-tauri/src/wake_worker.py"
)
wake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wake)
SILENCE = bytes(wake.FRAME_BYTES)
SPEECH = b"\xfa\x01" * (wake.FRAME_BYTES // 2)


class FakeDetector:
    def reset(self):
        self.lag = None

    def detect(self, frame, voiced):
        return self.lag


class FakeJob:
    def __init__(self, text):
        self.text = text
        self.closed = False

    def poll(self):
        return self.text

    def close(self):
        self.closed = True


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.detector = FakeDetector()
        self.now = 0
        self.text = ""
        self.events = []
        self.clips = []

        def transcribe(clip):
            self.clips.append(bytes(clip))
            return FakeJob(self.text)

        self.capture = wake.Capture(
            self.detector, transcribe,
            lambda stage, detail=None, text=None: self.events.append((stage, detail, text)),
            lambda: self.now,
        )

    def finish(self):
        for _ in range(wake.END_SILENCE):
            self.capture.frame(SILENCE)
        self.capture.tick()

    def test_preroll_preserves_the_speech_already_spoken_at_detection(self):
        self.text = "Oi, J. Abra o projeto OdontoFlow no VS Code."
        self.capture.frame(SPEECH)
        self.detector.lag = wake.FRAME_BYTES
        self.capture.frame(SPEECH)
        self.capture.frame(SPEECH)
        self.finish()
        self.assertTrue(self.clips[0].startswith(SPEECH * 3))
        self.assertEqual([event[0] for event in self.events], ["capturing", "transcribing", "waiting"])
        self.assertEqual(self.events[-1][2], "Abra o projeto OdontoFlow no VS Code.")

    def test_call_alone_waits_and_captures_the_next_utterance(self):
        self.text = "Bom dia, Jota!"
        self.detector.lag = 0
        self.capture.frame(SPEECH)
        self.finish()
        self.assertEqual(self.events[-1][0], "awaiting_request")
        self.text = "Como está meu computador?"
        self.capture.frame(SILENCE)
        self.capture.frame(SPEECH)
        self.finish()
        self.assertEqual(self.events[-1][2], "Como está meu computador?")
        self.assertEqual(len(self.clips), 1)

    def test_follow_up_times_out_without_sending_a_draft(self):
        self.text = "jota"
        self.detector.lag = 0
        self.capture.frame(SPEECH)
        self.finish()
        self.now = wake.FOLLOW_TIMEOUT
        self.capture.tick()
        self.assertEqual(self.events[-1], ("waiting", None, None))
        self.assertIsNone(self.capture.follow_until)

    def test_suspension_discards_capture_and_cancels_transcription(self):
        self.detector.lag = 0
        self.capture.frame(SPEECH)
        self.capture.frame(SPEECH)
        self.capture.frame(SPEECH)
        for _ in range(wake.END_SILENCE):
            self.capture.frame(SILENCE)
        job = self.capture.job
        self.capture.reset()
        self.capture.tick()
        self.assertTrue(job.closed)
        self.assertIsNone(self.capture.clip)
        self.assertFalse(self.capture.ring)
        self.assertFalse(any(event[2] for event in self.events))

    def test_prefix_is_removed_only_at_the_start_of_a_wake_transcription(self):
        for greeting in ("Jota", "oi, jota", "Ei! J.", "Hey, Jota", "Bom dia, Jota"):
            self.assertEqual(wake.remove_call(greeting + ":  liste os PDFs"), "liste os PDFs")
        self.assertEqual(wake.remove_call("Mostre o arquivo Jota.txt"), "Mostre o arquivo Jota.txt")
        self.assertEqual(wake.remove_call("Jovem"), "Jovem")


class RecorderTests(unittest.TestCase):
    def test_microphone_disconnect_clears_captured_audio_and_reports_the_error(self):
        with tempfile.TemporaryFile() as control, patch.object(wake.sys, "stdin", control), patch.object(
            wake.selectors, "DefaultSelector", wake.selectors.SelectSelector
        ), patch.object(wake, "emit") as emit:
            capture = wake.Capture(FakeDetector(), None)
            listener = wake.Listener(capture)
            listener.diagnostics = tempfile.TemporaryFile()
            listener.diagnostics.write(b"No node available")
            capture.clip = bytearray(SPEECH)
            try:
                listener.microphone_lost()
                self.assertIsNone(capture.clip)
                self.assertGreater(listener.resume_at, wake.time.monotonic())
                self.assertEqual(emit.call_args.args[0], "error")
                self.assertIn("No node available", emit.call_args.args[1])
            finally:
                listener.selector.close()

    def test_missing_recorder_does_not_report_listening_and_schedules_retry(self):
        detector = FakeDetector()
        with tempfile.TemporaryFile() as control, patch.object(wake.sys, "stdin", control), patch.object(
            wake.selectors, "DefaultSelector", wake.selectors.SelectSelector
        ), patch.object(wake.subprocess, "Popen", side_effect=FileNotFoundError), patch.object(wake, "emit") as emit:
            listener = wake.Listener(wake.Capture(detector, None))
            try:
                listener.start_recording()
                self.assertIsNone(listener.recorder)
                self.assertGreater(listener.resume_at, wake.time.monotonic())
                self.assertEqual(emit.call_args.args[0], "error")
                self.assertIn("PipeWire", emit.call_args.args[1])
            finally:
                listener.selector.close()


@unittest.skipUnless(os.environ.get("JOTA_TEST_MODEL") and shutil.which("espeak-ng") and shutil.which("ffmpeg"),
                     "requires the local Portuguese Vosk model, eSpeak NG, and FFmpeg")
class AcousticTests(unittest.TestCase):
    def test_synthetic_portuguese_calls_and_distractors(self):
        detector = wake.Detector(Path(os.environ["JOTA_TEST_MODEL"]))
        positive = [
            "Jota.", "Oi, Jota.", "Ei, Jota.", "Hey, Jota.", "Bom dia, Jota.",
            "Jota, como está meu computador?", "Oi, Jota, abra o projeto OdontoFlow no VS Code.",
        ]
        negative = ["Gota.", "Porta.", "João.", "Joia.", "Já está na hora.",
                    "O José está na sala.", "Eu ouvi Jota na conversa.", "Hoje vamos testar o computador."]
        with tempfile.TemporaryDirectory() as folder:
            audio = str(Path(folder) / "phrase.wav")
            for phrase, expected in [(text, True) for text in positive] + [(text, False) for text in negative]:
                with self.subTest(phrase=phrase):
                    subprocess.run(["espeak-ng", "-v", "pt-br", "-s", "142", "-w", audio, phrase], check=True)
                    pcm = subprocess.check_output(["ffmpeg", "-v", "error", "-i", audio,
                                                   "-f", "s16le", "-ac", "1", "-ar", str(wake.RATE), "-"])
                    pcm += SILENCE * 25
                    meter = wake.Capture(detector, None)
                    hit = False
                    for offset in range(0, len(pcm) - wake.FRAME_BYTES, wake.FRAME_BYTES):
                        frame = pcm[offset:offset + wake.FRAME_BYTES]
                        if detector.detect(frame, meter.voiced(frame)) is not None:
                            hit = True
                            break
                    self.assertEqual(hit, expected)


if __name__ == "__main__":
    unittest.main()
