"""Cross-language contract for the live notes panel (ADR-012).

The panel is Swift and the page it hosts is React; these source checks keep
their bridge aligned, keep the panel on Yulu's own pages, and keep the retired
live-caption translation out.
"""

from __future__ import annotations

import re
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
UI = SCRIPTS / "yulu_ui"
ROUTE_PATTERN = "^/(settings|inbox)(/[a-z0-9-]+)*(#[a-z0-9-]+)?$"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_panel_handles_exactly_what_the_page_asks_for():
    swift = _read(SCRIPTS / "recorder_status.swift")
    page = _read(UI / "web" / "src" / "routes" / "live.tsx")
    css = _read(UI / "web" / "src" / "routes" / "live.css")

    posted = set(re.findall(r'postMessage\(\{ action: "([a-z]+)"', page))
    assert posted == {"collapse", "drag", "stop", "open", "appearance"}
    parse = swift[swift.index("static func parse"):swift.index("/// The recording state the page shows")]
    assert set(re.findall(r'case "([a-z]+)":', parse)) == posted

    assert 'name: "yuluPanel"' in swift and "yuluPanel" in page
    assert "CustomEvent('yulu-panel'" in swift and '"yulu-panel"' in page
    assert "window.__yuluPanelState" in swift and "__yuluPanelState" in page
    assert "dataset.yuluPanel = 'true'" in swift and 'data-yulu-panel="true"' in css
    assert '/live")' in swift


def test_panel_opens_only_yulu_pages_through_the_companion():
    swift = _read(SCRIPTS / "recorder_status.swift")
    status_agent = _read(SCRIPTS / "status_agent.swift")
    page = _read(UI / "web" / "src" / "routes" / "live.tsx")

    assert f'"{ROUTE_PATTERN}"' in swift
    assert f'"{ROUTE_PATTERN}"' in status_agent
    assert '"open_route"' in swift
    assert 'case "open_route":' in status_agent
    assert "isAllowedNativeRoute(route)" in status_agent
    for route in re.findall(r'route: "([^"]+)"', page):
        assert re.match(ROUTE_PATTERN, route), route
    for route in ("/live", "https://example.com", "//example.com/settings", "/settings/../x", "/settings?x=1"):
        assert not re.match(ROUTE_PATTERN, route), route


def test_panel_keeps_the_webview_on_live_and_opens_links_only_when_clicked():
    swift = _read(SCRIPTS / "recorder_status.swift")
    decide = swift[swift.index("decidePolicyFor navigationAction"):swift.index("createWebViewWith configuration")]
    assert "isPanelPage(url)" in decide
    assert ".linkActivated" in decide
    assert '"https"' in decide
    assert "decisionHandler(.cancel)" in decide
    assert "websiteDataStore = .nonPersistent()" in swift
    assert 'origin.host == "127.0.0.1", origin.port == port' in swift


def test_live_caption_translation_is_retired():
    for retired in (
        UI / "src" / "captionTranslation.ts",
        UI / "src" / "captionPreferences.ts",
        UI / "src" / "routers" / "captionTranslation.ts",
        UI / "web" / "src" / "components" / "settings" / "CaptionTranslationSettings.tsx",
        SCRIPTS / "realtime_translate.py",
    ):
        assert not retired.exists(), retired
    server = _read(UI / "src" / "server.ts")
    realtime = _read(UI / "src" / "realtimeTranscription.ts")
    swift = _read(SCRIPTS / "recorder_status.swift")
    assert "/api/recordings/realtime/options" not in server
    assert "captionTranslation" not in server
    assert "hermes-agent" not in server
    assert "translat" not in realtime.lower()
    assert "translat" not in swift.lower()
    assert "realtime/options" not in swift
