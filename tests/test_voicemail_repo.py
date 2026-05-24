"""VoicemailRecord + list_voicemails — filesystem-as-database."""

import sys
import wave
from datetime import datetime
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from voicemail.repo import (
    VOICEMAIL_DIR_DEFAULT,
    VoicemailRecord,
    list_voicemails,
)


def _write_minimal_wav(path: Path, *, duration_sec: float = 1.0,
                       channels: int = 2, framerate: int = 48000) -> None:
    """Write a minimal valid stereo WAV of `duration_sec` for header parsing."""
    n_frames = int(framerate * duration_sec)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(b"\x00" * n_frames * channels * 2)


def test_list_empty_dir_returns_empty_list(tmp_path):
    assert list_voicemails(directory=tmp_path) == []


def test_list_returns_newest_first(tmp_path):
    a = tmp_path / "voicemail_20260520_120000.wav"
    b = tmp_path / "voicemail_20260523_120000.wav"
    c = tmp_path / "voicemail_20260521_120000.wav"
    for p in (a, b, c):
        _write_minimal_wav(p, duration_sec=1)
    out = list_voicemails(directory=tmp_path)
    stems = [r.stem for r in out]
    assert stems == [
        "voicemail_20260523_120000",
        "voicemail_20260521_120000",
        "voicemail_20260520_120000",
    ]


def test_list_respects_limit(tmp_path):
    for i in range(25):
        p = tmp_path / f"voicemail_20260520_{120000 + i:06d}.wav"
        _write_minimal_wav(p, duration_sec=1)
    out = list_voicemails(directory=tmp_path, limit=10)
    assert len(out) == 10


def test_record_title_from_sidecar(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=2)
    (tmp_path / "voicemail_20260523_120000.title").write_text(
        "Anthropic pricing follow-up\n", encoding="utf-8"
    )
    out = list_voicemails(directory=tmp_path)
    assert out[0].title == "Anthropic pricing follow-up"


def test_record_title_falls_back_to_transcript_first_words(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=2)
    (tmp_path / "voicemail_20260523_120000.transcript.txt").write_text(
        "嗯 记得明天找 Anthropic 团队聊 pricing 的事 然后还要写一下 Phase 4 的 plan",
        encoding="utf-8",
    )
    out = list_voicemails(directory=tmp_path)
    # First 8 whitespace-separated tokens, joined with single spaces
    assert out[0].title == "嗯 记得明天找 Anthropic 团队聊 pricing 的事 然后还要写一下 Phase"


def test_record_title_unknown_when_no_sidecar_no_transcript(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=2)
    out = list_voicemails(directory=tmp_path)
    assert out[0].title == "(no title)"


def test_record_duration_from_wav_header(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=12.5)
    out = list_voicemails(directory=tmp_path)
    assert 12 <= out[0].duration_sec <= 13   # int seconds


def test_record_created_at_parsed_from_filename(tmp_path):
    wav = tmp_path / "voicemail_20260523_201500.wav"
    _write_minimal_wav(wav, duration_sec=1)
    out = list_voicemails(directory=tmp_path)
    assert out[0].created_at == datetime(2026, 5, 23, 20, 15, 0)


def test_record_has_summary_flag(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=1)
    out = list_voicemails(directory=tmp_path)
    assert out[0].has_summary is False
    assert out[0].summary_slugs == []
    (tmp_path / "voicemail_20260523_120000.summary.md").write_text("hi", encoding="utf-8")
    (tmp_path / "voicemail_20260523_120000.voicemail-clean.summary.md").write_text("hi", encoding="utf-8")
    out2 = list_voicemails(directory=tmp_path)
    assert out2[0].has_summary is True
    assert set(out2[0].summary_slugs) == {"voicemail-todos", "voicemail-clean"}


def test_list_ignores_non_voicemail_wavs(tmp_path):
    # Meeting recording wav (different prefix) MUST be ignored
    (tmp_path / "ProductWeekly_20260523_120000.wav").write_bytes(b"")
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    out = list_voicemails(directory=tmp_path)
    assert len(out) == 1
    assert out[0].stem == "voicemail_20260523_120000"


def test_default_dir_constant():
    assert VOICEMAIL_DIR_DEFAULT.name == "voicemails"
    assert "Movies/Yulu" in str(VOICEMAIL_DIR_DEFAULT)


import pytest

from voicemail.repo import (
    AmbiguousVoicemailId,
    VoicemailNotFound,
    delete_voicemail,
    get_voicemail,
)


def test_get_by_exact_stem(tmp_path):
    wav = tmp_path / "voicemail_20260523_120000.wav"
    _write_minimal_wav(wav, duration_sec=1)
    rec = get_voicemail("voicemail_20260523_120000", directory=tmp_path)
    assert rec.stem == "voicemail_20260523_120000"


def test_get_by_unique_prefix(tmp_path):
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    _write_minimal_wav(tmp_path / "voicemail_20260521_120000.wav")
    rec = get_voicemail("voicemail_20260523", directory=tmp_path)
    assert rec.stem == "voicemail_20260523_120000"


def test_get_by_ambiguous_prefix_raises(tmp_path):
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    _write_minimal_wav(tmp_path / "voicemail_20260523_180000.wav")
    with pytest.raises(AmbiguousVoicemailId) as exc:
        get_voicemail("voicemail_20260523", directory=tmp_path)
    assert "voicemail_20260523_120000" in exc.value.candidates
    assert "voicemail_20260523_180000" in exc.value.candidates


def test_get_missing_raises(tmp_path):
    with pytest.raises(VoicemailNotFound):
        get_voicemail("voicemail_00000000_000000", directory=tmp_path)


def test_delete_removes_all_siblings(tmp_path):
    stem = "voicemail_20260523_120000"
    _write_minimal_wav(tmp_path / f"{stem}.wav")
    (tmp_path / f"{stem}.transcript.txt").write_text("hi")
    (tmp_path / f"{stem}.raw.transcript.txt").write_text("hi")
    (tmp_path / f"{stem}.title").write_text("hi")
    (tmp_path / f"{stem}.summary.md").write_text("hi")
    (tmp_path / f"{stem}.voicemail-clean.summary.md").write_text("hi")
    (tmp_path / f"{stem}.summary.html").write_text("hi")

    rec = get_voicemail(stem, directory=tmp_path)
    removed = delete_voicemail(rec)
    assert removed == 7
    assert list(tmp_path.iterdir()) == []


def test_delete_idempotent_on_missing_siblings(tmp_path):
    stem = "voicemail_20260523_120000"
    _write_minimal_wav(tmp_path / f"{stem}.wav")
    # No siblings — just the wav
    rec = get_voicemail(stem, directory=tmp_path)
    removed = delete_voicemail(rec)
    assert removed == 1
    assert not (tmp_path / f"{stem}.wav").exists()


def test_delete_does_not_touch_other_voicemails(tmp_path):
    _write_minimal_wav(tmp_path / "voicemail_20260523_120000.wav")
    _write_minimal_wav(tmp_path / "voicemail_20260521_120000.wav")
    rec = get_voicemail("voicemail_20260523_120000", directory=tmp_path)
    delete_voicemail(rec)
    assert (tmp_path / "voicemail_20260521_120000.wav").exists()
