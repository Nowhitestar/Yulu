from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ACCEPTANCE = ROOT / "packaging" / "acceptance"
BUILDER = ACCEPTANCE / "build_public_dmg_harness.sh"
REVISION = "a" * 40
DELIVERED = {
    "build-mode.txt": 0o644,
    "launch_public_dmg_acceptance.sh": 0o755,
    "manifest.sha256": 0o644,
    "observe_journey.mjs": 0o644,
    "observe_post_commit.mjs": 0o644,
    "observe_product.mjs": 0o644,
    "observe_upgrade.mjs": 0o644,
    "observe_v0_22_2_state.sh": 0o755,
    "prepare_v0_22_2_baseline.sh": 0o755,
    "public_dmg_target.sh": 0o755,
    "public_dmg_upgrade_target.sh": 0o755,
    "source-revision.txt": 0o644,
    "yulu-durable-sync": 0o755,
}


def _build(output: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "/bin/bash",
            str(BUILDER),
            "--policy-test",
            "--source-revision",
            REVISION,
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def _verify_only(bundle: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/bash", str(bundle / "launch_public_dmg_acceptance.sh"), "--verify-only"],
        cwd=bundle.parent,
        text=True,
        capture_output=True,
        check=False,
    )


def test_controller_build_is_deterministic_and_policy_never_formal(tmp_path: Path) -> None:
    first = _build(tmp_path / "first")
    second = _build(tmp_path / "second")
    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    first_result = json.loads(first.stdout)
    second_result = json.loads(second.stdout)
    assert first_result["formalAcceptance"] is False
    assert first_result["classification"] == "harness_policy_test"
    assert first_result["buildMode"] == "policy-test"
    assert first_result["sourceRevision"] == REVISION
    assert first_result["bundleDigest"] == second_result["bundleDigest"]
    assert {path.name for path in (tmp_path / "first").iterdir()} == set(DELIVERED)
    assert (tmp_path / "first" / "manifest.sha256").read_bytes() == (
        tmp_path / "second" / "manifest.sha256"
    ).read_bytes()
    for name, mode in DELIVERED.items():
        path = tmp_path / "first" / name
        assert not path.is_symlink()
        assert path.stat().st_mode & 0o777 == mode
    manifest_names = [line.split("  ", 1)[1] for line in (
        tmp_path / "first" / "manifest.sha256"
    ).read_text().splitlines()]
    assert manifest_names == sorted(name for name in DELIVERED if name != "manifest.sha256")
    assert _verify_only(tmp_path / "first").returncode == 0
    forbidden_formal = subprocess.run(
        ["/bin/bash", str(tmp_path / "first" / "launch_public_dmg_acceptance.sh")],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    assert forbidden_formal.returncode != 0
    assert "formal" in forbidden_formal.stderr.lower()

    sync_log = tmp_path / "durable-sync.log"
    synced_file = tmp_path / "durable-file"
    synced_file.write_text("durable fixture\n")
    for synced_path in (synced_file, tmp_path):
        synced = subprocess.run(
            [str(tmp_path / "first" / "yulu-durable-sync"), str(synced_path)],
            env={"YULU_DURABLE_SYNC_POLICY_LOG": str(sync_log)},
            text=True,
            capture_output=True,
            check=False,
        )
        assert synced.returncode == 0, synced.stderr
    assert sync_log.read_text().splitlines() == [str(synced_file), str(tmp_path)]
    unsafe_link = tmp_path / "durable-link"
    unsafe_link.symlink_to(synced_file)
    rejected = subprocess.run(
        [str(tmp_path / "first" / "yulu-durable-sync"), str(unsafe_link)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected.returncode != 0


def test_launcher_fails_closed_for_tamper_extra_missing_and_symlink_manifest(tmp_path: Path) -> None:
    cases = {}
    for name in ("tamper", "extra", "missing", "symlink"):
        output = tmp_path / name
        assert _build(output).returncode == 0
        cases[name] = output
    cases["tamper"].joinpath("public_dmg_target.sh").write_text("tampered")
    cases["extra"].joinpath("unexpected.txt").write_text("unexpected")
    cases["missing"].joinpath("observe_product.mjs").unlink()
    original_manifest = cases["symlink"] / "manifest.original"
    cases["symlink"].joinpath("manifest.sha256").rename(original_manifest)
    cases["symlink"].joinpath("manifest.sha256").symlink_to(original_manifest)
    for name, bundle in cases.items():
        result = _verify_only(bundle)
        assert result.returncode != 0, name
        assert any(word in result.stderr.lower() for word in ("manifest", "file set", "checksum", "symlink"))


def test_formal_builder_rejects_dirty_source_and_delivery_inside_checkout(tmp_path: Path) -> None:
    dirty_repo = tmp_path / "dirty-repo"
    copied_acceptance = dirty_repo / "packaging" / "acceptance"
    copied_acceptance.parent.mkdir(parents=True)
    shutil.copytree(ACCEPTANCE, copied_acceptance)
    subprocess.run(["/usr/bin/git", "init", "-q", str(dirty_repo)], check=True)
    subprocess.run(["/usr/bin/git", "-C", str(dirty_repo), "add", "packaging/acceptance"], check=True)
    subprocess.run(
        [
            "/usr/bin/git", "-C", str(dirty_repo),
            "-c", "user.name=Yulu Acceptance Test",
            "-c", "user.email=acceptance@example.invalid",
            "commit", "-q", "-m", "fixture",
        ],
        check=True,
    )
    (dirty_repo / "uncommitted.txt").write_text("dirty")
    dirty = subprocess.run(
        ["/bin/bash", str(copied_acceptance / "build_public_dmg_harness.sh"), "--output", str(tmp_path / "formal")],
        cwd=dirty_repo,
        text=True,
        capture_output=True,
        check=False,
    )
    assert dirty.returncode != 0
    assert "dirty" in dirty.stderr.lower()

    unresolved_root = tmp_path / "unresolved"
    unresolved_acceptance = unresolved_root / "packaging" / "acceptance"
    unresolved_acceptance.parent.mkdir(parents=True)
    shutil.copytree(ACCEPTANCE, unresolved_acceptance)
    unresolved = subprocess.run(
        ["/bin/bash", str(unresolved_acceptance / "build_public_dmg_harness.sh"), "--output", str(tmp_path / "unresolved-output")],
        cwd=unresolved_root,
        text=True,
        capture_output=True,
        check=False,
    )
    assert unresolved.returncode != 0
    assert "unresolvable" in unresolved.stderr.lower()

    outside = tmp_path / "outside"
    assert _build(outside).returncode == 0
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / ".git").mkdir()
    inside_build = _build(checkout / "generated")
    assert inside_build.returncode != 0
    assert "checkout" in inside_build.stderr.lower()
    copied = checkout / "delivery"
    shutil.copytree(outside, copied)
    result = _verify_only(copied)
    assert result.returncode != 0
    assert "checkout" in result.stderr.lower()


def test_release_assets_and_application_inventory_do_not_reference_harness() -> None:
    protected = (
        ROOT / "packaging" / "scripts" / "package.sh",
        ROOT / "packaging" / "scripts" / "checksums.sh",
        ROOT / "packaging" / "scripts" / "verify_application_runtime.sh",
        ROOT / ".github" / "workflows" / "release-publish.yml",
    )
    forbidden = (
        "build_public_dmg_harness",
        "launch_public_dmg_acceptance",
        "public_dmg_target",
        "observe_journey.mjs",
        "observe_post_commit.mjs",
        "observe_product.mjs",
        "observe_upgrade.mjs",
        "observe_v0_22_2_state",
        "prepare_v0_22_2_baseline",
        "public_dmg_upgrade_target",
        "yulu-durable-sync",
    )
    for path in protected:
        source = path.read_text()
        assert all(token not in source for token in forbidden), path


def test_controller_target_and_observers_never_download_install_or_share() -> None:
    combined = "\n".join(path.read_text() for path in (
        BUILDER,
        ACCEPTANCE / "launch_public_dmg_acceptance.sh",
        ACCEPTANCE / "public_dmg_target.sh",
        ACCEPTANCE / "observe_journey.mjs",
        ACCEPTANCE / "observe_post_commit.mjs",
        ACCEPTANCE / "observe_product.mjs",
        ACCEPTANCE / "observe_upgrade.mjs",
        ACCEPTANCE / "observe_v0_22_2_state.sh",
        ACCEPTANCE / "public_dmg_upgrade_target.sh",
    ))
    for forbidden in ("curl", "wget", "xattr -w", "ditto", "osascript", "sharing.testShare", "shareRecording"):
        assert forbidden not in combined
