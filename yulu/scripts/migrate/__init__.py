"""Seamless auto-migration pipeline for existing v0.5.x ``~/.yulu`` installs (MIG-01, D-05).

The ``migrate`` package is the four-stage ``detect → plan → apply → verify``
pipeline that upgrades a pre-Phase-6 install to the current model with NO data
loss and NO reconfiguration:

  * ``detect.py``  — recognize a v0.5.x install (``.yulu-install.json``
    ``schema_version`` absent / older, or the legacy ``venv-mlx-whisper`` /
    ``transcription.mlx.python`` layout); a current install reports up-to-date.
  * ``plan.py``    — a dry-run-able, ordered ``MigrationPlan`` naming every
    in-transit correction (drop dead ``transcription.mlx.python``, route the
    hardcoded ``~/Movies/Yulu`` through ``PathResolver``, stamp ``schema_version``)
    while mutating NOTHING.
  * ``apply.py`` / ``verify.py`` / rollback — the transactional half (Plan 03).

This plan (07-01) builds the read-only front — ``detect`` + ``plan`` — so the
destructive ``apply`` is always driven by an already-proven, dry-run-rendered
plan. detect and plan perform ZERO mutation.
"""
