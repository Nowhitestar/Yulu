"""Real STT backends: mlx-whisper, whisper-cli, cloud.

Also hosts ``diarize.SherpaDiarizeBackend`` — a sibling *diarization* stage that mirrors the STT
backend lifecycle but is held OUT of the ASR fallback dict (it returns speaker turns, not text).
"""
