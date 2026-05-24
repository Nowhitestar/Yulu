"""Voicemail CLI dispatch — argparse + subcommand handlers."""

import sys
import wave
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from voicemail import cli as memo_cli
from voicemail.repo import VOICEMAIL_DIR_DEFAULT


def _write_wav(path: Path, duration: float = 1.0) -> None:
    n = int(48000 * duration)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00" * n * 4)


def test_no_args_dispatches_to_cmd_new(monkeypatch, capsys):
    """`yulu memo` (no subcommand) is an alias for `yulu memo new`."""
    called = {}
    def fake_cmd_new(title=None, **kwargs):
        called["title"] = title
        return 0
    monkeypatch.setattr(memo_cli, "_cmd_new", fake_cmd_new)
    rc = memo_cli.main([])
    assert rc == 0
    assert called == {"title": None}


def test_new_dispatches_to_cmd_new_with_title(monkeypatch):
    called = {}
    def fake_cmd_new(title=None, **kwargs):
        called["title"] = title
        return 0
    monkeypatch.setattr(memo_cli, "_cmd_new", fake_cmd_new)
    rc = memo_cli.main(["new", "--title", "MyMemo"])
    assert rc == 0
    assert called["title"] == "MyMemo"


def test_stop_dispatches_to_cmd_stop(monkeypatch):
    called = {"v": False}
    def fake_stop():
        called["v"] = True
        return 0
    monkeypatch.setattr(memo_cli, "_cmd_stop", fake_stop)
    rc = memo_cli.main(["stop"])
    assert rc == 0
    assert called["v"] is True


def test_list_empty_inbox_prints_message(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    rc = memo_cli.main(["list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "no voicemails" in out


def test_list_prints_table(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    _write_wav(tmp_path / "voicemail_20260523_201500.wav", duration=12)
    (tmp_path / "voicemail_20260523_201500.title").write_text("Anthropic follow-up\n")
    (tmp_path / "voicemail_20260523_201500.summary.md").write_text("hi")
    rc = memo_cli.main(["list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "voicemail_20260523_201500" in out
    assert "Anthropic follow-up" in out
    assert "12s" in out or "12 s" in out
    assert "✓" in out   # has_summary indicator


def test_show_prints_transcript_and_summary(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    stem = "voicemail_20260523_201500"
    _write_wav(tmp_path / f"{stem}.wav", duration=1)
    (tmp_path / f"{stem}.transcript.txt").write_text("我说的话\n", encoding="utf-8")
    (tmp_path / f"{stem}.summary.md").write_text("## 待办\n- todo 1\n", encoding="utf-8")
    rc = memo_cli.main(["show", stem])
    assert rc == 0
    out = capsys.readouterr().out
    assert "我说的话" in out
    assert "todo 1" in out


def test_show_ambiguous_prefix_lists_candidates(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    _write_wav(tmp_path / "voicemail_20260523_120000.wav", duration=1)
    _write_wav(tmp_path / "voicemail_20260523_180000.wav", duration=1)
    rc = memo_cli.main(["show", "voicemail_20260523"])
    assert rc == 1
    captured = capsys.readouterr()
    out = captured.out + captured.err
    assert "voicemail_20260523_120000" in out
    assert "voicemail_20260523_180000" in out


def test_show_missing_id_returns_1(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    rc = memo_cli.main(["show", "nonexistent"])
    assert rc == 1


def test_delete_removes_files(tmp_path, monkeypatch):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    stem = "voicemail_20260523_201500"
    _write_wav(tmp_path / f"{stem}.wav", duration=1)
    (tmp_path / f"{stem}.transcript.txt").write_text("hi")
    # --yes to skip the confirm prompt in tests
    rc = memo_cli.main(["delete", stem, "--yes"])
    assert rc == 0
    assert not (tmp_path / f"{stem}.wav").exists()
    assert not (tmp_path / f"{stem}.transcript.txt").exists()


def test_send_invokes_send_summary(tmp_path, monkeypatch):
    monkeypatch.setattr(memo_cli, "VOICEMAIL_DIR", tmp_path)
    stem = "voicemail_20260523_201500"
    _write_wav(tmp_path / f"{stem}.wav", duration=1)
    (tmp_path / f"{stem}.summary.md").write_text("hi")

    captured = {}
    def fake_send_summary(summary_path):
        captured["path"] = summary_path
        return True
    monkeypatch.setattr(memo_cli, "_send_summary", fake_send_summary)
    rc = memo_cli.main(["send", stem])
    assert rc == 0
    assert captured["path"] == str(tmp_path / f"{stem}.summary.md")
