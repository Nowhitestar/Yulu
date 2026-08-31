from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from test_public_dmg_harness import _build


TAG = "v0.22.2"
COMMIT = "2d01fa2989c1a9ae1a95266438bb278c72fac8c3"
BASE_URL = f"https://github.com/Nowhitestar/Yulu/releases/download/{TAG}"
CHECKSUMS_URL = f"{BASE_URL}/checksums.txt"
INSTALLER_URL = f"{BASE_URL}/install.sh"
ARCHIVE_NAME = f"yulu-macos-arm64-{TAG}.zip"
ARCHIVE_URL = f"{BASE_URL}/{ARCHIVE_NAME}"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_command(path: Path, source: str) -> None:
    path.write_text(f"#!/bin/bash\nset -euo pipefail\n{source}\n")
    path.chmod(0o755)


def _fixture(
    tmp_path: Path,
    *,
    provenance: str | None = None,
) -> tuple[Path, dict[str, str], Path, Path, Path]:
    assets = tmp_path / "browser-downloads"
    assets.mkdir(parents=True)
    archive = assets / ARCHIVE_NAME
    archive.write_bytes(b"public v0.22.2 archive fixture\n")
    installer = assets / "install.sh"
    _write_command(installer, r'''
EMBEDDED_HELPER_BASE64="policy-fixture-embedded-helper"
printf 'private installer stdout bait\n'
printf 'private installer stderr bait\n' >&2
printf '%s\n' "$INSTALL_DIR|$*" >> "$FAKE_INSTALL_LOG"
/bin/mkdir -p "$INSTALL_DIR/yulu/scripts"
printf '0.22.2\n' > "$INSTALL_DIR/VERSION"
printf '#!/bin/bash\n' > "$INSTALL_DIR/yulu/scripts/setup.sh"
printf '#!/bin/bash\n' > "$INSTALL_DIR/yulu/scripts/yulu"
/bin/chmod 755 "$INSTALL_DIR/yulu/scripts/setup.sh" "$INSTALL_DIR/yulu/scripts/yulu"
printf '{\n  "schema": 1,\n  "source": "release",\n  "version": "v0.22.2",\n  "asset": "yulu-macos-arm64-v0.22.2.zip",\n  "sha256": "%s"\n}\n' \
  "$FAKE_ARCHIVE_SHA256" > "$INSTALL_DIR/.yulu-install.json"
''')
    checksums = assets / "checksums.txt"
    checksums.write_text(
        f"{_sha(installer)}  install.sh\n{_sha(archive)}  {ARCHIVE_NAME}\n"
    )

    fake_bin = tmp_path / "fake-system"
    fake_bin.mkdir()
    _write_command(fake_bin / "xattr", "printf '0081;66d00000;Safari;fixture\\n'")
    if provenance is not None:
        _write_command(fake_bin / "mdls", f"printf '%b\\n' {json.dumps(provenance)}")
    else:
        _write_command(fake_bin / "mdls", f'''case "${{@: -1}}" in
  */checksums.txt) printf '%s\\n' '{CHECKSUMS_URL}' ;;
  */install.sh) printf '%s\\n' '{INSTALLER_URL}' ;;
  */{ARCHIVE_NAME}) printf '%s\\n' '{ARCHIVE_URL}' ;;
  *) exit 1 ;;
esac''')

    delivery = tmp_path / "delivery"
    built = _build(delivery)
    assert built.returncode == 0, built.stderr
    install_dir = tmp_path / "legacy-home" / ".yulu"
    install_dir.parent.mkdir()
    evidence_root = tmp_path / "evidence"
    policy_home = tmp_path / "target-home"
    policy_home.mkdir(exist_ok=True)
    applications = tmp_path / "Applications"
    applications.mkdir(exist_ok=True)
    log = tmp_path / "installer.log"
    env = dict(os.environ)
    env.update({
        "HOME": str(policy_home),
        "YULU_V022_BASELINE_TEST_BIN": str(fake_bin),
        "YULU_V022_BASELINE_TEST_HOME": str(policy_home),
        "YULU_V022_BASELINE_TEST_APPLICATIONS": str(applications),
        "YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256": _sha(checksums),
        "YULU_V022_BASELINE_TEST_INSTALLER_SHA256": _sha(installer),
        "YULU_V022_BASELINE_TEST_ARCHIVE_SHA256": _sha(archive),
        "FAKE_ARCHIVE_SHA256": _sha(archive),
        "FAKE_INSTALL_LOG": str(log),
        "YULU_DURABLE_SYNC_POLICY_LOG": str(tmp_path / "sync.log"),
    })
    return delivery, env, checksums, installer, archive


def _run(
    tmp_path: Path,
    *,
    extra_env: dict[str, str] | None = None,
    arg_mutations: dict[str, str] | None = None,
    provenance: str | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path, dict[str, str]]:
    delivery, env, checksums, installer, archive = _fixture(tmp_path, provenance=provenance)
    if extra_env:
        env.update(extra_env)
    install_dir = tmp_path / "legacy-home" / ".yulu"
    evidence_root = tmp_path / "evidence"
    values = {
        "--checksums": str(checksums),
        "--checksums-url": CHECKSUMS_URL,
        "--installer": str(installer),
        "--installer-url": INSTALLER_URL,
        "--archive": str(archive),
        "--archive-url": ARCHIVE_URL,
        "--install-dir": str(install_dir),
        "--evidence-dir": str(evidence_root),
        "--run-id": "v022-policy",
    }
    values.update(arg_mutations or {})
    args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
    ]
    for name, value in values.items():
        args.extend([name, value])
    result = subprocess.run(
        args,
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, install_dir, evidence_root / "v022-policy", env


def test_policy_preparer_runs_only_verified_public_installer_and_resumes(tmp_path: Path) -> None:
    result, install_dir, ledger, env = _run(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "private installer" not in result.stdout + result.stderr
    evidence = json.loads(result.stdout)
    assert evidence == {
        "schema": 1,
        "classification": "v0.22.2_baseline_policy_test",
        "formalAcceptance": False,
        "status": "installed",
        "tag": TAG,
        "sourceCommit": COMMIT,
        "digests": {
            "checksums": env["YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256"],
            "installer": env["YULU_V022_BASELINE_TEST_INSTALLER_SHA256"],
            "archive": env["YULU_V022_BASELINE_TEST_ARCHIVE_SHA256"],
        },
        "urls": {
            "checksums": CHECKSUMS_URL,
            "installer": INSTALLER_URL,
            "archive": ARCHIVE_URL,
        },
        "installDir": str(install_dir),
        "version": "0.22.2",
        "publicAssetVerified": False,
    }
    assert (tmp_path / "installer.log").read_text().splitlines() == [
        f"{install_dir}|--version {TAG}",
    ]
    assert (ledger.stat().st_mode & 0o777) == 0o700
    assert {path.name for path in ledger.iterdir()} == {
        "v0.22.2-baseline.json", "v0.22.2-baseline.state",
    }
    assert all((path.stat().st_mode & 0o777) == 0o600 for path in ledger.iterdir())
    sync_calls = (tmp_path / "sync.log").read_text().splitlines()
    assert any(call.startswith(str(ledger / ".v0.22.2-baseline.state.")) for call in sync_calls)
    assert any(call.startswith(str(ledger / ".v0.22.2-baseline.json.")) for call in sync_calls)
    assert len(sync_calls) % 2 == 0
    assert all(call.startswith(str(ledger / ".")) for call in sync_calls[::2])
    assert sync_calls[1::2] == [str(ledger)] * (len(sync_calls) // 2)

    resumed = subprocess.run(
        result.args,
        cwd=tmp_path,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert resumed.returncode == 0, resumed.stderr
    assert json.loads(resumed.stdout) == evidence
    assert (tmp_path / "installer.log").read_text().splitlines() == [
        f"{install_dir}|--version {TAG}",
    ]
    assert not (Path(env["YULU_V022_BASELINE_TEST_HOME"]) / "Library/Application Support/Yulu").exists()
    assert not (Path(env["YULU_V022_BASELINE_TEST_APPLICATIONS"]) / "Yulu.app").exists()


def test_policy_preparer_accepts_github_release_asset_redirect_provenance(tmp_path: Path) -> None:
    provenance = (
        '(\n    "https://release-assets.githubusercontent.com/github-production-release-asset/'
        '1223740140/v022-fixture?download=1",\n'
        '    "https://github.com/Nowhitestar/Yulu/releases"\n)'
    )
    result, *_ = _run(tmp_path, provenance=provenance)
    assert result.returncode == 0, result.stderr


def test_policy_preparer_rejects_embedded_github_release_asset_url(tmp_path: Path) -> None:
    provenance = (
        "https://evil.example/?next="
        "https://release-assets.githubusercontent.com/github-production-release-asset/fake"
    )
    result, *_ = _run(tmp_path, provenance=provenance)
    assert result.returncode != 0
    assert "browser provenance" in result.stderr.lower()


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ({"--installer-url": "https://example.invalid/install.sh"}, "exact public"),
        ({"--archive": "relative.zip"}, "absolute"),
        ({"--checksums-url": f"{BASE_URL}/wrong.txt"}, "exact public"),
    ],
)
def test_preparer_rejects_non_public_or_unsafe_inputs(
    tmp_path: Path,
    mutation: dict[str, str],
    message: str,
) -> None:
    result, _install_dir, _ledger, _env = _run(tmp_path, arg_mutations=mutation)
    assert result.returncode != 0
    assert message in result.stderr.lower()
    assert not (tmp_path / "installer.log").exists()


def test_preparer_rejects_bad_digest_provenance_embedded_helper_and_checksum_rows(tmp_path: Path) -> None:
    cases = []

    digest_root = tmp_path / "digest"
    result, *_ = _run(digest_root, extra_env={"YULU_V022_BASELINE_TEST_INSTALLER_SHA256": "0" * 64})
    cases.append((result, "digest"))

    provenance_root = tmp_path / "provenance"
    delivery, env, checksums, installer, archive = _fixture(provenance_root)
    _write_command(
        Path(env["YULU_V022_BASELINE_TEST_BIN"]) / "mdls",
        "printf 'https://release-assets.githubusercontent.com.evil.example/wrong\\n'",
    )
    values = {
        "--checksums": str(checksums), "--checksums-url": CHECKSUMS_URL,
        "--installer": str(installer), "--installer-url": INSTALLER_URL,
        "--archive": str(archive), "--archive-url": ARCHIVE_URL,
        "--install-dir": str(provenance_root / "legacy-home/.yulu"),
        "--evidence-dir": str(provenance_root / "evidence"), "--run-id": "v022-policy",
    }
    (provenance_root / "legacy-home").mkdir(exist_ok=True)
    provenance_args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
    ]
    for name, value in values.items():
        provenance_args.extend([name, value])
    cases.append((subprocess.run(
        provenance_args, cwd=provenance_root, env=env, text=True,
        capture_output=True, check=False,
    ), "provenance"))

    embedded_root = tmp_path / "embedded"
    delivery, env, checksums, installer, archive = _fixture(embedded_root)
    installer.write_text(installer.read_text().replace(
        'EMBEDDED_HELPER_BASE64="policy-fixture-embedded-helper"',
        'EMBEDDED_HELPER_BASE64="__YULU_EMBEDDED_RELEASE_INSTALLER_BASE64__"',
    ))
    env["YULU_V022_BASELINE_TEST_INSTALLER_SHA256"] = _sha(installer)
    checksums.write_text(f"{_sha(installer)}  install.sh\n{_sha(archive)}  {ARCHIVE_NAME}\n")
    env["YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256"] = _sha(checksums)
    values.update({
        "--checksums": str(checksums), "--installer": str(installer), "--archive": str(archive),
        "--install-dir": str(embedded_root / "legacy-home/.yulu"),
        "--evidence-dir": str(embedded_root / "evidence"),
    })
    (embedded_root / "legacy-home").mkdir(exist_ok=True)
    embedded_args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
    ]
    for name, value in values.items():
        embedded_args.extend([name, value])
    cases.append((subprocess.run(
        embedded_args, cwd=embedded_root, env=env, text=True,
        capture_output=True, check=False,
    ), "embedded"))

    duplicate_root = tmp_path / "duplicate"
    delivery, env, checksums, installer, archive = _fixture(duplicate_root)
    checksums.write_text(checksums.read_text() + f"{_sha(archive)}  {ARCHIVE_NAME}\n")
    env["YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256"] = _sha(checksums)
    values.update({
        "--checksums": str(checksums), "--installer": str(installer), "--archive": str(archive),
        "--install-dir": str(duplicate_root / "legacy-home/.yulu"),
        "--evidence-dir": str(duplicate_root / "evidence"),
    })
    (duplicate_root / "legacy-home").mkdir(exist_ok=True)
    duplicate_args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
    ]
    for name, value in values.items():
        duplicate_args.extend([name, value])
    cases.append((subprocess.run(
        duplicate_args, cwd=duplicate_root, env=env, text=True,
        capture_output=True, check=False,
    ), "duplicate"))

    malformed_root = tmp_path / "malformed"
    delivery, env, checksums, installer, archive = _fixture(malformed_root)
    checksums.write_text(checksums.read_text() + "not-a-checksum-row\n")
    env["YULU_V022_BASELINE_TEST_CHECKSUMS_SHA256"] = _sha(checksums)
    values.update({
        "--checksums": str(checksums), "--installer": str(installer), "--archive": str(archive),
        "--install-dir": str(malformed_root / "legacy-home/.yulu"),
        "--evidence-dir": str(malformed_root / "evidence"),
    })
    malformed_args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
    ]
    for name, value in values.items():
        malformed_args.extend([name, value])
    cases.append((subprocess.run(
        malformed_args, cwd=malformed_root, env=env, text=True,
        capture_output=True, check=False,
    ), "malformed"))

    for result, message in cases:
        assert result.returncode != 0, result.stdout
        assert message in result.stderr.lower(), result.stderr


def test_preparer_rejects_checkout_symlink_existing_or_current_application_state(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / ".git").mkdir()
    (checkout / ARCHIVE_NAME).write_bytes(b"checkout archive")
    result, *_ = _run(tmp_path / "checkout-case", arg_mutations={"--archive": str(checkout / ARCHIVE_NAME)})
    assert result.returncode != 0

    symlink_root = tmp_path / "symlink-case"
    delivery, env, checksums, installer, archive = _fixture(symlink_root)
    alias_parent = symlink_root / "alias-downloads"
    alias_parent.mkdir()
    alias = alias_parent / ARCHIVE_NAME
    alias.symlink_to(archive)
    args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
        "--checksums", str(checksums), "--checksums-url", CHECKSUMS_URL,
        "--installer", str(installer), "--installer-url", INSTALLER_URL,
        "--archive", str(alias), "--archive-url", ARCHIVE_URL,
        "--install-dir", str(symlink_root / "legacy-home/.yulu"),
        "--evidence-dir", str(symlink_root / "evidence"), "--run-id", "v022-policy",
    ]
    (symlink_root / "legacy-home").mkdir(exist_ok=True)
    rejected = subprocess.run(args, cwd=symlink_root, env=env, text=True, capture_output=True, check=False)
    assert rejected.returncode != 0
    assert "regular non-symlink" in rejected.stderr.lower()

    existing_root = tmp_path / "existing"
    delivery, env, checksums, installer, archive = _fixture(existing_root)
    applications = Path(env["YULU_V022_BASELINE_TEST_APPLICATIONS"])
    (applications / "Yulu.app").mkdir()
    existing_args = [
        "/bin/bash", str(delivery / "launch_public_dmg_acceptance.sh"),
        "--prepare-v0.22.2-baseline", "--policy-test",
        "--checksums", str(checksums), "--checksums-url", CHECKSUMS_URL,
        "--installer", str(installer), "--installer-url", INSTALLER_URL,
        "--archive", str(archive), "--archive-url", ARCHIVE_URL,
        "--install-dir", str(existing_root / "legacy-home/.yulu"),
        "--evidence-dir", str(existing_root / "evidence"), "--run-id", "v022-policy",
    ]
    (existing_root / "legacy-home").mkdir(exist_ok=True)
    rejected = subprocess.run(existing_args, cwd=existing_root, env=env, text=True, capture_output=True, check=False)
    assert rejected.returncode != 0
    assert "current application" in rejected.stderr.lower()

    preexisting = tmp_path / "preexisting-legacy" / ".yulu"
    preexisting.mkdir(parents=True)
    rejected, *_ = _run(
        tmp_path / "preexisting-case",
        arg_mutations={"--install-dir": str(preexisting)},
    )
    assert rejected.returncode != 0
    assert "already exists" in rejected.stderr.lower()

    standard_root = tmp_path / "standard-case"
    (standard_root / "target-home/Library/Application Support/Yulu").mkdir(parents=True)
    rejected, *_ = _run(standard_root)
    assert rejected.returncode != 0
    assert "standard data root" in rejected.stderr.lower()


def test_preparer_source_has_no_downloader_checkout_helper_or_current_runtime_mutation() -> None:
    source = (Path(__file__).resolve().parents[1] / "packaging/acceptance/prepare_v0_22_2_baseline.sh").read_text()
    for forbidden in (
        "curl", "wget", "raw.githubusercontent.com", "release_installer.py", "SMAppService",
        "osascript", "ditto", "git clone", "git checkout", "application_migration.py",
    ):
        assert forbidden not in source
    assert 'INSTALL_DIR="$INSTALL_DIR" /bin/bash "$INSTALLER" --version "$TAG"' in source
    for fixed in (
        COMMIT,
        "95f3a7638208cbf54e2688dbd0c872f37a936a295efb650820f254095f25d35e",
        "53a278b8bae77bcc5f5ddfa7c38f497cfb3451a79ae2edf8d5096e242d89d843",
        "f09722cbb312a9fecfe1688526b1b67f7424832694520a9138b1c9c1417ba558",
    ):
        assert fixed in source
