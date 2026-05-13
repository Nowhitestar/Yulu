# Yulu Architecture Notes

Yulu is a local-first macOS meeting recorder and agent workbench.

## Layers

1. Capture/control
   - `record_audio.py`
   - Swift `audio_daemon.swift`
   - Swift `recorder_status.swift`
   - launchd plists

2. Transcription
   - realtime transcript path for fast feedback
   - final transcript path for quality recovery
   - raw transcript and cleaned transcript are separate files

3. Summary worker
   - `agent-queue.json` is the transparent event log
   - `queue_store.py` performs locked, atomic writes
   - `agent_queue_worker.py` claims `summary_request` events and writes final summaries
   - summary guardrails reject agent-event JSON and too-short/invalid outputs

4. Artifact workbench
   - `.summary.md` remains the portable text artifact
   - `.summary.html` is the editable workbench with embedded `artifact-data`
   - `html_artifact.py` adapts Yulu summary/transcript data to the artifact renderer

5. Agent interface
   - `skills/yulu/SKILL.md` documents the control surface for Hermes/雷子
   - `sync_skill.py` publishes the skill into local Hermes and l-skills backup

## Local-first boundaries

Yulu should not upload recordings, transcripts, or meeting metadata unless the user explicitly opts into a cloud workflow for a specific task.

## Current migration note

Lewis's machine still has an old OpenClaw runtime path. `doctor.py` reports any process using that path so migration can be done deliberately.
