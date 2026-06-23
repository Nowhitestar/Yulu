---
status: resolved
trigger: "Realtime transcription produces hallucinated text when nobody is speaking; expected silence to emit empty realtime transcript and speech to emit transcript."
created: 2026-06-23
updated: 2026-06-23
---

# Realtime Silence Hallucinations

## Symptoms

- Expected behavior: live transcription emits no text for silent chunks.
- Actual behavior: recent `.realtime.transcript.txt` files contain repeated filler such as "BotBot...", "BellBell...", "Thank you.", and repeated Chinese characters during apparent silence or weak audio.
- Error messages: none reported by the user.
- Timeline: observed in recent Yulu recordings.
- Reproduction: record a meeting with quiet gaps and inspect the realtime transcript.

## Current Focus

- hypothesis: live chunks are sent to Whisper even when the chunk is silent or low-energy, so the model hallucinates text under prompt/context pressure.
- test: add a conservative live-chunk silence gate before scheduler submission, then verify silent chunks emit empty partials while voiced chunks still dispatch.
- expecting: zero backend calls for clearly silent chunks; partial events with advanced coverage and empty text; unchanged behavior for voiced chunks.
- next_action: monitor the next real meeting; separately investigate post-MLX live chunk health hangs if they recur.

## Evidence

- 2026-06-23: `AgentkeyOpsMktWeekly_20260623_160021.realtime.transcript.txt` tail includes repeated "能够..." text.
- 2026-06-23: `GoogleChrome_20260618_182111.realtime.transcript.txt` tail includes repeated "BotBot...", "BellBell...", and "Thank you." filler.
- 2026-06-23: install-state smoke appended 2s silence to a temporary live WAV and received an empty realtime partial with `model_loaded=false`, confirming silence no longer enters Whisper.
- 2026-06-23: install-state voice-only live smoke appended a local `say` sample and received non-empty partial text, confirming voiced chunks still dispatch.

## Eliminated

- hypothesis: UI rendering duplicates or invents text.
  reason: the junk text is already present in `.realtime.transcript.txt` artifacts.

## Resolution

- root_cause: live chunks were sent to Whisper even when the chunk contained only silence or room tone; realtime chunks also inherited previous-text conditioning, which increased hallucination risk.
- fix: `stt_daemon.live_session` now skips silent live chunks before scheduler submission, emits an empty partial to advance realtime coverage, and disables previous-text conditioning for voiced realtime chunks.
- verification: `python3 -m pytest tests/test_stt_live_session_robustness.py -q` passed; adjacent stride/dual-track/scheduler/mlx backend tests passed; `make dev-install` completed; `make doctor` is green after restarting stt_daemon.
- files_changed: `yulu/scripts/stt_daemon/live_session.py`, `tests/test_stt_live_session_robustness.py`
