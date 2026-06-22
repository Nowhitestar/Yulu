---
status: resolved
trigger: "Yulu calendar service keeps showing macOS Keychain prompt for gogcli even after Always Allow"
created: 2026-06-22
updated: 2026-06-22
---

# Debug Session: calendar-keychain-repeat-prompt

## Symptoms

- Expected behavior: After approving Keychain access once, Yulu calendar service should keep working without repeated prompts.
- Actual behavior: macOS repeatedly prompts that `security` wants to access the `gogcli` Keychain item.
- Error messages: Calendar service log shows repeated Google Calendar watch renewal failures and fallback syncs.
- Timeline: Observed on 2026-06-22 in the dev checkout investigation.
- Reproduction: Run the calendar service while watch renewal retries and Keychain access is not already settled.

## Current Focus

- hypothesis: `_get_gog_credentials()` shells out to `security` on every watch renewal, with only a 5s timeout, so prompts can be killed before Always Allow persists and successful reads are not reused.
- test: Add a focused regression test for successful credential caching and a longer Keychain timeout.
- expecting: The first successful Keychain read is cached in-process; later access-token refreshes do not re-trigger `security`.
- next_action: Done.

## Evidence

- timestamp: 2026-06-22
  note: `run_calendar_services.py` uses `security find-generic-password -s gogcli ... -w` with `timeout=5`.
- timestamp: 2026-06-22
  note: `renew_loop()` retries watch renewal every 300 seconds when watch state is expired.

## Eliminated

- hypothesis: Google OAuth authorization itself is missing.
  reason: Fallback `check_meetings.py` sync still fetched meetings, so gog calendar read can work.

## Resolution

- root_cause: `run_calendar_services.py` read the `gogcli` Keychain item on every watch renewal and allowed only 5 seconds for the macOS prompt, so retries could repeatedly spawn new `security` reads.
- fix: Cache successful gog credentials in-process and raise the Keychain read timeout to 60 seconds.
- verification: `pytest tests/test_calendar_keychain_credentials.py`
- files_changed: `yulu/scripts/run_calendar_services.py`, `tests/test_calendar_keychain_credentials.py`
