"""Phase 13 Task 2 — calendar-attendee prior resolution (stt_daemon.diarize_pipeline).

The Phase-12 free prior (COUNT-01). Proves diarize_pipeline.resolve_attendee_count maps a recording
to its attendee count via meeting_id (recording state) or title (schedule.json), and degrades to
None on any miss/error — the graceful default the count strategy expects. No network, no gog.
"""

import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from stt_daemon import diarize_pipeline as dp  # noqa: E402


def _write(path: Path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def test_resolve_by_meeting_id(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "ev-42", "title": "Weekly Sync"})
    _write(schedule, {"meetings": [
        {"id": "ev-1", "title": "Other", "attendees": ["a", "b"]},
        {"id": "ev-42", "title": "Weekly Sync", "attendees": ["Lewis", "Bob", "Carol"]},
    ]})
    audio = tmp_path / "Weekly_Sync_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="Weekly Sync", state_path=state, schedule_path=schedule)
    assert n == 3


def test_resolve_attendee_names_by_meeting_id_dedupes_and_accepts_dicts(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "ev-42", "title": "Weekly Sync"})
    _write(schedule, {"meetings": [
        {"id": "ev-42", "title": "Weekly Sync", "attendees": [
            {"displayName": "Lewis"},
            {"email": "ciel@example.com"},
            "Lewis",
            "  ",
        ]},
    ]})
    audio = tmp_path / "Weekly_Sync_20260601_100000.wav"
    names = dp.resolve_attendee_names(
        audio, meeting_title="Weekly Sync", state_path=state, schedule_path=schedule)
    assert names == ["Lewis", "ciel@example.com"]


def test_resolve_by_title_when_no_meeting_id(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "", "title": ""})  # state moved on / manual recording
    _write(schedule, {"meetings": [
        {"id": "ev-9", "title": "Design Review", "attendees": ["x", "y", "z", "w"]},
    ]})
    audio = tmp_path / "Design_Review_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="Design Review", state_path=state, schedule_path=schedule)
    assert n == 4


def test_resolve_by_normalized_title_when_recording_stem_is_compact(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "", "title": ""})
    _write(schedule, {"meetings": [
        {
            "id": "ev-9",
            "title": "30 min with Yuxing / Ciel Wei",
            "attendees": ["Yuxing", "Ciel Wei"],
        },
    ]})
    audio = tmp_path / "30minwithYuxingCielWei_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="30minwithYuxingCielWei", state_path=state, schedule_path=schedule)
    assert n == 2


def test_single_calendar_attendee_counts_as_one_on_one(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "", "title": ""})
    _write(schedule, {"meetings": [
        {"id": "ev-9", "title": "Chainbase x Herring Global", "attendees": ["Herring Global"]},
    ]})
    audio = tmp_path / "ChainbasexHerringGlobal_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="ChainbasexHerringGlobal", state_path=state, schedule_path=schedule)
    assert n == 2


def test_meeting_id_linked_but_no_attendees_falls_through_to_title(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "ev-42"})
    _write(schedule, {"meetings": [
        {"id": "ev-42", "title": "Standup", "attendees": []},        # linked but empty
        {"id": "ev-99", "title": "Standup", "attendees": ["p", "q"]},  # title twin with attendees
    ]})
    audio = tmp_path / "Standup_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="Standup", state_path=state, schedule_path=schedule)
    assert n == 2


def test_no_link_returns_none(tmp_path):
    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    _write(state, {"meeting_id": "nope"})
    _write(schedule, {"meetings": [
        {"id": "ev-1", "title": "Unrelated", "attendees": ["a", "b"]},
    ]})
    audio = tmp_path / "Mystery_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="Mystery", state_path=state, schedule_path=schedule)
    assert n is None


def test_missing_files_return_none(tmp_path):
    audio = tmp_path / "X_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="X",
        state_path=tmp_path / "nope.json", schedule_path=tmp_path / "nope2.json")
    assert n is None


def test_malformed_schedule_returns_none(tmp_path):
    schedule = tmp_path / "schedule.json"
    schedule.write_text("{ this is not json", encoding="utf-8")
    audio = tmp_path / "X_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="X",
        state_path=tmp_path / "none.json", schedule_path=schedule)
    assert n is None


def test_empty_meetings_list_returns_none(tmp_path):
    schedule = tmp_path / "schedule.json"
    _write(schedule, {"meetings": []})
    audio = tmp_path / "X_20260601_100000.wav"
    n = dp.resolve_attendee_count(
        audio, meeting_title="X",
        state_path=tmp_path / "none.json", schedule_path=schedule)
    assert n is None
