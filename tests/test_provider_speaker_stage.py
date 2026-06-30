import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from stt_daemon.diarize_pipeline import run_provider_speaker_stage
from stt_daemon import speaker_merge


def test_provider_speaker_stage_writes_sidecar_without_yulu_diarization(tmp_path):
    wav = tmp_path / "TeamSync_20260629_100000.wav"
    transcript = tmp_path / "TeamSync_20260629_100000.transcript.txt"
    wav.write_bytes(b"RIFF")
    transcript.write_text("plain transcript", encoding="utf-8")

    wrote = run_provider_speaker_stage(
        audio_path=wav,
        transcript_path=transcript,
        meeting_title="TeamSync",
        provider="hermes",
        asr_segments=[
            {"start": 0.0, "end": 1.0, "text": "你好", "speaker_idx": 0},
            {"start": 1.0, "end": 2.0, "text": "收到", "speaker_idx": 1},
        ],
    )

    assert wrote is True
    labelled = transcript.read_text(encoding="utf-8")
    assert "[00:00 Speaker 1] 你好" in labelled
    assert "[00:01 Speaker 2] 收到" in labelled

    sidecar = json.loads(speaker_merge.speakers_sidecar_path(wav).read_text(encoding="utf-8"))
    assert sidecar["provider"] == "hermes"
    assert sidecar["num_speakers_detected"] == 2
    assert [turn["speaker_idx"] for turn in sidecar["turns"]] == [0, 1]


def test_provider_speaker_stage_coalesces_char_segments(tmp_path):
    wav = tmp_path / "Tabbit_20260630_110249.wav"
    transcript = tmp_path / "Tabbit_20260630_110249.transcript.txt"
    wav.write_bytes(b"RIFF")
    transcript.write_text("plain transcript", encoding="utf-8")

    wrote = run_provider_speaker_stage(
        audio_path=wav,
        transcript_path=transcript,
        meeting_title="Tabbit",
        provider="hermes",
        asr_segments=[
            {"start": 1.20, "end": 1.24, "text": "我", "speaker_idx": 0},
            {"start": 1.30, "end": 1.42, "text": "就", "speaker_idx": 0},
            {"start": 1.46, "end": 1.70, "text": "想", "speaker_idx": 0},
            {"start": 2.16, "end": 2.32, "text": "测", "speaker_idx": 0},
            {"start": 2.44, "end": 2.54, "text": "试", "speaker_idx": 0},
        ],
    )

    assert wrote is True
    assert transcript.read_text(encoding="utf-8") == "[00:01 Speaker 1] 我就想测试"

    sidecar = json.loads(speaker_merge.speakers_sidecar_path(wav).read_text(encoding="utf-8"))
    assert len(sidecar["segments"]) == 1
    assert sidecar["segments"][0]["text"] == "我就想测试"
