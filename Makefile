.PHONY: doctor doctor-json test py-compile pytest swift-build dev-install-dry-run sync-skill sync-skill-dry-run public-dmg-acceptance-policy package checksums

PYTHON ?= python3
SWIFT_BUILD_DIR ?= .ci-build
YULU_TEST_TMP_ROOT ?= $(shell if [ -d /private/tmp ]; then echo /private/tmp; else echo /tmp; fi)
YULU_TEST_HOME ?= $(YULU_TEST_TMP_ROOT)/yulu-test-home
YULU_TEST_TMPDIR ?= $(YULU_TEST_TMP_ROOT)/yulu-pytest-tmp
YULU_TEST_SOCKET_DIR ?= $(YULU_TEST_TMP_ROOT)/yulu-test-sockets

PY_FILES := $(wildcard yulu/scripts/*.py)
SWIFT_FILES := yulu/scripts/audio_daemon.swift yulu/scripts/yulu_app.swift yulu/scripts/window_scanner.swift yulu/scripts/recorder_status.swift yulu/scripts/meeting_prompt.swift yulu/scripts/xai_keychain.swift yulu/scripts/calendar_probe.swift


doctor:
	$(PYTHON) yulu/scripts/doctor.py


doctor-json:
	$(PYTHON) yulu/scripts/doctor.py --json


py-compile:
	@set -e; \
	for f in $(PY_FILES); do \
		echo "py_compile $$f"; \
		$(PYTHON) -m py_compile "$$f"; \
	done


pytest:
	@mkdir -p "$(YULU_TEST_HOME)" "$(YULU_TEST_TMPDIR)" "$(YULU_TEST_SOCKET_DIR)"
	HOME="$(YULU_TEST_HOME)" TMPDIR="$(YULU_TEST_TMPDIR)" YULU_TEST_SOCKET_DIR="$(YULU_TEST_SOCKET_DIR)" $(PYTHON) -m pytest tests -q


swift-build:
	@set -e; \
	if command -v swiftc >/dev/null 2>&1; then \
		mkdir -p $(SWIFT_BUILD_DIR); \
		for f in $(SWIFT_FILES); do \
			stem="$$(basename "$$f" .swift)"; \
			case "$$stem" in \
				audio_daemon) \
					FW="-framework Cocoa -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreAudio -framework AudioToolbox" ;; \
				yulu_app) \
					FW="-framework Cocoa -framework WebKit" ;; \
				xai_keychain) \
					FW="-framework Security" ;; \
				calendar_probe) \
					FW="-framework EventKit -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker yulu/scripts/calendar_probe-Info.plist" ;; \
				*) \
					FW="" ;; \
			esac; \
			echo "swiftc $$f -> $(SWIFT_BUILD_DIR)/$$stem $$FW"; \
			swiftc -o "$(SWIFT_BUILD_DIR)/$$stem" "$$f" $$FW; \
		done; \
	else \
		echo "swiftc missing; skipping Swift build"; \
	fi


test: py-compile pytest swift-build


# Policy-only: deterministic harness construction plus controller fail-closed
# validation. This never performs clean-target interaction or formal acceptance.
public-dmg-acceptance-policy:
	$(PYTHON) -m pytest -q tests/test_public_dmg_harness.py tests/test_public_dmg_controller.py


dev-install-dry-run:
	$(PYTHON) yulu/scripts/dev_install.py


dev-install:
	$(PYTHON) yulu/scripts/dev_install.py --apply


sync-skill:
	$(PYTHON) yulu/scripts/sync_skill.py


sync-skill-dry-run:
	$(PYTHON) yulu/scripts/sync_skill.py --dry-run


package:
	@if [ -z "$(TAG)" ]; then echo "Usage: make package TAG=vX.Y.Z"; exit 1; fi
	bash packaging/scripts/package.sh "$(TAG)" $(PACKAGE_ARGS)


checksums:
	@if [ -z "$(TAG)" ]; then echo "Usage: make checksums TAG=vX.Y.Z"; exit 1; fi
	bash packaging/scripts/checksums.sh dist "$(TAG)"
