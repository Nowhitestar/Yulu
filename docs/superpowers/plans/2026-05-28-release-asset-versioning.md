# Release Asset Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a release-asset based Yulu installer/update system where stable users install GitHub Release assets by default, can select a version, can roll back with `yulu update --version`, and developers explicitly opt into `--dev`.

**Architecture:** Keep shell as a thin bootstrap and move release resolution, download, checksum, staging, backup, replace, setup, metadata, and rollback into one shared Python helper at `yulu/scripts/release_installer.py`. Package releases as immutable `yulu-macos-arm64-vX.Y.Z.zip` assets plus `checksums.txt`, and have both `install.sh` and `yulu update` call the same helper contract.

**Tech Stack:** Bash entrypoints, Python 3 stdlib (`argparse`, `dataclasses`, `hashlib`, `json`, `pathlib`, `shutil`, `subprocess`, `tempfile`, `urllib.request`, `zipfile`), GitHub REST release endpoints, GitHub Actions, pytest.

---

## File Structure

- Create `yulu/scripts/release_installer.py`: shared install/update engine. One file is intentional for bootstrap simplicity; keep it organized into pure helper functions plus small orchestration functions.
- Create `tests/test_release_installer.py`: unit tests for target parsing, GitHub JSON parsing, asset selection, checksum parsing, layout validation, metadata, and rollback.
- Create `tests/test_release_installer_integration.py`: local fake-release smoke tests using `file://` URLs and temporary install dirs. Mark slow cases only if they become heavy.
- Modify `install.sh`: parse `--latest`, `--version`, `--dev`, download `release_installer.py` from `main` into a temp dir, and invoke it. Keep macOS/Xcode/git checks that are still relevant.
- Modify `yulu/scripts/yulu`: update help text and make `cmd_update` delegate to `release_installer.py`; preserve `setup`, `version`, `status`, and other commands.
- Modify `yulu/scripts/version.py`: read `.yulu-install.json` when present and include install source metadata in JSON and human output.
- Create `packaging/scripts/package.sh`: build a release zip from an explicit staged runtime tree.
- Create `packaging/scripts/checksums.sh`: generate `dist/checksums.txt`.
- Modify `Makefile`: add `package`, `checksums`, and release-installer focused test targets.
- Create `.github/workflows/release.yml`: tag workflow that tests, checks version/tag sync, packages, checksums, and uploads assets.
- Modify `.github/workflows/ci.yml`: add syntax checks for new scripts and release-installer tests.
- Modify `README.md`, `README.zh-CN.md`, `docs/RELEASE.md`, `CHANGELOG.md`: document the new stable/default release path, version selection, dev channel, and release process.

## Task 1: Release Target Parsing and GitHub Asset Selection

**Files:**
- Create: `yulu/scripts/release_installer.py`
- Create: `tests/test_release_installer.py`

- [ ] **Step 1: Write failing tests for target parsing**

Add tests:

```python
import pytest

from release_installer import ReleaseTarget, normalize_version_tag, parse_target_args


def test_parse_default_target_is_latest_release():
    target = parse_target_args([])
    assert target == ReleaseTarget(kind="latest", tag=None)


def test_parse_explicit_latest_target():
    target = parse_target_args(["--latest"])
    assert target == ReleaseTarget(kind="latest", tag=None)


def test_parse_version_target_normalizes_leading_v():
    target = parse_target_args(["--version", "0.5.0"])
    assert target == ReleaseTarget(kind="version", tag="v0.5.0")


def test_parse_dev_target():
    target = parse_target_args(["--dev"])
    assert target == ReleaseTarget(kind="dev", tag=None)


def test_parse_rejects_version_and_dev_together():
    with pytest.raises(SystemExit):
        parse_target_args(["--version", "v0.5.0", "--dev"])


def test_normalize_version_tag_rejects_invalid_semver():
    with pytest.raises(ValueError, match="valid SemVer"):
        normalize_version_tag("banana")
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
```

Expected: import failure because `release_installer.py` does not exist.

- [ ] **Step 3: Implement target parsing**

Create `yulu/scripts/release_installer.py` with:

```python
#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from dataclasses import dataclass

SEMVER_RE = re.compile(r"^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


class InstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class ReleaseTarget:
    kind: str  # "latest" | "version" | "dev"
    tag: str | None = None


def normalize_version_tag(value: str) -> str:
    version = value.strip()
    if not SEMVER_RE.match(version):
        raise ValueError(f"{value!r} is not a valid SemVer release tag")
    return version if version.startswith("v") else f"v{version}"


def build_target_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--latest", action="store_true")
    group.add_argument("--version")
    group.add_argument("--dev", action="store_true")
    return parser


def parse_target_args(argv: list[str]) -> ReleaseTarget:
    args = build_target_parser().parse_args(argv)
    if args.dev:
        return ReleaseTarget(kind="dev")
    if args.version:
        return ReleaseTarget(kind="version", tag=normalize_version_tag(args.version))
    return ReleaseTarget(kind="latest")
```

- [ ] **Step 4: Run target parsing tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
```

Expected: all current tests pass.

- [ ] **Step 5: Commit task 1**

```bash
git add yulu/scripts/release_installer.py tests/test_release_installer.py
git commit -m "feat(installer): parse release install targets"
```

## Task 2: GitHub Release JSON Parsing and Checksum Helpers

**Files:**
- Modify: `yulu/scripts/release_installer.py`
- Modify: `tests/test_release_installer.py`

- [ ] **Step 1: Write failing tests for release asset selection and checksums**

Append:

```python
from pathlib import Path

import pytest

from release_installer import (
    ReleaseAsset,
    parse_checksums,
    select_release_asset,
    sha256_file,
    verify_checksum,
)


def test_select_release_asset_finds_zip_and_checksums():
    release = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
            {
                "name": "yulu-macos-arm64-v0.5.0.zip",
                "browser_download_url": "https://example/yulu.zip",
            },
        ],
    }

    selected = select_release_asset(release)

    assert selected == ReleaseAsset(
        tag="v0.5.0",
        asset_name="yulu-macos-arm64-v0.5.0.zip",
        asset_url="https://example/yulu.zip",
        checksums_url="https://example/checksums.txt",
    )


def test_select_release_asset_errors_when_zip_missing():
    with pytest.raises(Exception, match="does not provide"):
        select_release_asset({"tag_name": "v0.5.0", "assets": []})


def test_parse_checksums_accepts_sha256_lines():
    checksums = parse_checksums("abc  yulu.zip\n123  install.sh\n")
    assert checksums["yulu.zip"] == "abc"
    assert checksums["install.sh"] == "123"


def test_verify_checksum_passes_and_fails(tmp_path):
    artifact = tmp_path / "artifact.zip"
    artifact.write_bytes(b"hello")
    expected = sha256_file(artifact)

    verify_checksum(artifact, expected)

    with pytest.raises(Exception, match="Checksum mismatch"):
        verify_checksum(artifact, "0" * 64)
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
```

Expected: import failures for new helper names.

- [ ] **Step 3: Implement release asset and checksum helpers**

Add:

```python
import hashlib
from pathlib import Path


@dataclass(frozen=True)
class ReleaseAsset:
    tag: str
    asset_name: str
    asset_url: str
    checksums_url: str


def select_release_asset(release: dict) -> ReleaseAsset:
    tag = str(release.get("tag_name") or "")
    if not tag:
        raise InstallError("GitHub release response did not include tag_name")
    expected_zip = f"yulu-macos-arm64-{tag}.zip"
    assets = release.get("assets") or []
    by_name = {str(asset.get("name")): asset for asset in assets}
    zip_asset = by_name.get(expected_zip)
    checksum_asset = by_name.get("checksums.txt")
    if zip_asset is None:
        raise InstallError(f"Release {tag} does not provide {expected_zip}. It may predate asset-based installs.")
    if checksum_asset is None:
        raise InstallError(f"Release {tag} does not provide checksums.txt.")
    return ReleaseAsset(
        tag=tag,
        asset_name=expected_zip,
        asset_url=str(zip_asset.get("browser_download_url") or ""),
        checksums_url=str(checksum_asset.get("browser_download_url") or ""),
    )


def parse_checksums(text: str) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        checksum, name = parts[0], parts[-1].lstrip("*")
        checksums[name] = checksum
    return checksums


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checksum(path: Path, expected: str) -> None:
    actual = sha256_file(path)
    if actual.lower() != expected.lower():
        raise InstallError(f"Checksum mismatch for {path.name}: expected {expected}, got {actual}")
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
```

Expected: pass.

- [ ] **Step 5: Commit task 2**

```bash
git add yulu/scripts/release_installer.py tests/test_release_installer.py
git commit -m "feat(installer): select release assets and verify checksums"
```

## Task 3: Runtime Layout Validation and Install Metadata

**Files:**
- Modify: `yulu/scripts/release_installer.py`
- Modify: `yulu/scripts/version.py`
- Modify: `tests/test_release_installer.py`
- Modify: `tests/test_version.py`

- [ ] **Step 1: Write failing tests for staged layout validation and metadata**

Append to `tests/test_release_installer.py`:

```python
import json

from release_installer import (
    InstallMetadata,
    read_install_metadata,
    validate_runtime_layout,
    write_install_metadata,
)


def make_runtime(root: Path, version: str = "0.5.0") -> Path:
    runtime = root / "yulu"
    (runtime / "yulu" / "scripts").mkdir(parents=True)
    (runtime / "VERSION").write_text(version + "\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "setup.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "yulu").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (runtime / "yulu" / "scripts" / "version.py").write_text(
        "import sys\nsys.exit(0)\n",
        encoding="utf-8",
    )
    return runtime


def test_validate_runtime_layout_accepts_matching_version(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.0")
    validate_runtime_layout(runtime, "v0.5.0")


def test_validate_runtime_layout_rejects_version_drift(tmp_path):
    runtime = make_runtime(tmp_path, "0.5.1")
    with pytest.raises(Exception, match="VERSION"):
        validate_runtime_layout(runtime, "v0.5.0")


def test_install_metadata_roundtrip(tmp_path):
    metadata = InstallMetadata(
        source="release",
        version="v0.5.0",
        asset="yulu-macos-arm64-v0.5.0.zip",
        sha256="abc",
    )
    write_install_metadata(tmp_path, metadata)

    data = read_install_metadata(tmp_path)

    assert data["schema"] == 1
    assert data["source"] == "release"
    assert data["version"] == "v0.5.0"
    assert data["asset"] == "yulu-macos-arm64-v0.5.0.zip"
    assert data["sha256"] == "abc"
    assert "installed_at" in data
```

- [ ] **Step 2: Write failing version metadata tests**

Append to `tests/test_version.py`:

```python
def test_version_info_reads_install_metadata(tmp_path):
    version_file = tmp_path / "VERSION"
    version_file.write_text("0.5.0\n", encoding="utf-8")
    (tmp_path / ".yulu-install.json").write_text(
        '{"schema":1,"source":"release","version":"v0.5.0","asset":"yulu.zip","sha256":"abc","installed_at":"now"}\n',
        encoding="utf-8",
    )

    info = version_info(repo_dir=tmp_path, version_path=version_file)

    assert info["install"]["source"] == "release"
    assert info["install"]["version"] == "v0.5.0"
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py tests/test_version.py -q
```

Expected: missing validation/metadata helpers and missing `install` key.

- [ ] **Step 4: Implement runtime layout and metadata helpers**

Add to `release_installer.py`:

```python
import json
import subprocess
from datetime import datetime, timezone


@dataclass(frozen=True)
class InstallMetadata:
    source: str
    version: str | None = None
    asset: str | None = None
    sha256: str | None = None
    branch: str | None = None
    commit: str | None = None


def _tag_without_v(tag: str) -> str:
    return tag[1:] if tag.startswith("v") else tag


def validate_runtime_layout(runtime_dir: Path, tag: str) -> None:
    required = [
        runtime_dir / "VERSION",
        runtime_dir / "yulu" / "scripts" / "setup.sh",
        runtime_dir / "yulu" / "scripts" / "yulu",
        runtime_dir / "yulu" / "scripts" / "version.py",
    ]
    for path in required:
        if not path.exists():
            raise InstallError(f"Invalid release asset: missing {path.relative_to(runtime_dir)}")
    version = (runtime_dir / "VERSION").read_text(encoding="utf-8").strip()
    if version != _tag_without_v(tag):
        raise InstallError(f"VERSION {version!r} does not match release tag {tag!r}")
    result = subprocess.run(
        ["python3", str(runtime_dir / "yulu" / "scripts" / "version.py"), "--check"],
        cwd=str(runtime_dir),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise InstallError(f"version.py --check failed: {result.stderr or result.stdout}")


def install_metadata_path(runtime_dir: Path) -> Path:
    return runtime_dir / ".yulu-install.json"


def write_install_metadata(runtime_dir: Path, metadata: InstallMetadata) -> None:
    payload = {
        "schema": 1,
        "source": metadata.source,
        "installed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    for key in ("version", "asset", "sha256", "branch", "commit"):
        value = getattr(metadata, key)
        if value is not None:
            payload[key] = value
    install_metadata_path(runtime_dir).write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_install_metadata(runtime_dir: Path) -> dict:
    path = install_metadata_path(runtime_dir)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
```

- [ ] **Step 5: Extend `version.py`**

Modify `version_info` to read metadata:

```python
def read_install_metadata(repo_dir: Path = REPO_DIR) -> dict[str, object]:
    path = repo_dir / ".yulu-install.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
```

Add `"install": read_install_metadata(repo_dir)` to the returned dict.

Modify `format_version`:

```python
install = info.get("install")
if isinstance(install, dict):
    source = install.get("source")
    if source == "release" and install.get("version"):
        git_bits.append(f"release {install['version']}")
    elif source == "dev" and install.get("branch"):
        git_bits.append(f"dev {install['branch']}")
```

Keep existing commit/dirty/tag behavior; install source is additive.

- [ ] **Step 6: Run tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py tests/test_version.py -q
```

Expected: pass.

- [ ] **Step 7: Commit task 3**

```bash
git add yulu/scripts/release_installer.py yulu/scripts/version.py tests/test_release_installer.py tests/test_version.py
git commit -m "feat(installer): record install source metadata"
```

## Task 4: Release Download, Extraction, Atomic Replace, and Rollback

**Files:**
- Modify: `yulu/scripts/release_installer.py`
- Modify: `tests/test_release_installer.py`
- Create: `tests/test_release_installer_integration.py`

- [ ] **Step 1: Write unit tests for backup/rollback primitives**

Append:

```python
from release_installer import replace_runtime_with_backup, restore_backup


def test_replace_runtime_with_backup_moves_existing_runtime(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "old.txt").write_text("old", encoding="utf-8")
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "new.txt").write_text("new", encoding="utf-8")

    backup = replace_runtime_with_backup(staged, install_dir)

    assert (install_dir / "new.txt").read_text(encoding="utf-8") == "new"
    assert backup is not None
    assert (backup / "old.txt").read_text(encoding="utf-8") == "old"


def test_restore_backup_replaces_failed_runtime(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / "bad.txt").write_text("bad", encoding="utf-8")
    backup = tmp_path / "backup"
    backup.mkdir()
    (backup / "old.txt").write_text("old", encoding="utf-8")

    restore_backup(backup, install_dir)

    assert (install_dir / "old.txt").read_text(encoding="utf-8") == "old"
    assert not (install_dir / "bad.txt").exists()
```

- [ ] **Step 2: Write integration test for local fake release install**

Create `tests/test_release_installer_integration.py`:

```python
import hashlib
import json
import zipfile
from pathlib import Path

from release_installer import install_release_from_urls


def build_fake_asset(tmp_path: Path, tag: str = "v0.5.0") -> tuple[Path, Path]:
    root = tmp_path / "asset-root" / "yulu"
    (root / "yulu" / "scripts").mkdir(parents=True)
    (root / "VERSION").write_text(tag.removeprefix("v") + "\n", encoding="utf-8")
    (root / "yulu" / "scripts" / "setup.sh").write_text("#!/usr/bin/env bash\necho setup \"$@\"\n", encoding="utf-8")
    (root / "yulu" / "scripts" / "yulu").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    (root / "yulu" / "scripts" / "version.py").write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
    zip_path = tmp_path / f"yulu-macos-arm64-{tag}.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        for path in root.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(root.parent))
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    checksums = tmp_path / "checksums.txt"
    checksums.write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8")
    return zip_path, checksums


def test_install_release_from_file_urls(tmp_path):
    zip_path, checksums = build_fake_asset(tmp_path)
    install_dir = tmp_path / "install"

    install_release_from_urls(
        tag="v0.5.0",
        asset_name=zip_path.name,
        asset_url=zip_path.as_uri(),
        checksums_url=checksums.as_uri(),
        install_dir=install_dir,
        run_setup=False,
    )

    assert (install_dir / "VERSION").read_text(encoding="utf-8").strip() == "0.5.0"
    metadata = json.loads((install_dir / ".yulu-install.json").read_text(encoding="utf-8"))
    assert metadata["source"] == "release"
    assert metadata["version"] == "v0.5.0"
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py tests/test_release_installer_integration.py -q
```

Expected: missing replace/install functions.

- [ ] **Step 4: Implement download, extraction, replace, rollback**

Add:

```python
import os
import shutil
import tempfile
import urllib.request
import zipfile


def download_to_path(url: str, dest: Path) -> None:
    if url.startswith("file://"):
        src = Path(urllib.request.url2pathname(url.removeprefix("file://")))
        shutil.copy2(src, dest)
        return
    with urllib.request.urlopen(url, timeout=30) as response, dest.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def read_url_text(url: str) -> str:
    if url.startswith("file://"):
        src = Path(urllib.request.url2pathname(url.removeprefix("file://")))
        return src.read_text(encoding="utf-8")
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8")


def extract_release_zip(zip_path: Path, dest: Path) -> Path:
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(dest)
    runtime = dest / "yulu"
    if not runtime.exists():
        raise InstallError("Release zip must expand to a top-level yulu/ directory")
    return runtime


def replace_runtime_with_backup(staged_runtime: Path, install_dir: Path) -> Path | None:
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if install_dir.exists():
        backup = install_dir.with_name(f"{install_dir.name}.backup-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}")
        shutil.move(str(install_dir), str(backup))
    shutil.move(str(staged_runtime), str(install_dir))
    return backup


def restore_backup(backup: Path, install_dir: Path) -> None:
    if install_dir.exists():
        shutil.rmtree(install_dir)
    shutil.move(str(backup), str(install_dir))


def run_setup(install_dir: Path, upgrade: bool) -> None:
    setup = install_dir / "yulu" / "scripts" / "setup.sh"
    cmd = ["bash", str(setup)]
    if upgrade:
        cmd.append("--upgrade")
    result = subprocess.run(cmd, cwd=str(install_dir))
    if result.returncode != 0:
        raise InstallError(f"setup.sh failed with exit code {result.returncode}")


def install_release_from_urls(
    *,
    tag: str,
    asset_name: str,
    asset_url: str,
    checksums_url: str,
    install_dir: Path,
    run_setup: bool = True,
) -> None:
    existed = install_dir.exists()
    with tempfile.TemporaryDirectory(prefix="yulu-install-") as tmp:
        tmpdir = Path(tmp)
        zip_path = tmpdir / asset_name
        download_to_path(asset_url, zip_path)
        checksums = parse_checksums(read_url_text(checksums_url))
        expected = checksums.get(asset_name)
        if expected is None:
            raise InstallError(f"checksums.txt does not include {asset_name}")
        verify_checksum(zip_path, expected)
        staged_parent = tmpdir / "staged"
        staged_parent.mkdir()
        staged_runtime = extract_release_zip(zip_path, staged_parent)
        validate_runtime_layout(staged_runtime, tag)
        backup = replace_runtime_with_backup(staged_runtime, install_dir)
        try:
            write_install_metadata(
                install_dir,
                InstallMetadata(source="release", version=tag, asset=asset_name, sha256=expected),
            )
            if run_setup:
                run_setup(install_dir, upgrade=existed)
        except Exception:
            if backup is not None:
                restore_backup(backup, install_dir)
            raise
```

- [ ] **Step 5: Run release installer tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py tests/test_release_installer_integration.py -q
```

Expected: pass.

- [ ] **Step 6: Commit task 4**

```bash
git add yulu/scripts/release_installer.py tests/test_release_installer.py tests/test_release_installer_integration.py
git commit -m "feat(installer): install release assets atomically"
```

## Task 5: Dev Channel Support

**Files:**
- Modify: `yulu/scripts/release_installer.py`
- Modify: `tests/test_release_installer.py`

- [ ] **Step 1: Write tests for dev metadata and release-runtime refusal**

Append:

```python
from release_installer import build_dev_metadata, ensure_dev_switch_allowed


def test_build_dev_metadata():
    metadata = build_dev_metadata(branch="main", commit="abc1234")
    assert metadata.source == "dev"
    assert metadata.branch == "main"
    assert metadata.commit == "abc1234"


def test_release_runtime_cannot_switch_to_dev_in_place(tmp_path):
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text('{"source":"release"}\n', encoding="utf-8")

    with pytest.raises(Exception, match="Cannot switch release runtime to dev in-place"):
        ensure_dev_switch_allowed(install_dir)
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
```

Expected: missing `build_dev_metadata` and `ensure_dev_switch_allowed`.

- [ ] **Step 3: Implement dev channel**

Add:

```python
REPO_URL = "https://github.com/Nowhitestar/Yulu.git"


def run(cmd: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True)
    if result.returncode != 0:
        raise InstallError(result.stderr.strip() or result.stdout.strip() or f"{cmd[0]} failed")
    return result.stdout.strip()


def build_dev_metadata(branch: str, commit: str) -> InstallMetadata:
    return InstallMetadata(source="dev", branch=branch, commit=commit)


def ensure_dev_switch_allowed(install_dir: Path) -> None:
    if not install_dir.exists():
        return
    if (install_dir / ".git").exists():
        return
    raise InstallError(f"Cannot switch release runtime to dev in-place. Move {install_dir} aside or reinstall with --dev.")


def install_dev_channel(install_dir: Path, run_setup_flag: bool = True) -> None:
    ensure_dev_switch_allowed(install_dir)
    if install_dir.exists():
        run(["git", "fetch", "--quiet", "origin"], cwd=install_dir)
        status = run(["git", "status", "--porcelain"], cwd=install_dir)
        if status:
            raise InstallError(f"Dev checkout has local changes in {install_dir}; commit or stash them before updating.")
        run(["git", "checkout", "--quiet", "main"], cwd=install_dir)
        run(["git", "pull", "--ff-only", "origin", "main"], cwd=install_dir)
    else:
        install_dir.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--branch", "main", REPO_URL, str(install_dir)])
    commit = run(["git", "rev-parse", "--short", "HEAD"], cwd=install_dir)
    write_install_metadata(install_dir, build_dev_metadata(branch="main", commit=commit))
    if run_setup_flag:
        run_setup(install_dir, upgrade=True)
```

- [ ] **Step 4: Run tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
python3 -m py_compile yulu/scripts/release_installer.py
```

Expected: pass.

- [ ] **Step 5: Commit task 5**

```bash
git add yulu/scripts/release_installer.py tests/test_release_installer.py
git commit -m "feat(installer): add explicit dev channel"
```

## Task 6: Production GitHub Resolution and CLI Main

**Files:**
- Modify: `yulu/scripts/release_installer.py`
- Modify: `tests/test_release_installer.py`

- [ ] **Step 1: Write failing tests for GitHub URL resolution**

Append:

```python
from release_installer import github_release_api_url, resolve_release_from_payload


def test_github_latest_release_url():
    assert github_release_api_url(ReleaseTarget(kind="latest")).endswith("/releases/latest")


def test_github_version_release_url():
    assert github_release_api_url(ReleaseTarget(kind="version", tag="v0.5.0")).endswith("/releases/tags/v0.5.0")


def test_resolve_release_from_payload_returns_selected_asset():
    payload = {
        "tag_name": "v0.5.0",
        "assets": [
            {"name": "checksums.txt", "browser_download_url": "https://example/checksums.txt"},
            {"name": "yulu-macos-arm64-v0.5.0.zip", "browser_download_url": "https://example/yulu.zip"},
        ],
    }
    asset = resolve_release_from_payload(payload)
    assert asset.tag == "v0.5.0"
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py -q
```

Expected: missing URL helpers.

- [ ] **Step 3: Implement GitHub resolution and `main`**

Add:

```python
REPO = "Nowhitestar/Yulu"
GITHUB_API = "https://api.github.com"


def github_release_api_url(target: ReleaseTarget) -> str:
    if target.kind == "latest":
        return f"{GITHUB_API}/repos/{REPO}/releases/latest"
    if target.kind == "version" and target.tag:
        return f"{GITHUB_API}/repos/{REPO}/releases/tags/{target.tag}"
    raise InstallError(f"GitHub release URL is not valid for target {target}")


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "YuluInstaller"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_release_from_payload(payload: dict) -> ReleaseAsset:
    return select_release_asset(payload)


def install_release_target(target: ReleaseTarget, install_dir: Path, run_setup_flag: bool = True) -> None:
    payload = fetch_json(github_release_api_url(target))
    asset = resolve_release_from_payload(payload)
    install_release_from_urls(
        tag=asset.tag,
        asset_name=asset.asset_name,
        asset_url=asset.asset_url,
        checksums_url=asset.checksums_url,
        install_dir=install_dir,
        run_setup=run_setup_flag,
    )


def build_main_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install or update Yulu from release assets")
    parser.add_argument("command", choices=["install", "update"])
    parser.add_argument("--install-dir", default=os.path.expanduser("~/.yulu"))
    parser.add_argument("--no-setup", action="store_true", help=argparse.SUPPRESS)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--latest", action="store_true")
    group.add_argument("--version")
    group.add_argument("--dev", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_main_parser()
    args = parser.parse_args(argv)
    target_argv: list[str] = []
    if args.latest:
        target_argv.append("--latest")
    if args.version:
        target_argv.extend(["--version", args.version])
    if args.dev:
        target_argv.append("--dev")
    target = parse_target_args(target_argv)
    try:
        if target.kind == "dev":
            install_dev_channel(Path(args.install_dir), run_setup_flag=not args.no_setup)
        else:
            install_release_target(target, Path(args.install_dir), run_setup_flag=not args.no_setup)
    except InstallError as exc:
        print(f"Yulu install failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Also import `sys`.

- [ ] **Step 4: Run tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer.py tests/test_release_installer_integration.py -q
python3 yulu/scripts/release_installer.py install --version v0.0.0 --install-dir /tmp/yulu-missing --no-setup
```

Expected: tests pass; command exits non-zero with "Release v0.0.0 was not found" or GitHub 404 wrapped as a clear install failure. If the 404 text is ugly, add an `urllib.error.HTTPError` handler that maps 404 to "Release v0.0.0 was not found."

- [ ] **Step 5: Commit task 6**

```bash
git add yulu/scripts/release_installer.py tests/test_release_installer.py
git commit -m "feat(installer): resolve GitHub release targets"
```

## Task 7: Shell Bootstrap Installer

**Files:**
- Modify: `install.sh`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update `install.sh` argument parsing**

Replace the hard-coded `BRANCH="main"` clone/update block with a bootstrap flow:

```bash
TARGET_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --latest)
            TARGET_ARGS+=(--latest)
            shift
            ;;
        --version)
            TARGET_ARGS+=(--version "$2")
            shift 2
            ;;
        --dev)
            TARGET_ARGS+=(--dev)
            shift
            ;;
        --help|-h)
            echo "Usage: install.sh [--latest | --version vX.Y.Z | --dev]"
            exit 0
            ;;
        *)
            err "Unknown argument: $1"
            exit 1
            ;;
    esac
done
```

Keep macOS, Xcode CLI, and `git` checks for the dev path. Add Python check because the helper is Python:

```bash
if ! command -v python3 &>/dev/null; then
    err "python3 is missing. Install Python 3 and retry."
    exit 1
fi
ok "Python $(python3 --version | awk '{print $2}')"
```

- [ ] **Step 2: Add helper download**

Add:

```bash
HELPER_URL="https://raw.githubusercontent.com/Nowhitestar/Yulu/main/yulu/scripts/release_installer.py"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/yulu-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

info "Downloading Yulu release installer helper"
if command -v curl &>/dev/null; then
    curl -fsSL "$HELPER_URL" -o "$TMP_DIR/release_installer.py"
else
    python3 - "$HELPER_URL" "$TMP_DIR/release_installer.py" <<'PY'
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
PY
fi
ok "Installer helper ready"
```

- [ ] **Step 3: Invoke helper**

Call:

```bash
python3 "$TMP_DIR/release_installer.py" install --install-dir "$INSTALL_DIR" "${TARGET_ARGS[@]}"
```

Remove the old git clone/pull default path from `install.sh`. Keep final "Done" text, but make it source-neutral:

```bash
echo "Yulu lives at: $INSTALL_DIR"
echo "Update later with:  yulu update"
```

- [ ] **Step 4: Update CI syntax check**

Ensure `.github/workflows/ci.yml` still includes `install.sh` in bash syntax checks. Add `python3 -m py_compile yulu/scripts/release_installer.py` to Python syntax checks if the wildcard does not cover it.

- [ ] **Step 5: Run syntax checks**

Run:

```bash
bash -n install.sh
python3 -m py_compile yulu/scripts/release_installer.py
```

Expected: no output.

- [ ] **Step 6: Commit task 7**

```bash
git add install.sh .github/workflows/ci.yml
git commit -m "feat(installer): bootstrap release asset installs"
```

## Task 8: `yulu update` Delegation

**Files:**
- Modify: `yulu/scripts/yulu`

- [ ] **Step 1: Update help text**

Change the update help block to:

```text
  update [--latest|--version vX.Y.Z|--dev]
                   Install latest stable release, a specific release, or dev main
```

Add examples near `usage()`:

```text
Examples:
  yulu update
  yulu update --version v0.5.0
  yulu update --dev
```

- [ ] **Step 2: Replace `cmd_update`**

Replace the git-pull implementation with:

```bash
cmd_update() {
    local args=("$@")
    info "Updating Yulu"
    PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" exec "${PYTHON:-python3}" \
        "$SCRIPT_DIR/release_installer.py" update \
        --install-dir "$REPO_DIR" \
        "${args[@]}"
}
```

This makes plain `yulu update` default to latest stable because `release_installer.py` defaults to latest.

- [ ] **Step 3: Preserve unknown argument behavior**

No extra shell parsing is needed in `yulu`; `release_installer.py` owns it and will print a clear error for invalid combinations.

- [ ] **Step 4: Run shell syntax check**

Run:

```bash
bash -n yulu/scripts/yulu
```

Expected: no output.

- [ ] **Step 5: Run CLI smoke**

Run:

```bash
PYTHONPATH=yulu/scripts python3 yulu/scripts/release_installer.py update --help
```

Expected: help includes `--latest`, `--version`, `--dev`, and `--install-dir`.

- [ ] **Step 6: Commit task 8**

```bash
git add yulu/scripts/yulu
git commit -m "feat(cli): route yulu update through release installer"
```

## Task 9: Packaging Scripts

**Files:**
- Create: `packaging/scripts/package.sh`
- Create: `packaging/scripts/checksums.sh`
- Modify: `Makefile`
- Create: `tests/test_package_release.py`

- [ ] **Step 1: Write package tests**

Create `tests/test_package_release.py`:

```python
import subprocess
import zipfile
from pathlib import Path


def test_package_excludes_git_tests_and_docs_superpowers(tmp_path):
    dist = tmp_path / "dist"
    version = Path("VERSION").read_text(encoding="utf-8").strip()
    tag = f"v{version}"
    result = subprocess.run(
        ["bash", "packaging/scripts/package.sh", tag, "--dist", str(dist), "--skip-build"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    zip_path = dist / f"yulu-macos-arm64-{tag}.zip"
    assert zip_path.exists()
    names = zipfile.ZipFile(zip_path).namelist()
    assert "yulu/VERSION" in names
    assert not any(name.startswith("yulu/.git/") for name in names)
    assert not any(name.startswith("yulu/tests/") for name in names)
    assert not any(name.startswith("yulu/docs/superpowers/") for name in names)
```

This keeps the test aligned with the current repo version, including prerelease versions such as `0.5.0-dev`.

- [ ] **Step 2: Run package test and verify failure**

Run:

```bash
python3 -m pytest tests/test_package_release.py -q
```

Expected: script missing.

- [ ] **Step 3: Create `package.sh`**

Implement:

```bash
#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?Usage: package.sh vX.Y.Z [--dist dist] [--skip-build]}"
DIST="dist"
SKIP_BUILD=false
shift || true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dist) DIST="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=true; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

VERSION="${TAG#v}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "Invalid release tag: $TAG" >&2
    exit 1
fi
if [[ "$(tr -d '[:space:]' < VERSION)" != "$VERSION" ]]; then
    echo "VERSION does not match $TAG" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/yulu-package.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

if [[ "$SKIP_BUILD" != true ]]; then
    bash "$ROOT/yulu/scripts/build_audio_daemon.sh"
    if [[ -x "$ROOT/yulu/scripts/build_status_agent.sh" ]]; then
        bash "$ROOT/yulu/scripts/build_status_agent.sh"
    fi
fi

mkdir -p "$STAGE/yulu"
rsync -a \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'tests/' \
  --exclude 'docs/superpowers/' \
  --exclude '.venv*/' \
  --exclude '.pytest_cache/' \
  --exclude '.ci-build/' \
  --exclude 'dist/' \
  --exclude '*.log' \
  --exclude 'meeting-recordings/' \
  "$ROOT/" "$STAGE/yulu/"

mkdir -p "$DIST"
(cd "$STAGE" && zip -qr "$ROOT/$DIST/yulu-macos-arm64-$TAG.zip" yulu)
echo "$ROOT/$DIST/yulu-macos-arm64-$TAG.zip"
```

- [ ] **Step 4: Create `checksums.sh`**

Implement:

```bash
#!/usr/bin/env bash
set -euo pipefail

DIST="${1:-dist}"
if [[ ! -d "$DIST" ]]; then
    echo "No dist directory: $DIST" >&2
    exit 1
fi
(cd "$DIST" && shasum -a 256 * > checksums.txt)
echo "$DIST/checksums.txt"
```

Make both scripts executable:

```bash
chmod +x packaging/scripts/package.sh packaging/scripts/checksums.sh
```

- [ ] **Step 5: Update `Makefile`**

Add:

```make
package:
	@if [ -z "$(TAG)" ]; then echo "Usage: make package TAG=vX.Y.Z"; exit 1; fi
	bash packaging/scripts/package.sh "$(TAG)"

checksums:
	bash packaging/scripts/checksums.sh dist
```

- [ ] **Step 6: Run package checks**

Run:

```bash
bash -n packaging/scripts/package.sh
bash -n packaging/scripts/checksums.sh
python3 -m pytest tests/test_package_release.py -q
```

Expected: pass.

- [ ] **Step 7: Commit task 9**

```bash
git add packaging/scripts/package.sh packaging/scripts/checksums.sh Makefile tests/test_package_release.py
git commit -m "feat(release): package Yulu release assets"
```

## Task 10: Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Create release workflow**

Add:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  release:
    runs-on: macos-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Verify VERSION matches tag
        run: |
          set -euo pipefail
          tag="${GITHUB_REF_NAME}"
          version="${tag#v}"
          test "$(tr -d '[:space:]' < VERSION)" = "$version"

      - name: Bash syntax check
        run: |
          set -euo pipefail
          bash -n install.sh
          bash -n yulu/scripts/setup.sh
          bash -n yulu/scripts/uninstall.sh
          bash -n yulu/scripts/yulu
          bash -n packaging/scripts/package.sh
          bash -n packaging/scripts/checksums.sh

      - name: Python tests
        run: |
          set -euo pipefail
          python3 -m venv .venv-ci
          . .venv-ci/bin/activate
          python -m pip install --upgrade pip
          python -m pip install pytest
          python -m pytest -q

      - name: Swift build
        run: make swift-build

      - name: Package
        run: |
          set -euo pipefail
          bash packaging/scripts/package.sh "$GITHUB_REF_NAME"
          cp install.sh dist/install.sh
          bash packaging/scripts/checksums.sh dist

      - name: Create or update GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
            gh release upload "$GITHUB_REF_NAME" dist/* --clobber
          else
            gh release create "$GITHUB_REF_NAME" dist/* --title "$GITHUB_REF_NAME" --notes-file CHANGELOG.md
          fi
```

- [ ] **Step 2: Update CI to cover new scripts**

In `.github/workflows/ci.yml`, add packaging scripts to bash syntax check and ensure `python3 -m pytest -q` includes new tests.

- [ ] **Step 3: Validate workflow YAML locally enough**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
for path in [Path('.github/workflows/release.yml'), Path('.github/workflows/ci.yml')]:
    text = path.read_text()
    assert 'runs-on: macos-latest' in text
    assert '\t' not in text
print('workflow smoke OK')
PY
```

Expected: `workflow smoke OK`.

- [ ] **Step 4: Commit task 10**

```bash
git add .github/workflows/release.yml .github/workflows/ci.yml
git commit -m "ci: publish release assets on tags"
```

## Task 11: Documentation and Changelog

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/RELEASE.md`
- Modify: `CHANGELOG.md`
- Modify: `yulu/scripts/yulu`

- [ ] **Step 1: Update README install section**

In both READMEs, change the install explanation to say:

```markdown
By default, the one-line installer downloads the latest stable GitHub Release asset.
It does not follow `main` unless you explicitly choose the dev channel.
```

Add commands:

```bash
# Latest stable
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash

# Specific release
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --version v0.5.0

# Dev channel
curl -fsSL https://raw.githubusercontent.com/Nowhitestar/Yulu/main/install.sh | bash -s -- --dev
```

- [ ] **Step 2: Update update docs**

Document:

```bash
yulu update
yulu update --version v0.5.0
yulu update --dev
```

State explicitly:

```text
`--version` affects that operation only. The next plain `yulu update` returns to latest stable.
```

- [ ] **Step 3: Rewrite `docs/RELEASE.md`**

Replace the "Manual release skeleton" future language with:

````markdown
## Release Steps

1. Ensure `VERSION` contains the intended version without leading `v`.
2. Update `CHANGELOG.md`.
3. Run `make test`.
4. Run `make package TAG=vX.Y.Z`.
5. Run `make checksums`.
6. Tag and push:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

GitHub Actions will create or update the GitHub Release and upload `yulu-macos-arm64-vX.Y.Z.zip`, `install.sh`, and `checksums.txt`.
````

- [ ] **Step 4: Update changelog**

Under `[Unreleased]`, add:

```markdown
### Added
- Release-asset based installer and updater. Stable installs now download GitHub Release assets by default, support `--version vX.Y.Z`, and keep `--dev` as the explicit main-branch channel.
- Release packaging scripts and tag-triggered GitHub Actions workflow for `yulu-macos-arm64-<version>.zip`, `install.sh`, and `checksums.txt`.
```

- [ ] **Step 5: Run docs smoke**

Run:

```bash
rg -n "main install|git pull|latest stable|--version|--dev" README.md README.zh-CN.md docs/RELEASE.md CHANGELOG.md yulu/scripts/yulu
```

Expected: no stale statement claiming default install/update follows `main`; dev references must be explicitly marked as dev channel.

- [ ] **Step 6: Commit task 11**

```bash
git add README.md README.zh-CN.md docs/RELEASE.md CHANGELOG.md yulu/scripts/yulu
git commit -m "docs: document release asset installs"
```

## Task 12: End-to-End Verification

**Files:**
- No new source files unless fixes are required.

- [ ] **Step 1: Run focused tests**

Run:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest \
  tests/test_release_installer.py \
  tests/test_release_installer_integration.py \
  tests/test_package_release.py \
  tests/test_version.py \
  -q
```

Expected: pass.

- [ ] **Step 2: Run full test suite**

Run:

```bash
make test
```

Expected: Python tests pass; Swift build either succeeds or prints the existing skip behavior only if `swiftc` is missing.

- [ ] **Step 3: Build local package**

Run:

```bash
rm -rf dist
make package TAG=v$(tr -d '[:space:]' < VERSION)
make checksums
ls -l dist
```

Expected: `dist/yulu-macos-arm64-v<version>.zip` and `dist/checksums.txt` exist.

- [ ] **Step 4: Inspect package contents**

Run:

```bash
python3 - <<'PY'
import zipfile
from pathlib import Path
zip_path = next(Path("dist").glob("yulu-macos-arm64-*.zip"))
names = zipfile.ZipFile(zip_path).namelist()
required = ["yulu/VERSION", "yulu/install.sh", "yulu/yulu/scripts/yulu", "yulu/yulu/scripts/release_installer.py"]
for item in required:
    assert item in names, item
for forbidden in ["yulu/.git/", "yulu/tests/", "yulu/docs/superpowers/"]:
    assert not any(name.startswith(forbidden) for name in names), forbidden
print("package contents OK")
PY
```

Expected: `package contents OK`.

- [ ] **Step 5: Run fake local install smoke**

Run the integration test again with verbose output:

```bash
PYTHONPATH=yulu/scripts python3 -m pytest tests/test_release_installer_integration.py -q -vv
```

Expected: local `file://` release install works and writes `.yulu-install.json`.

- [ ] **Step 6: Check git diff for accidental runtime/user artifacts**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intended source, test, workflow, packaging, and docs files changed. Do not commit `dist/`, `.ci-build/`, app rebuild artifacts unless they are already tracked and intentionally updated.

- [ ] **Step 7: Final commit if verification fixes were needed**

If verification required fixes:

```bash
git add <fixed-files>
git commit -m "fix(installer): tighten release asset verification"
```

If no fixes were needed, no commit is required for this task.

## Self-Review Checklist

- Spec coverage:
  - Stable release default: Tasks 5, 7, 8, 11.
  - `--version`: Tasks 1, 5, 7, 8, 11.
  - `yulu update` latest stable: Tasks 5 and 8.
  - rollback/switching: Tasks 4 and 8.
  - explicit dev channel: Task 5.
  - shared Python helper: Tasks 1-6.
  - packaging assets/checksums: Task 9.
  - release workflow: Task 10.
  - metadata/version output: Task 3.
  - docs: Task 11.
  - verification: Task 12.
- Red-flag scan: no open-ended fill-in work, no deferred implementation notes, no vague validation steps.
- Type consistency: `ReleaseTarget`, `ReleaseAsset`, `InstallMetadata`, `InstallError`, `install_release_from_urls`, and `install_dev_channel` are introduced before later tasks use them.
