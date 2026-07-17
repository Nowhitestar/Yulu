import base64
import sys
from array import array
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from sherpa_caption_worker import CaptionWorker, SourceState, _decode_pcm16  # noqa: E402


class FakeStream:
    def __init__(self):
        self.samples = []
        self.finished = False

    def accept_waveform(self, _sample_rate, samples):
        self.samples.extend(samples)

    def input_finished(self):
        self.finished = True


class FakeRecognizer:
    def __init__(self):
        self.text = ""
        self.endpoint = False
        self.resets = 0

    def create_stream(self):
        return FakeStream()

    def is_ready(self, _stream):
        return False

    def decode_stream(self, _stream):
        raise AssertionError("not ready")

    def get_result(self, _stream):
        return self.text

    def is_endpoint(self, _stream):
        return self.endpoint

    def reset(self, _stream):
        self.resets += 1


def fake_worker():
    worker = CaptionWorker.__new__(CaptionWorker)
    worker.recognizer = FakeRecognizer()
    worker.sources = {}
    worker.warmed = False
    return worker


def test_decode_pcm16_preserves_signed_little_endian_samples():
    samples = array("h", [-32768, -1, 0, 16384, 32767])
    if sys.byteorder != "little":
        samples.byteswap()
    encoded = base64.b64encode(samples.tobytes()).decode()

    decoded = _decode_pcm16(encoded)

    assert decoded[0] == -1.0
    assert decoded[2] == 0.0
    assert decoded[3] == 0.5
    assert 0.999 < decoded[4] < 1.0


def test_worker_keeps_partial_mutable_and_emits_only_endpoint_text_as_stable():
    worker = fake_worker()
    worker.start()
    worker.recognizer.text = "正在讨论"
    pcm = base64.b64encode(array("h", [1000] * 320).tobytes()).decode()

    partial = worker.feed({"mic": pcm})["updates"]["mic"]

    assert partial == {"partial": "正在讨论", "stable": [], "audioMs": 20}

    worker.recognizer.text = "正在讨论方案"
    worker.recognizer.endpoint = True
    stable = worker.feed({"mic": pcm})["updates"]["mic"]

    assert stable["partial"] == ""
    assert stable["stable"] == [{"text": "正在讨论方案", "endMs": 40}]
    assert worker.recognizer.resets == 1


def test_warm_primes_the_decoder_only_once():
    worker = fake_worker()
    assert worker.warmed is False

    assert worker.warm()["ready"] is True
    assert worker.warm()["ready"] is True

    assert worker.warmed is True


def test_finish_flushes_each_source_and_clears_the_session():
    worker = fake_worker()
    worker.sources = {
        source: SourceState(stream=FakeStream(), samples=640)
        for source in ("mic", "system")
    }
    worker.recognizer.text = "最终片段"

    result = worker.finish()

    assert result["updates"]["mic"]["stable"] == [{"text": "最终片段", "endMs": 40}]
    assert result["updates"]["system"]["partial"] == ""
    assert worker.sources == {}
