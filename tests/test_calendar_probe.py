from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_native_calendar_probe_uses_eventkit_and_returns_enumeration_evidence():
    source = (SCRIPTS / "calendar_probe.swift").read_text(encoding="utf-8")

    assert "import EventKit" in source
    assert "authorizationStatus(for: .event)" in source
    assert "requestFullAccessToEvents" in source
    assert "predicateForEvents(withStart:" in source
    assert "events(matching:" in source
    assert '"enumerationSucceeded"' in source
    assert '"eventCount"' in source
    assert 'CommandLine.arguments.contains("--events")' in source
    assert 'CommandLine.arguments.contains("--self-test")' in source
    assert '"helper": "calendar_probe"' in source
    assert '"events": events.map(eventPayload)' in source
    assert "osascript" not in source


def test_calendar_probe_is_built_embedded_and_signed_inside_yulu_app():
    build = (SCRIPTS / "build_audio_daemon.sh").read_text(encoding="utf-8")
    helper_info = (SCRIPTS / "calendar_probe-Info.plist").read_text(encoding="utf-8")

    assert 'APP_CALENDAR_BIN="$APP/Contents/MacOS/calendar_probe"' in build
    assert 'swiftc "${SWIFT_TARGET[@]}" -o "$APP_CALENDAR_BIN" calendar_probe.swift' in build
    assert "-framework EventKit" in build
    assert "__info_plist" in build
    assert "calendar_probe-Info.plist" in build
    assert 'CALENDAR_BIN="$SCRIPT_DIR/calendar_probe"' not in build
    assert 'cp "$CALENDAR_BIN" "$APP_CALENDAR_BIN"' not in build
    assert 'codesign --force --options runtime --timestamp \\' in build
    assert '--sign "$IDENTITY" "$APP_CALENDAR_BIN"' in build
    assert 'NSCalendarsFullAccessUsageDescription' in build
    assert 'NSCalendarsUsageDescription' in build
    assert "com.yulu.calendarprobe" in helper_info
    assert "NSCalendarsFullAccessUsageDescription" in helper_info
    assert "NSCalendarsUsageDescription" in helper_info


def test_release_inventory_requires_calendar_probe_without_runtime_compilation():
    setup = (SCRIPTS / "setup_audio.sh").read_text(encoding="utf-8")
    package = (ROOT / "packaging" / "scripts" / "package.sh").read_text(encoding="utf-8")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

    binary = 'yulu/scripts/Yulu.app/Contents/MacOS/calendar_probe'
    assert '"$SCRIPT_DIR/Yulu.app/Contents/MacOS/calendar_probe"' in setup
    assert '"yulu/scripts/Yulu.app/Contents/MacOS/calendar_probe"' in package
    assert binary in package
    assert "yulu/scripts/calendar_probe" in gitignore


def test_production_paths_fail_closed_without_the_embedded_signed_helper():
    adapter = (SCRIPTS / "yulu_ui" / "src" / "calendarSourceAdapters.ts").read_text(encoding="utf-8")
    helpers = (SCRIPTS / "yulu_ui" / "src" / "nativeHelpers.ts").read_text(encoding="utf-8")
    polling = (SCRIPTS / "check_meetings.py").read_text(encoding="utf-8")

    assert "resolveNativeHelperPaths" in adapter
    assert "nativeHelperDir" in adapter
    assert 'join(options.scriptDir, "Yulu.app", "Contents", "MacOS")' in helpers
    assert 'calendarProbe: join(helperDir, "calendar_probe")' in helpers
    assert 'Yulu.app" / "Contents" / "MacOS" / "calendar_probe"' in polling
    assert 'return Path(__file__).resolve().parent / "calendar_probe"' not in polling


def test_calendar_probe_is_in_ci_and_release_deployment_target_gates():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    release = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(encoding="utf-8")

    assert "calendar_probe.swift" in ci
    assert "calendar_probe-Info.plist" in ci
    assert "__info_plist" in ci
    assert 'swiftc -target arm64-apple-macosx13.0 -o ".ci-build/calendar_probe"' in ci
    assert "-framework EventKit" in ci
    assert ".ci-build/calendar_probe" in ci
    assert "yulu/scripts/Yulu.app/Contents/MacOS/calendar_probe" in release
