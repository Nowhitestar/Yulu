"""_maybe_summary_notify: fires terminal-notifier only for the default
auto-run summary slug, regardless of the recording's directory."""

import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from agent_queue_worker import _maybe_summary_notify


def test_notify_fires_for_default_summary(tmp_path):
    audio = tmp_path / "Memo_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("# Meeting summary\n\n- 记得明天找 Anthropic 团队\n",
                       encoding="utf-8")

    with patch("subprocess.Popen") as popen_mock:
        _maybe_summary_notify(summary_path=summary, prompt_slug="summary")
        assert popen_mock.called
        args = popen_mock.call_args[0][0]
        assert args[0] == "terminal-notifier"
        # message contains the first non-header line
        assert any("Anthropic" in str(a) for a in args)


def test_notify_fires_for_a_meeting_in_root(tmp_path):
    """The notification no longer keys on a voicemails/ directory — any
    recording's default summary fires it."""
    audio = tmp_path / "ProductWeekly_20260523_090000.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("notes here", encoding="utf-8")
    with patch("subprocess.Popen") as popen_mock:
        _maybe_summary_notify(summary_path=summary, prompt_slug="summary")
        assert popen_mock.called


def test_notify_skips_non_default_slug(tmp_path):
    """Only the auto-run `summary` slug fires; cleanup / opt-in prompts stay
    quiet to avoid double-notifying per recording."""
    audio = tmp_path / "Memo_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".transcript-cleanup.summary.md")
    summary.write_text("cleaned", encoding="utf-8")
    with patch("subprocess.Popen") as popen_mock:
        _maybe_summary_notify(summary_path=summary, prompt_slug="transcript-cleanup")
        assert not popen_mock.called


def test_notify_swallows_missing_terminal_notifier(tmp_path):
    """If terminal-notifier isn't on PATH (FileNotFoundError), the helper must
    not raise — summary completion should never fail over a missing binary."""
    audio = tmp_path / "Memo_20260523_201500.wav"
    audio.touch()
    summary = audio.with_suffix(".summary.md")
    summary.write_text("hi", encoding="utf-8")
    with patch("subprocess.Popen", side_effect=FileNotFoundError):
        # Must not raise
        _maybe_summary_notify(summary_path=summary, prompt_slug="summary")
