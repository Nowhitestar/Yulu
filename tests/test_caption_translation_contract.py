"""Cross-language contract for live-caption translation (ADR-011).

The overlay is Swift and the Host is TypeScript; these source checks keep the
unavailable-reason contract aligned and the retired Hermes path out.
"""

from __future__ import annotations

import re
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"


def test_recorder_status_says_why_caption_translation_is_unavailable():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    handler_start = src.index("func handleWebSocketFrame")
    handler_end = src.index("func sourceLanguageTitle", handler_start)
    handler = src[handler_start:handler_end]
    render_start = src.index("func renderCaptions")
    render_end = src.index("func setCaption", render_start)
    render = src[render_start:render_end]
    notice_start = src.index("func translationUnavailableNotice")
    notice_end = src.index("func isCaptionHesitation", notice_start)
    notice = src[notice_start:notice_end]

    assert 'payload["translationUnavailableReason"]' in handler
    assert "liveCaptionUnavailableReason(" in handler
    assert "layoutCaptionLabels()" in handler
    assert 'status == "unavailable"' in src[src.index("func liveCaptionTranslationText"):notice_start]
    assert "translationUnavailableNotice(translationUnavailableReason)" in render
    assert "let mode = effectiveDisplayMode" in render
    # Translation-only falls back to showing source captions with the notice.
    assert "displayMode == .translation && !translationUnavailableReason.isEmpty ? .bilingual : displayMode" in src

    # Every reason the Host can publish has its own overlay notice.
    prefs = (SCRIPTS / "yulu_ui" / "src" / "captionPreferences.ts").read_text(encoding="utf-8")
    reasons_block = prefs[prefs.index("CAPTION_TRANSLATION_UNAVAILABLE_REASONS = ["):]
    reasons_block = reasons_block[:reasons_block.index("] as const")]
    reasons = re.findall(r'"([a-z_]+)"', reasons_block)
    assert reasons == ["provider_off", "needs_xai_audio", "needs_disclosure", "needs_connection"]
    for reason in reasons:
        assert f'"{reason}"' in notice


def test_caption_translation_no_longer_runs_hermes():
    server = (SCRIPTS / "yulu_ui" / "src" / "server.ts").read_text(encoding="utf-8")
    assert not (SCRIPTS / "realtime_translate.py").exists()
    assert "realtime_translate" not in server
    assert "Hermes live-caption translation" not in server
    assert "hermes-agent" not in server
    assert "captionTranslation.translate(" in server
    assert "translationAvailability: () => captionTranslation.availability()" in server
