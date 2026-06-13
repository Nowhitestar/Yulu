.PHONY: doctor doctor-json test py-compile pytest swift-build dev-install-dry-run sync-skill sync-skill-dry-run package package-pkg checksums

PYTHON ?= python3
SWIFT_BUILD_DIR ?= .ci-build

PY_FILES := $(wildcard yulu/scripts/*.py)
SWIFT_FILES := yulu/scripts/audio_daemon.swift yulu/scripts/window_scanner.swift yulu/scripts/recorder_status.swift


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
	$(PYTHON) -m pytest tests -q


swift-build:
	@set -e; \
	if command -v swiftc >/dev/null 2>&1; then \
		mkdir -p $(SWIFT_BUILD_DIR); \
		for f in $(SWIFT_FILES); do \
			stem="$$(basename "$$f" .swift)"; \
			case "$$stem" in \
				audio_daemon) \
					FW="-framework Cocoa -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreAudio -framework AudioToolbox" ;; \
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


package-pkg:
	@if [ -z "$(TAG)" ]; then echo "Usage: make package-pkg TAG=vX.Y.Z"; exit 1; fi
	bash packaging/scripts/package_pkg.sh "$(TAG)" $(PACKAGE_PKG_ARGS)


checksums:
	bash packaging/scripts/checksums.sh dist
