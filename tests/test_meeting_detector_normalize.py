"""meeting_detector signature stability.

Phase 5 hardening: macOS 14+ injects dynamic status phrases into Chrome
window titles ("麦克风正在录音", "摄像头正在录像", "内存用量高 - 811 MB",
"已分享桌面内容", and the "- Google Chrome - <profile>" suffix). Before
this fix, signature(app, title) drifted every few seconds, the detector
never crossed `stable_sec`, and `🔔 prompt recording` never fired.

The contract these tests pin down: same meeting → same signature even
when macOS rotates which status phrases the window title carries.
"""

import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import meeting_detector as md


SAME_MEETING_VARIANTS = [
    "Meet - tcu-oyza-tje - 麦克风正在录音 - Google Chrome - Bill",
    "Meet - tcu-oyza-tje - 麦克风正在录音 - 内存用量高 - 811 MB - Google Chrome - Bill",
    "Meet - tcu-oyza-tje - 摄像头正在录像且麦克风正在录音 - 内存用量高 - 1.0 GB - Google Chrome - Bill",
    "Meet - tcu-oyza-tje - 已分享桌面内容 - Google Chrome - Bill",
    "Meet - tcu-oyza-tje - Google Chrome - Bill",
    "Meet - tcu-oyza-tje - Bill",  # Chrome lost focus → no "Google Chrome"
]


def test_strip_system_status_collapses_chrome_variants_to_one_signature():
    sigs = {md.signature("Google Chrome", md.strip_system_status(t))
            for t in SAME_MEETING_VARIANTS}
    assert len(sigs) == 1, (
        "Same meeting must produce one stable signature across macOS "
        f"status-phrase rotations. Got {len(sigs)} distinct sigs:\n"
        f"{[md.strip_system_status(t) for t in SAME_MEETING_VARIANTS]}"
    )


def test_strip_system_status_preserves_meeting_body():
    assert md.strip_system_status(
        "Meet - Openclaw with Lewis - 麦克风正在录音 - Google Chrome - Bill"
    ) == "Meet - Openclaw with Lewis"


@pytest.mark.parametrize("noise", [
    "麦克风正在录音",
    "摄像头正在录像",
    "摄像头正在录像且麦克风正在录音",
    "已分享桌面内容",
    "正在共享屏幕",
])
def test_individual_chinese_status_phrases_stripped(noise):
    stripped = md.strip_system_status(f"Meet - foo-bar - {noise} - Google Chrome - Bill")
    assert stripped == "Meet - foo-bar"


def test_memory_high_with_size_stripped():
    stripped = md.strip_system_status(
        "Meet - foo-bar - 内存用量高 - 811 MB - Google Chrome - Bill"
    )
    assert stripped == "Meet - foo-bar"


def test_english_status_phrases_stripped():
    stripped = md.strip_system_status(
        "Meet - foo-bar - Microphone is on - High memory usage - 1.2 GB - Google Chrome - Bill"
    )
    assert stripped == "Meet - foo-bar"


def test_strip_does_not_eat_unrelated_content():
    # When the title is just the meeting name with no browser tail at all,
    # we must not eat anything.
    assert md.strip_system_status("Zoom Meeting") == "Zoom Meeting"
    assert md.strip_system_status("腾讯会议 - 周会") == "腾讯会议 - 周会"
