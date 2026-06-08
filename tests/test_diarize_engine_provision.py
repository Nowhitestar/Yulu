"""PORT-01 (Phase 15) — setup_models.sh provisions the sherpa-onnx ENGINE idempotently.

The Python-3.14 probe (15-SUMMARY) resolved that the sherpa-onnx cp314 wheel installs + imports
+ diarizes on Yulu's runtime interpreter, so the engine CO-LOCATES in the daemon interpreter
(no isolated venv). setup_models.sh's diarization step therefore:

  * is GATED on transcription.diarization.enabled (a non-diarization install pulls nothing extra);
  * installs sherpa-onnx into ``$PYTHON_BIN`` (the daemon interpreter == plist ``__PYTHON__``);
  * is IDEMPOTENT: when sherpa-onnx is already importable, it SKIPS the pip install entirely;
  * never aborts the install on a pip failure (WARN-only) so plain transcription is unaffected.

These tests drive the REAL bash function ``install_diarization_engine`` with a controllable
fake ``$PYTHON_BIN`` so no real pip/network/sherpa is touched (CI-safe). The fake records every
invocation to a log and decides "is sherpa importable?" from a marker file it creates on a
simulated ``pip install`` — so a second call sees it already present and skips.
"""

import os
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
SETUP_MODELS = SCRIPTS / "setup_models.sh"


def _write_fake_python(path: Path, marker: Path, log: Path, *, install_succeeds: bool) -> None:
    """A fake ``python3`` that emulates just the two calls the engine step makes.

    1. ``python3 -c "import importlib.util...find_spec('sherpa_onnx')..."`` (the import probe):
       exit 0 iff the marker file exists (sherpa "installed"), else exit 1.
    2. ``python3 -m pip install --upgrade sherpa-onnx`` (the install): create the marker (so a
       subsequent probe reports importable) and exit 0, OR exit 1 when install_succeeds is False.

    Every call is appended to ``log`` so the test can assert how many installs ran.
    """
    succeed = "1" if install_succeeds else "0"
    import sys as _sys
    real_py = _sys.executable
    script = f"""#!/usr/bin/env bash
echo "ARGS: $*" >> {log}
# (2) the pip install branch — argv contains: -m pip install ... sherpa-onnx
case "$*" in
  *"-m pip install"*"sherpa-onnx"*)
    if [[ "{succeed}" == "1" ]]; then
      : > {marker}      # mark sherpa as now-importable
      exit 0
    else
      exit 1
    fi
    ;;
esac
# (1) the import probe branch — argv contains find_spec('sherpa_onnx')
case "$*" in
  *"find_spec('sherpa_onnx')"*)
    [[ -f {marker} ]] && exit 0 || exit 1
    ;;
esac
# (3) everything else (the config-reading heredocs like diarization_enabled): delegate to a
# REAL interpreter so the gate's actual config logic runs against the test config.
exec {real_py} "$@"
"""
    path.write_text(script)
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _write_fake_python_external_managed(path: Path, marker: Path, log: Path) -> None:
    """A fake interpreter where system pip is blocked but --user fallback succeeds."""
    import sys as _sys
    real_py = _sys.executable
    script = f"""#!/usr/bin/env bash
echo "ARGS: $*" >> {log}
case "$*" in
  *"-m pip install"*"--user"*"--break-system-packages"*"sherpa-onnx"*)
    : > {marker}
    exit 0
    ;;
  *"-m pip install"*"sherpa-onnx"*)
    exit 1
    ;;
esac
case "$*" in
  *"find_spec('sherpa_onnx')"*)
    [[ -f {marker} ]] && exit 0 || exit 1
    ;;
esac
exec {real_py} "$@"
"""
    path.write_text(script)
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _run_engine_install(tmp_path: Path, fake_py: Path) -> subprocess.CompletedProcess:
    """Source setup_models.sh and call install_diarization_engine with the fake interpreter."""
    home = tmp_path / "home"
    (home / ".config" / "yulu").mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "PYTHON_BIN": str(fake_py),
        "CONFIG_DIR": str(home / ".config" / "yulu"),
        "MODEL_DIR": str(home / ".config" / "yulu" / "models"),
    })
    snippet = (
        f'set -uo pipefail; . "{SETUP_MODELS}"; install_diarization_engine'
    )
    return subprocess.run(["bash", "-c", snippet], cwd=str(SCRIPTS),
                          env=env, capture_output=True, text=True, check=False)


def test_engine_install_runs_pip_when_absent(tmp_path):
    """sherpa not importable → exactly one pip install runs and it ends importable."""
    marker = tmp_path / "sherpa_installed"
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    result = _run_engine_install(tmp_path, fake)
    assert result.returncode == 0, result.stderr + result.stdout
    calls = log.read_text() if log.exists() else ""
    assert calls.count("-m pip install") == 1, f"expected exactly one install:\n{calls}"
    assert marker.exists()  # sherpa is now "installed"


def test_engine_install_falls_back_to_user_install_for_externally_managed_python(tmp_path):
    marker = tmp_path / "sherpa_installed"
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python_external_managed(fake, marker, log)

    result = _run_engine_install(tmp_path, fake)
    assert result.returncode == 0, result.stderr + result.stdout
    calls = log.read_text() if log.exists() else ""
    assert calls.count("-m pip install") == 2, calls
    assert "--user --break-system-packages" in calls
    assert marker.exists()


def test_engine_install_is_idempotent_skips_when_present(tmp_path):
    """sherpa ALREADY importable → the pip install is NEVER spawned (idempotency)."""
    marker = tmp_path / "sherpa_installed"
    marker.write_text("")  # pre-existing → importable from the start
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    result = _run_engine_install(tmp_path, fake)
    assert result.returncode == 0, result.stderr + result.stdout
    calls = log.read_text() if log.exists() else ""
    assert "-m pip install" not in calls, f"install must be skipped when present:\n{calls}"


def test_engine_install_second_call_skips_after_first_installs(tmp_path):
    """Two sequential calls: first installs, second sees it present and skips (re-run safety)."""
    marker = tmp_path / "sherpa_installed"
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    first = _run_engine_install(tmp_path, fake)
    second = _run_engine_install(tmp_path, fake)
    assert first.returncode == 0 and second.returncode == 0
    calls = log.read_text()
    assert calls.count("-m pip install") == 1, f"only the FIRST call installs:\n{calls}"


def test_engine_install_failure_does_not_abort(tmp_path):
    """A failed pip install WARNS but returns 0 (never abort the install; plain transcription
    is unaffected and the probe will report present-but-unverified)."""
    marker = tmp_path / "sherpa_installed"
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=False)

    result = _run_engine_install(tmp_path, fake)
    assert result.returncode == 0, "engine-install failure must not abort the script"
    assert "sherpa-onnx" in (result.stdout + result.stderr)


def test_disabled_diarization_skips_engine_and_models(tmp_path):
    """The whole diarization step (engine + models) is gated: a config without diarization
    enabled invokes neither the import probe nor the pip install."""
    home = tmp_path / "home"
    cfg_dir = home / ".config" / "yulu"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    # A config with diarization explicitly disabled.
    (cfg_dir / "config.json").write_text(
        '{"transcription": {"diarization": {"enabled": false}}}'
    )
    log = tmp_path / "py_calls.log"
    marker = tmp_path / "sherpa_installed"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "PYTHON_BIN": str(fake),
        "CONFIG_DIR": str(cfg_dir),
        "MODEL_DIR": str(cfg_dir / "models"),
    })
    snippet = f'set -uo pipefail; . "{SETUP_MODELS}"; setup_diarization_models'
    result = subprocess.run(["bash", "-c", snippet], cwd=str(SCRIPTS),
                            env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr + result.stdout
    calls = log.read_text() if log.exists() else ""
    # The disabled gate uses $PYTHON_BIN only for diarization_enabled() (the config read),
    # never the install branch — so no pip install is attempted.
    assert "-m pip install" not in calls, f"disabled → no engine install:\n{calls}"


# ════════════════════════════════════════════════════════════════════════════
# PORT-03 — migration/upgrade re-provisions diarization idempotently + no data loss
#
# The upgrade path (`yulu update` → `setup.sh --upgrade`) re-runs setup_models.sh. These
# tests drive setup_diarization_models over a HOME carrying USER DATA (recordings + a
# .speakers.json sidecar) with curl + the engine install stubbed, and assert: (a) the
# enabled step downloads the two ONNX once and a SECOND run skips them (idempotent), and
# (b) user recordings/transcripts/sidecars are byte-for-byte untouched, and recordings
# WITHOUT a sidecar are left with no labels (criterion 3).
# ════════════════════════════════════════════════════════════════════════════


def _diar_env_with_user_data(tmp_path, fake_py, curl_stub):
    """A HOME with diarization enabled in config + irreplaceable user data + stubbed externals."""
    home = tmp_path / "home"
    cfg_dir = home / ".config" / "yulu"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.json").write_text(
        '{"transcription": {"diarization": {"enabled": true}}}'
    )
    # Irreplaceable user data living under the data dir (recordings + one labelled sidecar +
    # one recording with NO sidecar — which must stay unlabelled).
    rec = home / "Movies" / "Yulu"
    rec.mkdir(parents=True, exist_ok=True)
    (rec / "m1.wav").write_bytes(b"RIFF\x00\x00WAVdata-audio")
    (rec / "m1.transcript.txt").write_text("hello transcript", encoding="utf-8")
    (rec / "m1.speakers.json").write_text('{"speakers": {"S1": "Alex"}}', encoding="utf-8")
    (rec / "m2.wav").write_bytes(b"RIFF\x00\x00WAVdata-two")  # no sidecar → stays unlabelled
    shim = tmp_path / "shim"
    shim.mkdir(exist_ok=True)
    (shim / "curl").write_text(curl_stub)
    (shim / "curl").chmod(0o755)
    (shim / "tar").write_text("#!/usr/bin/env bash\nexit 0\n")  # never reached (seg pre-staged)
    (shim / "tar").chmod(0o755)
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "PATH": f"{shim}{os.pathsep}{env.get('PATH', '')}",
        "PYTHON_BIN": str(fake_py),
        "CONFIG_DIR": str(cfg_dir),
        "MODEL_DIR": str(cfg_dir / "models"),
        "DIAR_DIR": str(cfg_dir / "models" / "diarization"),
    })
    return env, rec


def _snapshot(rec: Path) -> dict:
    return {p.name: p.read_bytes() for p in rec.iterdir() if p.is_file()}


def test_migration_provisions_diarization_idempotently_no_data_loss(tmp_path):
    marker = tmp_path / "sherpa_installed"
    marker.write_text("")  # engine already importable → isolate the model-download idempotency
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    # A curl stub that "downloads" by writing a non-empty requested -o target (so a 2nd run sees it present).
    curl_stub = (
        "#!/usr/bin/env bash\n"
        'args=("$@")\n'
        'for ((i=0;i<${#args[@]};i++)); do\n'
        '  if [[ "${args[$i]}" == "-o" ]]; then printf model > "${args[$((i+1))]}"; fi\n'
        'done\n'
        "exit 0\n"
    )
    env, rec = _diar_env_with_user_data(tmp_path, fake, curl_stub)
    before = _snapshot(rec)

    # Pre-stage the seg model so the tar-extract branch is skipped (we only test idempotency here).
    diar_dir = Path(env["DIAR_DIR"]); diar_dir.mkdir(parents=True, exist_ok=True)
    (diar_dir / "segmentation.onnx").write_bytes(b"seg")

    snippet = f'set -uo pipefail; . "{SETUP_MODELS}"; setup_diarization_models'
    first = subprocess.run(["bash", "-c", snippet], cwd=str(SCRIPTS),
                           env=env, capture_output=True, text=True, check=False)
    second = subprocess.run(["bash", "-c", snippet], cwd=str(SCRIPTS),
                            env=env, capture_output=True, text=True, check=False)
    assert first.returncode == 0, first.stderr + first.stdout
    assert second.returncode == 0, second.stderr + second.stdout

    # (a) Idempotency: the cam++ emb file exists after the first run; the second run reports it
    # already present (skip) rather than re-downloading.
    assert (diar_dir / "campplus.onnx").exists()
    assert "已存在" in second.stdout or "exists" in second.stdout.lower()

    # (b) NO DATA LOSS: every user file is byte-for-byte unchanged across both provisioning runs.
    after = _snapshot(rec)
    assert after == before, "diarization provisioning must not touch user recordings/transcripts/sidecars"

    # (c) The recording with no sidecar stays unlabelled (no sidecar invented for it).
    assert not (rec / "m2.speakers.json").exists()


def test_zero_byte_diarization_model_is_not_treated_as_present(tmp_path):
    marker = tmp_path / "sherpa_installed"
    marker.write_text("")
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    curl_stub = (
        "#!/usr/bin/env bash\n"
        'args=("$@")\n'
        'for ((i=0;i<${#args[@]};i++)); do\n'
        '  if [[ "${args[$i]}" == "-o" ]]; then printf model > "${args[$((i+1))]}"; fi\n'
        'done\n'
        "exit 0\n"
    )
    env, _rec = _diar_env_with_user_data(tmp_path, fake, curl_stub)
    diar_dir = Path(env["DIAR_DIR"]); diar_dir.mkdir(parents=True, exist_ok=True)
    (diar_dir / "segmentation.onnx").write_bytes(b"seg")
    (diar_dir / "campplus.onnx").write_bytes(b"")

    snippet = f'set -uo pipefail; . "{SETUP_MODELS}"; setup_diarization_models'
    result = subprocess.run(["bash", "-c", snippet], cwd=str(SCRIPTS),
                            env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr + result.stdout
    assert (diar_dir / "campplus.onnx").stat().st_size > 0


def test_diarization_models_fall_back_to_huggingface_when_github_release_download_fails(tmp_path):
    marker = tmp_path / "sherpa_installed"
    marker.write_text("")
    log = tmp_path / "py_calls.log"
    fake = tmp_path / "fake_python3"
    _write_fake_python(fake, marker, log, install_succeeds=True)

    curl_log = tmp_path / "curl_calls.log"
    curl_stub = f"""#!/usr/bin/env bash
args=("$@")
url=""
out=""
for ((i=0;i<${{#args[@]}};i++)); do
  if [[ "${{args[$i]}}" == http* ]]; then url="${{args[$i]}}"; fi
  if [[ "${{args[$i]}}" == "-o" ]]; then out="${{args[$((i+1))]}}"; fi
done
echo "$url" >> {curl_log}
if [[ "$url" == *github.com* ]]; then
  exit 22
fi
printf hf-model > "$out"
exit 0
"""
    env, _rec = _diar_env_with_user_data(tmp_path, fake, curl_stub)
    diar_dir = Path(env["DIAR_DIR"]); diar_dir.mkdir(parents=True, exist_ok=True)

    snippet = f'set -uo pipefail; . "{SETUP_MODELS}"; setup_diarization_models'
    result = subprocess.run(["bash", "-c", snippet], cwd=str(SCRIPTS),
                            env=env, capture_output=True, text=True, check=False)

    assert result.returncode == 0, result.stderr + result.stdout
    assert (diar_dir / "campplus.onnx").read_bytes() == b"hf-model"
    assert (diar_dir / "segmentation.onnx").read_bytes() == b"hf-model"
    calls = curl_log.read_text()
    assert "github.com/k2-fsa/sherpa-onnx" in calls
    assert "huggingface.co/csukuangfj/speaker-embedding-models" in calls
    assert "huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0" in calls
