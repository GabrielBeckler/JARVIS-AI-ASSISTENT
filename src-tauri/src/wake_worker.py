"""Local Vosk wake detector and bounded PipeWire capture for J."""

import array
from collections import deque
import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import time
import wave

RATE = 16_000
FRAME_MS = 80
FRAME_BYTES = RATE * FRAME_MS // 1000 * 2
PRE_ROLL = 3200 // FRAME_MS
END_SILENCE = 800 // FRAME_MS
MAX_CAPTURE = 24_000 // FRAME_MS
FOLLOW_TIMEOUT = 8
KEYWORD_OVERLAP = int(RATE * 0.08) * 2
SPEECH_BLOCK = FRAME_BYTES // 4
GREETINGS = ("oi", "ei", "hey", "bom dia")
DECOYS = ("gota", "porta", "nota", "joia", "joão", "josé", "rota", "jogo", "já")
CALLS = {"jota", *(greeting + " jota" for greeting in GREETINGS)}
CALL_PREFIX = re.compile(
    r"^\s*(?:(?:oi|ei|hey|bom\s+dia)\b[\s,.!?;:—-]*)?(?:jota|j)\b[\s,.!?;:—-]*",
    re.IGNORECASE,
)


def remove_call(text):
    return CALL_PREFIX.sub("", text.strip(), count=1).strip()


def emit(stage, detail=None, text=None):
    print(json.dumps({"stage": stage, "detail": detail, "text": text}, ensure_ascii=False), flush=True)


class Detector:
    def __init__(self, model_path):
        from vosk import KaldiRecognizer, Model, SetLogLevel

        SetLogLevel(-2)
        model = Model(str(model_path))
        if model.vosk_model_find_word("jota") < 0:
            raise ValueError("O modelo do Vosk não contém a pronúncia de “Jota”. Instale o modelo português indicado no README.")
        # “Hey” is often pronounced like “ei” and is absent from this lexicon.
        greetings = [g for g in GREETINGS if all(model.vosk_model_find_word(w) >= 0 for w in g.split())]
        grammar = ["[unk]", "jota", *(g + " jota" for g in greetings)]
        grammar.extend(w for w in DECOYS if model.vosk_model_find_word(w) >= 0)
        self.model = model
        self.grammar = json.dumps(grammar, ensure_ascii=False)
        self.recognizer_type = KaldiRecognizer
        self.reset()

    def reset(self):
        self.recognizer = None
        self.previous = None
        self.frames = 0
        self.quiet = 0

    def detect(self, frame, voiced):
        if self.recognizer is None:
            if not voiced:
                return None
            self.recognizer = self.recognizer_type(self.model, RATE, self.grammar)
            self.recognizer.SetWords(True)
            self.recognizer.SetPartialWords(True)
        self.frames += 1
        self.quiet = 0 if voiced else self.quiet + 1
        final = self.recognizer.AcceptWaveform(frame)
        result = json.loads(self.recognizer.Result() if final else self.recognizer.PartialResult())
        words = result.get("result" if final else "partial_result", [])
        tokens = [word["word"] for word in words]
        candidate = None
        if "jota" in tokens and self.frames < PRE_ROLL:
            # The decoder can align the onset of a greeting to a brief unknown sound.
            if tokens[0] == "[unk]" and words[0]["end"] <= 0.10:
                tokens, words = tokens[1:], words[1:]
            index = tokens.index("jota")
            prefix = " ".join(tokens[:index + 1])
            word = words[index]
            duration = word["end"] - word["start"]
            confidence = word.get("conf", 0)
            enough_evidence = (confidence >= 0.72 and duration >= 0.16) or (confidence >= 0.55 and duration >= 0.33)
            # Require the call to begin the utterance. A short untranslated greeting
            # is allowed only when the name has strong acoustic evidence.
            early = words[0]["start"] <= 0.24
            short_greeting = index == 0 and 0.32 <= word["start"] <= 0.55 and confidence >= 0.92
            clipped_bom = prefix == "dia jota" and 0.22 <= words[0]["start"] <= 0.42 and confidence >= 0.90
            if enough_evidence and ((prefix in CALLS and early) or short_greeting or clipped_bom):
                candidate = (word["start"], word["end"])
        lag = None
        if candidate is not None and (final or self.previous == candidate[0]):
            lag = max(0, self.frames * FRAME_BYTES - round(candidate[1] * RATE) * 2)
        self.previous = candidate[0] if candidate else None
        if final or self.quiet >= END_SILENCE + 6:
            self.reset()
        return lag


def level(frame):
    samples = array.array("h", frame)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


class Transcription:
    def __init__(self, cli, model, clip):
        self.temp = tempfile.TemporaryDirectory(prefix="jota-command-")
        folder = Path(self.temp.name)
        self.output = folder / "transcript.txt"
        audio = folder / "fala.wav"
        try:
            with wave.open(str(audio), "wb") as wav:
                wav.setparams((1, 2, RATE, 0, "NONE", ""))
                wav.writeframes(clip)
            self.process = subprocess.Popen(
                [cli, "-m", model, "-f", str(audio), "-l", "pt", "-nt", "-otxt",
                 "--no-gpu", "-of", str(self.output.with_suffix(""))],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except BaseException:
            self.temp.cleanup()
            raise
        self.started = time.monotonic()

    def poll(self):
        status = self.process.poll()
        if status is None:
            if time.monotonic() - self.started > 45:
                raise RuntimeError("O Whisper excedeu o tempo para transcrever o pedido.")
            return None
        if status != 0 or not self.output.is_file():
            raise RuntimeError("O Whisper não conseguiu transcrever. Confira a instalação de voz no README.")
        return self.output.read_text().strip()

    def close(self):
        stop_process(self.process)
        self.temp.cleanup()


class Capture:
    def __init__(self, detector, transcribe, report=emit, clock=time.monotonic):
        self.detector = detector
        self.transcribe = transcribe
        self.report = report
        self.clock = clock
        self.job = None
        self.reset()

    def reset(self):
        if self.job is not None:
            self.job.close()
            self.job = None
        self.detector.reset()
        self.ring = deque(maxlen=PRE_ROLL)
        self.follow_until = None
        self.clip = None
        self.quiet = 0
        self.waiting_quiet = 0
        self.peak = 0
        self.levels = deque(maxlen=40)
        self.call_end = None

    def threshold(self):
        background = sorted(self.levels)[len(self.levels) // 8] if len(self.levels) >= 12 else 45
        return max(130, background * 2.2)

    def voiced(self, frame):
        rms = level(frame)
        if self.clip is None and self.follow_until is None:
            self.levels.append(rms)
        elif self.clip is not None:
            self.peak = max(self.peak, rms)
        return rms >= max(self.threshold(), self.peak * 0.07)

    def finish(self):
        clip, self.clip = self.clip, None
        if self.call_end is not None:
            # Keep overlap for alignment errors and tightly connected speech. The
            # name alone needs no Whisper subprocess if the tail contains no speech.
            after_call = self.call_end + SPEECH_BLOCK * 3
            floor = max(self.threshold(), self.peak * 0.04)
            speech = sum(
                level(clip[offset:offset + SPEECH_BLOCK]) >= floor
                for offset in range(after_call, len(clip) - SPEECH_BLOCK + 1, SPEECH_BLOCK)
            )
            if speech < 3:
                self.wait_for_request()
                return
            clip = clip[max(0, self.call_end - KEYWORD_OVERLAP):]
        detail = None if self.quiet >= END_SILENCE else "Fim da fala incerto. Transcrevendo o trecho capturado…"
        self.report("transcribing", detail)
        self.job = self.transcribe(clip)

    def wait_for_request(self):
        self.reset()
        self.follow_until = self.clock() + FOLLOW_TIMEOUT
        self.report("awaiting_request", "Estou ouvindo. Pode falar.")

    def frame(self, frame):
        if self.job is not None:
            return
        if self.clip is not None:
            self.clip.extend(frame)
            self.quiet = 0 if self.voiced(frame) else self.quiet + 1
            if self.quiet >= END_SILENCE or len(self.clip) >= MAX_CAPTURE * FRAME_BYTES:
                self.finish()
            return
        self.ring.append(frame)
        voiced = self.voiced(frame)
        self.waiting_quiet = 0 if voiced else self.waiting_quiet + 1
        if self.follow_until is None:
            lag = self.detector.detect(frame, voiced)
            if lag is None:
                return
            self.clip = bytearray(b"".join(self.ring))
            self.call_end = max(0, len(self.clip) - lag)
        else:
            if not voiced:
                return
            # Include the frames just before speech crosses the energy threshold.
            self.clip = bytearray(b"".join(list(self.ring)[-4:]))
        self.quiet = min(self.waiting_quiet, END_SILENCE - 2)
        self.report("capturing")

    def tick(self):
        if self.job is not None:
            text = self.job.poll()
            if text is None:
                return
            follow = self.follow_until is not None
            self.reset()
            question = text if follow else remove_call(text)
            if question:
                self.report("waiting", text=question)
            elif not follow:
                self.wait_for_request()
            else:
                self.report("waiting", "Não reconheci o pedido. Chame por Jota para tentar novamente.")
        elif self.follow_until is not None and self.clip is None and self.clock() >= self.follow_until:
            self.reset()
            self.report("waiting")


class Listener:
    def __init__(self, capture):
        self.capture = capture
        self.selector = selectors.DefaultSelector()
        self.selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "control")
        self.commands = bytearray()
        self.pcm = bytearray()
        self.recorder = None
        self.diagnostics = None
        self.resume_at = None
        self.last_audio = None
        self.received_audio = False

    def start_recording(self):
        try:
            self.diagnostics = tempfile.TemporaryFile()
            self.recorder = subprocess.Popen(
                ["pw-record", "--raw", "--rate", str(RATE), "--channels", "1", "--format", "s16",
                 "--latency", "80ms", "--properties", "application.name=J node.name=jota-wake", "-"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.diagnostics,
            )
            self.selector.register(self.recorder.stdout, selectors.EVENT_READ, "audio")
        except OSError as error:
            self.stop_recording()
            emit("error", f"Não consegui iniciar o microfone pelo PipeWire: {error}")
            self.resume_at = time.monotonic() + 4
            return
        self.last_audio = time.monotonic()
        self.resume_at = None
        emit("connecting")

    def stop_recording(self):
        if self.recorder is not None:
            self.selector.unregister(self.recorder.stdout)
            stop_process(self.recorder)
            self.recorder.stdout.close()
            self.recorder = None
        if self.diagnostics is not None:
            self.diagnostics.close()
            self.diagnostics = None
        self.pcm.clear()
        self.last_audio = None
        self.received_audio = False
        self.capture.reset()

    def microphone_lost(self):
        self.diagnostics.seek(0)
        detail = self.diagnostics.read(1024).decode(errors="replace").strip()
        self.stop_recording()
        message = "Não recebi áudio do microfone. Confira o dispositivo padrão e a permissão de áudio do KDE."
        if detail:
            message += " PipeWire: " + detail
        emit("error", message)
        self.resume_at = time.monotonic() + 4

    def control(self):
        data = os.read(sys.stdin.fileno(), 4096)
        if not data:
            return False
        self.commands.extend(data)
        while b"\n" in self.commands:
            command, _, remainder = self.commands.partition(b"\n")
            self.commands = remainder
            if command == b"quit":
                return False
            if command == b"hold":
                self.resume_at = None
                self.stop_recording()
                emit("suspended")
            if command == b"listen" and self.recorder is None:
                self.resume_at = time.monotonic() + 0.45
        return True

    def run(self):
        try:
            while True:
                events = self.selector.select(0.10)
                # Playback and the pause button take priority over any queued microphone frames.
                for key, _ in events:
                    if key.data == "control" and not self.control():
                        return
                if self.resume_at is not None and time.monotonic() >= self.resume_at:
                    self.start_recording()
                for key, _ in events:
                    if key.data != "audio" or self.recorder is None or key.fileobj is not self.recorder.stdout:
                        continue
                    audio = os.read(key.fd, 8192)
                    if not audio:
                        self.microphone_lost()
                        continue
                    if not self.received_audio:
                        emit("waiting")
                        self.received_audio = True
                    self.last_audio = time.monotonic()
                    self.pcm.extend(audio)
                    while len(self.pcm) >= FRAME_BYTES:
                        frame = bytes(self.pcm[:FRAME_BYTES])
                        del self.pcm[:FRAME_BYTES]
                        self.capture.frame(frame)
                if self.last_audio is not None and time.monotonic() - self.last_audio >= 5:
                    self.microphone_lost()
                self.capture.tick()
        finally:
            self.stop_recording()
            self.selector.close()


def main():
    try:
        detector = Detector(Path(sys.argv[1]))
    except ImportError:
        emit("error", "Vosk não instalado. Siga a instalação da escuta por Jota no README.")
        return
    except Exception as error:
        emit("error", f"Não consegui carregar o detector de Jota: {error}")
        return
    try:
        cli, model = sys.argv[2:4]
        Listener(Capture(detector, lambda clip: Transcription(cli, model, clip))).run()
    except Exception as error:
        emit("error", f"A escuta de Jota foi interrompida: {error}. Pause e retome para tentar novamente.")


if __name__ == "__main__":
    main()
