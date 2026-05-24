"""_maybe_voicemail_notify: fires terminal-notifier only for voicemail
audio paths AND only for the voicemail-todos slug."""

import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from agent_queue_worker import _maybe_voicemail_notify


def test_notify_fires_for_voicemail_todos(tmp_path):
    # Simulate a real voicemails-dir audio path
    vm_dir = tmp_path / "voicemails"
    vm_dir.mkdir()
    audio = vm_dir / "voicemail_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("# Voicemail summary\n\n- 嗯 记得明天找 Anthropic 团队\n",
                       encoding="utf-8")

    with patch("subprocess.Popen") as popen_mock:
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="voicemail-todos")
        assert popen_mock.called
        args = popen_mock.call_args[0][0]
        assert args[0] == "terminal-notifier"
        # message contains first non-header line
        assert any("Anthropic" in str(a) for a in args)


def test_notify_skips_non_voicemail_audio(tmp_path):
    audio = tmp_path / "ProductWeekly_20260523.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("foo", encoding="utf-8")
    with patch("subprocess.Popen") as popen_mock:
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="summary")
        assert not popen_mock.called


def test_notify_skips_non_default_voicemail_slug(tmp_path):
    """Only the auto-run voicemail-todos slug fires a notification;
    voicemail-clean does not (avoids double-notify when both are auto-run)."""
    vm_dir = tmp_path / "voicemails"
    vm_dir.mkdir()
    audio = vm_dir / "voicemail_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".voicemail-clean.summary.md")
    summary.write_text("cleaned", encoding="utf-8")
    with patch("subprocess.Popen") as popen_mock:
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="voicemail-clean")
        assert not popen_mock.called


def test_notify_swallows_missing_terminal_notifier(tmp_path):
    """If terminal-notifier isn't on PATH (FileNotFoundError), the helper
    must not raise — voicemail completion should never fail because of
    a missing notification binary."""
    vm_dir = tmp_path / "voicemails"
    vm_dir.mkdir()
    audio = vm_dir / "voicemail_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("hi", encoding="utf-8")
    with patch("subprocess.Popen", side_effect=FileNotFoundError):
        # Must not raise
        _maybe_voicemail_notify(audio_path=audio, summary_path=summary,
                                prompt_slug="voicemail-todos")
