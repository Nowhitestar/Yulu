#!/usr/bin/env python3
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import platform
import plistlib
import re
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SEMVER_RE = re.compile(
    r"^v?"
    r"(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)\."
    r"(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"$"
)
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
# Homebrew and first-run Node dependency work can legitimately take a while on a
# fresh machine. Keep this above the release operations SLA instead of turning a
# slow but healthy install into a rollback after five minutes.
SETUP_TIMEOUT_SECONDS = 30 * 60
RUN_TIMEOUT_SECONDS = 300
REPO_URL = "https://github.com/Nowhitestar/Yulu.git"
REPO = "Nowhitestar/Yulu"
GITHUB_API = "https://api.github.com"
EXPECTED_APPLE_TEAM_ID = "WMU9678ZQL"
RUNTIME_MANIFEST_RELATIVE_PATH = Path(
    "yulu/scripts/Yulu.app/Contents/Resources/runtime-manifest.json"
)
SIGNED_BUNDLE_PREFIXES = (
    "yulu/scripts/Yulu.app/",
    "yulu/scripts/StatusAgent.app/",
)
MAX_RUNTIME_MANIFEST_BYTES = 8 * 1024 * 1024


class InstallError(RuntimeError):
    pass


class RecordingActiveInstallError(InstallError):
    """The installer refused a mutation because native capture is active."""


def assert_recording_idle(scripts_dir: Path) -> None:
    """Run ``migrate.guard.recording_active`` from one trusted runtime."""
    scripts_dir = scripts_dir.resolve(strict=False)
    guard_path = scripts_dir / "migrate" / "guard.py"
    if not guard_path.is_file():
        raise InstallError(
            f"Yulu recording safety guard is missing at {guard_path}; "
            "the existing runtime cannot be updated safely. Reinstall a current stable release first."
        )

    module_name = f"_yulu_installer_guard_{time.monotonic_ns()}"
    original_path = sys.path.copy()
    missing = object()
    original_record_audio = sys.modules.pop("record_audio", missing)
    try:
        spec = importlib.util.spec_from_file_location(module_name, guard_path)
        if spec is None or spec.loader is None:
            raise ImportError("Python could not create a module loader")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        sys.path.insert(0, str(scripts_dir))
        spec.loader.exec_module(module)
        predicate = getattr(module, "recording_active", None)
        if not callable(predicate):
            raise AttributeError("recording_active is not callable")
        if predicate():
            raise RecordingActiveInstallError(
                "Refusing Yulu install/update: a recording is in progress. "
                "Stop the recording, then retry."
            )
    except RecordingActiveInstallError:
        raise
    except Exception as exc:
        raise InstallError(f"Could not load recording safety guard from {guard_path}: {exc}") from exc
    finally:
        sys.path[:] = original_path
        sys.modules.pop(module_name, None)
        if original_record_audio is missing:
            sys.modules.pop("record_audio", None)
        else:
            sys.modules["record_audio"] = original_record_audio


def run(cmd: list[str], cwd: Path | None = None, timeout: float = RUN_TIMEOUT_SECONDS) -> str:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise InstallError(f"{cmd[0]} timed out after {timeout}s") from exc
    except OSError as exc:
        raise InstallError(f"{' '.join(cmd)} failed: {exc}") from exc
    if result.returncode != 0:
        raise InstallError(result.stderr.strip() or result.stdout.strip() or f"{cmd[0]} failed")
    return result.stdout.strip()


@dataclass(frozen=True)
class ReleaseTarget:
    kind: str  # "latest" | "version" | "dev"
    tag: str | None = None


@dataclass(frozen=True)
class ReleaseAsset:
    tag: str
    asset_name: str
    asset_url: str
    checksums_url: str | None = None


@dataclass(frozen=True)
class InstallMetadata:
    source: str
    version: str | None = None
    asset: str | None = None
    sha256: str | None = None
    branch: str | None = None
    commit: str | None = None


@dataclass(frozen=True)
class ConfigSnapshot:
    config_path: Path
    existed: bool
    snapshot_path: Path | None = None


def target_to_dict(target: ReleaseTarget) -> dict[str, str | None]:
    return {"kind": target.kind, "tag": target.tag}


def normalize_version_tag(value: str) -> str:
    version = value.strip()
    if not SEMVER_RE.match(version):
        raise ValueError(f"{value!r} is not a valid SemVer release tag")
    return version if version.startswith("v") else f"v{version}"


def _tag_without_v(tag: str) -> str:
    return tag[1:] if tag.startswith("v") else tag


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
    if args.version is not None:
        return ReleaseTarget(kind="version", tag=normalize_version_tag(args.version))
    return ReleaseTarget(kind="latest")


def select_release_asset(release: dict) -> ReleaseAsset:
    tag = str(release.get("tag_name") or "")
    if not tag:
        raise InstallError("GitHub release response did not include tag_name")
    expected_zip = f"yulu-macos-arm64-{tag}.zip"
    expected_checksums = "checksums.txt"
    assets = release.get("assets") or []
    by_name = {str(asset.get("name")): asset for asset in assets}
    zip_asset = by_name.get(expected_zip)
    checksums_asset = by_name.get(expected_checksums)
    if zip_asset is None or checksums_asset is None:
        missing = [name for name, asset in ((expected_zip, zip_asset), (expected_checksums, checksums_asset)) if asset is None]
        raise InstallError(f"Release {tag} does not provide required asset(s): {', '.join(missing)}")
    zip_url = str(zip_asset.get("browser_download_url") or "").strip()
    checksums_url = str(checksums_asset.get("browser_download_url") or "").strip()
    if not zip_url or not checksums_url:
        raise InstallError(f"Release {tag} zip/checksums assets did not include download URLs.")
    return ReleaseAsset(
        tag=tag,
        asset_name=expected_zip,
        asset_url=zip_url,
        checksums_url=checksums_url,
    )


def github_release_api_url(target: ReleaseTarget) -> str:
    if target.kind == "latest":
        return f"{GITHUB_API}/repos/{REPO}/releases/latest"
    if target.kind == "version" and target.tag:
        return f"{GITHUB_API}/repos/{REPO}/releases/tags/{target.tag}"
    raise InstallError(f"GitHub release URL is not valid for target {target}")


def _release_not_found_message(url: str) -> str:
    marker = "/releases/tags/"
    if marker in url:
        tag = urllib.parse.unquote(url.rsplit(marker, 1)[1])
        return f"Release {tag} was not found"
    return "Latest release was not found"


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "YuluInstaller"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise InstallError(_release_not_found_message(url)) from exc
        raise InstallError(f"Failed to fetch GitHub release metadata: HTTP {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise InstallError(f"Failed to fetch GitHub release metadata: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise InstallError("GitHub release metadata was not valid JSON") from exc
    if not isinstance(data, dict):
        raise InstallError("GitHub release metadata was not a JSON object")
    return data


def resolve_release_from_payload(payload: dict) -> ReleaseAsset:
    return select_release_asset(payload)


def parse_checksums(text: str) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        checksum, name = parts[0], parts[-1].lstrip("*")
        if not SHA256_RE.match(checksum):
            continue
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


def validate_runtime_layout(runtime_dir: Path, tag: str) -> None:
    runtime_dir = runtime_dir.resolve()
    required = [
        runtime_dir / "VERSION",
        runtime_dir / "yulu" / "scripts" / "setup.sh",
        runtime_dir / "yulu" / "scripts" / "yulu",
        runtime_dir / "yulu" / "scripts" / "version.py",
        runtime_dir / "yulu" / "scripts" / "Yulu.app" / "Contents" / "MacOS" / "xai_keychain",
    ]
    for path in required:
        if not path.is_file():
            raise InstallError(f"Invalid release asset: missing {path.relative_to(runtime_dir)}")

    version = (runtime_dir / "VERSION").read_text(encoding="utf-8").strip()
    if version != _tag_without_v(tag):
        raise InstallError(f"VERSION {version!r} does not match release tag {tag!r}")


def _normalize_manifest_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise InstallError("Runtime manifest contains an invalid path")
    path = PurePosixPath(value)
    normalized = path.as_posix()
    if path.is_absolute() or normalized != value or any(part in ("", ".", "..") for part in path.parts):
        raise InstallError(f"Runtime manifest contains unsafe path {value!r}")
    return normalized


def _is_signed_bundle_path(relative_path: str) -> bool:
    return any(relative_path.startswith(prefix) for prefix in SIGNED_BUNDLE_PREFIXES)


def build_runtime_manifest_from_zip(zip_path: Path) -> dict[str, object]:
    """Build the exact non-bundle payload manifest that Yulu.app will sign."""
    entries: list[dict[str, object]] = []
    seen: set[str] = set()
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            if not info.filename.startswith("yulu/"):
                raise InstallError(f"Release zip contains file outside top-level yulu/: {info.filename!r}")
            relative_path = _normalize_manifest_path(info.filename.removeprefix("yulu/"))
            if _is_signed_bundle_path(relative_path):
                continue
            if relative_path in seen:
                raise InstallError(f"Release zip contains duplicate file {relative_path!r}")
            seen.add(relative_path)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise InstallError(f"Release zip contains unsupported symlink {relative_path!r}")
            data = archive.read(info)
            entries.append(
                {
                    "path": relative_path,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size": len(data),
                    "executable": bool(mode & 0o111),
                }
            )
    entries.sort(key=lambda entry: str(entry["path"]))
    return {
        "schema": 1,
        "algorithm": "sha256",
        "signed_by": RUNTIME_MANIFEST_RELATIVE_PATH.as_posix(),
        "excluded_signed_bundles": [prefix.rstrip("/") for prefix in SIGNED_BUNDLE_PREFIXES],
        "files": entries,
    }


def write_runtime_manifest(path: Path, manifest: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o644)


def verify_runtime_manifest(runtime_dir: Path) -> None:
    """Verify every file outside the two separately signed app bundles."""
    manifest_path = runtime_dir / RUNTIME_MANIFEST_RELATIVE_PATH
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise InstallError(
            f"Invalid release asset: missing signed runtime manifest {RUNTIME_MANIFEST_RELATIVE_PATH}"
        )
    if manifest_path.stat().st_size > MAX_RUNTIME_MANIFEST_BYTES:
        raise InstallError("Signed runtime manifest is unexpectedly large")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InstallError(f"Signed runtime manifest is unreadable: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or manifest.get("algorithm") != "sha256":
        raise InstallError("Signed runtime manifest has an unsupported schema")
    if manifest.get("signed_by") != RUNTIME_MANIFEST_RELATIVE_PATH.as_posix():
        raise InstallError("Signed runtime manifest has an invalid signer location")
    expected_bundles = [prefix.rstrip("/") for prefix in SIGNED_BUNDLE_PREFIXES]
    if manifest.get("excluded_signed_bundles") != expected_bundles:
        raise InstallError("Signed runtime manifest has an invalid bundle exclusion set")
    raw_entries = manifest.get("files")
    if not isinstance(raw_entries, list):
        raise InstallError("Signed runtime manifest files must be a list")

    expected: dict[str, tuple[str, int, bool]] = {}
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict) or set(raw_entry) != {"path", "sha256", "size", "executable"}:
            raise InstallError("Signed runtime manifest contains an invalid file entry")
        relative_path = _normalize_manifest_path(raw_entry.get("path"))
        if _is_signed_bundle_path(relative_path):
            raise InstallError(f"Signed runtime manifest must not list app-bundle member {relative_path!r}")
        checksum = raw_entry.get("sha256")
        size = raw_entry.get("size")
        executable = raw_entry.get("executable")
        if not isinstance(checksum, str) or not SHA256_RE.fullmatch(checksum):
            raise InstallError(f"Signed runtime manifest has invalid checksum for {relative_path!r}")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or not isinstance(executable, bool):
            raise InstallError(f"Signed runtime manifest has invalid metadata for {relative_path!r}")
        if relative_path in expected:
            raise InstallError(f"Signed runtime manifest lists duplicate file {relative_path!r}")
        expected[relative_path] = (checksum.lower(), size, executable)

    actual: dict[str, Path] = {}
    for path in runtime_dir.rglob("*"):
        if path.is_dir() and not path.is_symlink():
            continue
        relative_path = path.relative_to(runtime_dir).as_posix()
        if _is_signed_bundle_path(relative_path):
            continue
        if path.is_symlink() or not path.is_file():
            raise InstallError(f"Release runtime contains unsupported file type at {relative_path!r}")
        actual[relative_path] = path

    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing={missing[:5]}")
        if extra:
            details.append(f"extra={extra[:5]}")
        raise InstallError(f"Signed runtime manifest does not match release payload: {'; '.join(details)}")

    for relative_path, path in actual.items():
        checksum, size, executable = expected[relative_path]
        file_stat = path.stat()
        if file_stat.st_size != size:
            raise InstallError(f"Signed runtime manifest size mismatch for {relative_path}")
        if bool(file_stat.st_mode & 0o111) != executable:
            raise InstallError(f"Signed runtime manifest executable-bit mismatch for {relative_path}")
        actual_checksum = sha256_file(path)
        if actual_checksum.lower() != checksum:
            raise InstallError(f"Signed runtime manifest checksum mismatch for {relative_path}")


def _run_verification(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired as exc:
        raise InstallError(f"Release verification timed out: {' '.join(cmd)}") from exc
    except OSError as exc:
        raise InstallError(f"Release verification failed to start: {' '.join(cmd)}: {exc}") from exc


def verify_release_bundle_security(runtime_dir: Path, *, require_staple: bool = False) -> None:
    """Verify the publisher boundary before swapping a downloaded runtime in."""
    codesign = shutil.which("codesign")
    if not codesign:
        raise InstallError("macOS codesign is required to verify release app bundles")
    bundles = [
        runtime_dir / "yulu" / "scripts" / "Yulu.app",
        runtime_dir / "yulu" / "scripts" / "StatusAgent.app",
    ]
    for bundle in bundles:
        if not bundle.is_dir():
            raise InstallError(f"Invalid release asset: missing {bundle.relative_to(runtime_dir)}")
        verify = _run_verification(
            [codesign, "--verify", "--deep", "--strict", "--verbose=2", str(bundle)]
        )
        if verify.returncode != 0:
            detail = (verify.stderr or verify.stdout).strip()
            raise InstallError(f"Code signature verification failed for {bundle.name}: {detail}")
        inspect = _run_verification([codesign, "-dv", "--verbose=4", str(bundle)])
        signature = f"{inspect.stdout}\n{inspect.stderr}"
        if inspect.returncode != 0:
            raise InstallError(f"Could not inspect code signature for {bundle.name}")
        if "Authority=Developer ID Application:" not in signature:
            raise InstallError(f"Release app {bundle.name} is not signed with Developer ID Application")
        if f"TeamIdentifier={EXPECTED_APPLE_TEAM_ID}" not in signature:
            raise InstallError(
                f"Release app {bundle.name} is not signed by expected Team ID {EXPECTED_APPLE_TEAM_ID}"
            )

    # stapler is not available on every end-user Mac. When Xcode exposes it,
    # validate the embedded notarization ticket; codesign verification above is
    # always mandatory and does not require network access.
    xcrun = shutil.which("xcrun")
    if not xcrun:
        return
    find_stapler = _run_verification([xcrun, "--find", "stapler"])
    if find_stapler.returncode != 0:
        return
    for bundle in bundles:
        stapler = _run_verification([xcrun, "stapler", "validate", str(bundle)])
        if stapler.returncode != 0:
            detail = (stapler.stderr or stapler.stdout).strip()
            if require_staple:
                raise InstallError(f"Notarization ticket validation failed for {bundle.name}: {detail}")
            print(
                f"warning: could not validate notarization ticket for {bundle.name}: {detail}",
                file=sys.stderr,
            )


def _apple_silicon_capable() -> bool:
    if platform.machine().lower() == "arm64":
        return True
    sysctl = shutil.which("sysctl")
    if not sysctl:
        return False
    probe = _run_verification([sysctl, "-n", "hw.optional.arm64"])
    return probe.returncode == 0 and probe.stdout.strip() == "1"


def ensure_release_architecture() -> None:
    if sys.platform == "darwin" and not _apple_silicon_capable():
        raise InstallError(
            "Official Yulu release assets require Apple Silicon (arm64). "
            "This Mac reports an Intel-only architecture; use a supported Apple Silicon Mac."
        )


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
    install_metadata_path(runtime_dir).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def read_install_metadata(runtime_dir: Path) -> dict:
    path = install_metadata_path(runtime_dir)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def build_dev_metadata(branch: str, commit: str) -> InstallMetadata:
    return InstallMetadata(source="dev", branch=branch, commit=commit)


def file_url_to_path(url: str) -> Path:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "file":
        raise InstallError(f"Expected file URL, got {url!r}")
    if parsed.netloc not in ("", "localhost"):
        raise InstallError(f"Refusing non-local file URL host {parsed.netloc!r}")
    return Path(urllib.request.url2pathname(parsed.path))


def download_to_path(url: str, dest: Path) -> None:
    try:
        if url.startswith("file://"):
            src = file_url_to_path(url)
            shutil.copy2(src, dest)
            return
        with urllib.request.urlopen(url, timeout=30) as response, dest.open("wb") as handle:
            shutil.copyfileobj(response, handle)
    except InstallError:
        raise
    except urllib.error.HTTPError as exc:
        raise InstallError(f"Failed to download {url}: HTTP {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise InstallError(f"Failed to download {url}: {exc.reason}") from exc
    except OSError as exc:
        raise InstallError(f"Failed to save {url}: {exc}") from exc


def read_url_text(url: str) -> str:
    try:
        if url.startswith("file://"):
            src = file_url_to_path(url)
            return src.read_text(encoding="utf-8")
        with urllib.request.urlopen(url, timeout=30) as response:
            return response.read().decode("utf-8")
    except InstallError:
        raise
    except urllib.error.HTTPError as exc:
        raise InstallError(f"Failed to download {url}: HTTP {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise InstallError(f"Failed to download {url}: {exc.reason}") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise InstallError(f"Failed to read {url}: {exc}") from exc


def _assert_safe_zip_member(dest: Path, member: str) -> None:
    member_path = Path(member)
    if member_path.is_absolute():
        raise InstallError(f"Unsafe zip member {member!r}: absolute paths are not allowed")
    resolved_dest = dest.resolve()
    resolved_member = (dest / member_path).resolve()
    if resolved_dest != resolved_member and resolved_dest not in resolved_member.parents:
        raise InstallError(f"Unsafe zip member {member!r}: path escapes extraction directory")


def extract_release_zip(zip_path: Path, dest: Path) -> Path:
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            _assert_safe_zip_member(dest, member)
        archive.extractall(dest)
        # ZipFile.extractall() does NOT restore the Unix permission bits stored
        # in each entry's external_attr — every file lands as 0644. That breaks
        # the Mach-O binaries launchd must spawn directly (Yulu.app /
        # StatusAgent.app), which then fail with "Launchd job spawn failed".
        # Re-apply the recorded mode so the extracted runtime is self-contained.
        for info in archive.infolist():
            mode = (info.external_attr >> 16) & 0o7777
            if not mode:
                continue
            target = dest / info.filename
            if target.is_symlink() or not target.exists():
                continue
            os.chmod(target, mode)
    runtime = dest / "yulu"
    if not runtime.exists():
        raise InstallError("Release zip must expand to a top-level yulu/ directory")
    return runtime


def path_exists_or_symlink(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def default_config_path() -> Path:
    return Path.home() / ".config" / "yulu" / "config.json"


def _fsync_directory(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def create_config_snapshot(config_path: Path) -> ConfigSnapshot:
    """Capture config bytes beside config.json without exposing a partial snapshot."""
    expanded = config_path.expanduser()
    config_path = expanded.parent.resolve(strict=False) / expanded.name
    if not path_exists_or_symlink(config_path):
        return ConfigSnapshot(config_path=config_path, existed=False)
    if config_path.is_symlink() or not config_path.is_file():
        raise InstallError(f"Refusing to snapshot non-regular config path: {config_path}")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_stage = tempfile.mkstemp(
        prefix=f".{config_path.name}.yulu-install-snapshot-",
        suffix=".pending",
        dir=str(config_path.parent),
    )
    stage = Path(raw_stage)
    snapshot = stage.with_name(stage.name.removesuffix(".pending"))
    try:
        os.fchmod(fd, 0o600)
        destination = os.fdopen(fd, "wb", closefd=True)
        fd = -1
        with destination, config_path.open("rb") as source:
            shutil.copyfileobj(source, destination)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(stage, snapshot)
        snapshot.chmod(0o600)
        _fsync_directory(config_path.parent)
    except Exception:
        if fd >= 0:
            os.close(fd)
        if stage.exists():
            stage.unlink()
        raise
    return ConfigSnapshot(config_path=config_path, existed=True, snapshot_path=snapshot)


def restore_config_snapshot(snapshot: ConfigSnapshot) -> None:
    config_path = snapshot.config_path
    if snapshot.existed:
        source = snapshot.snapshot_path
        if source is None or source.is_symlink() or not source.is_file():
            raise InstallError("Config rollback snapshot is missing or invalid")
        if config_path.exists() and config_path.is_dir() and not config_path.is_symlink():
            raise InstallError(f"Refusing to replace config directory during rollback: {config_path}")
        source.chmod(0o600)
        os.replace(source, config_path)
        config_path.chmod(0o600)
        _fsync_directory(config_path.parent)
        return
    if path_exists_or_symlink(config_path):
        if config_path.is_dir() and not config_path.is_symlink():
            raise InstallError(f"Refusing to remove config directory during rollback: {config_path}")
        config_path.unlink()
        _fsync_directory(config_path.parent)


def discard_config_snapshot(snapshot: ConfigSnapshot) -> None:
    source = snapshot.snapshot_path
    if source is not None and path_exists_or_symlink(source):
        if source.is_symlink() or not source.is_file():
            raise InstallError(f"Refusing to remove invalid config snapshot: {source}")
        source.unlink()
        _fsync_directory(source.parent)


def install_lock_path(install_dir: Path) -> Path:
    return install_dir.parent / f".{install_dir.name}.install.lock"


@contextmanager
def acquire_install_lock(install_dir: Path):
    """Serialize the full install/update transaction for one runtime path."""
    install_dir = install_dir.expanduser().resolve(strict=False)
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    path = install_lock_path(install_dir)
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as exc:
        raise InstallError(f"Could not open installer lock {path}: {exc}") from exc
    handle = os.fdopen(fd, "r+", encoding="utf-8")
    try:
        os.fchmod(handle.fileno(), 0o600)
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EAGAIN):
                raise InstallError(f"Could not acquire installer lock {path}: {exc}") from exc
            handle.seek(0)
            owner = handle.read().strip()
            detail = f" ({owner})" if owner else ""
            raise InstallError(
                f"Another Yulu install/update is already running for {install_dir}{detail}"
            ) from exc
        handle.seek(0)
        handle.truncate()
        handle.write(
            json.dumps(
                {
                    "pid": os.getpid(),
                    "started_at": datetime.now(timezone.utc)
                    .replace(microsecond=0)
                    .isoformat()
                    .replace("+00:00", "Z"),
                },
                separators=(",", ":"),
            )
        )
        handle.flush()
        os.fsync(handle.fileno())
        yield path
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def replace_runtime_with_backup(staged_runtime: Path, install_dir: Path) -> Path | None:
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path_exists_or_symlink(install_dir):
        # Keep successful-install backups for manual recovery until a later cleanup policy exists.
        backup = Path(
            tempfile.mkdtemp(prefix=f"{install_dir.name}.backup-", dir=str(install_dir.parent))
        )
        backup.rmdir()
        os.replace(install_dir, backup)
    try:
        # The staging directory is deliberately created under install_dir.parent,
        # so both swaps are same-volume atomic renames and never require sudo.
        os.replace(staged_runtime, install_dir)
    except Exception as move_error:
        if backup is not None:
            try:
                restore_backup(backup, install_dir)
            except Exception as restore_error:
                raise InstallError(
                    f"Failed to replace runtime ({move_error}); backup restore failed ({restore_error})"
                ) from move_error
        raise InstallError(f"Failed to replace runtime: {move_error}") from move_error
    return backup


def prune_runtime_backups(install_dir: Path, *, keep: Path | None) -> None:
    """Keep the immediately previous runtime and remove older verified backups."""
    parent = install_dir.parent.resolve(strict=False)
    keep_resolved = keep.resolve(strict=False) if keep is not None else None
    prefix = f"{install_dir.name}.backup-"
    for candidate in parent.glob(f"{prefix}*"):
        resolved = candidate.resolve(strict=False)
        if keep_resolved is not None and resolved == keep_resolved:
            continue
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        # Delete only directories that still have the shape of a Yulu runtime;
        # never treat an arbitrary same-prefix user directory as ours.
        if not (candidate / "VERSION").is_file() or not (candidate / "yulu" / "scripts").is_dir():
            continue
        shutil.rmtree(candidate)


def restore_backup(backup: Path, install_dir: Path) -> None:
    if path_exists_or_symlink(install_dir):
        if install_dir.is_dir() and not install_dir.is_symlink():
            shutil.rmtree(install_dir)
        else:
            install_dir.unlink()
    os.replace(backup, install_dir)


def _terminate_process_group(process: subprocess.Popen, grace_seconds: float = 5) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=grace_seconds)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait()


def _run_setup_script(install_dir: Path, upgrade: bool, timeout: float = SETUP_TIMEOUT_SECONDS) -> None:
    setup = install_dir / "yulu" / "scripts" / "setup.sh"
    cmd = ["bash", str(setup)]
    if upgrade:
        cmd.append("--upgrade")
    try:
        process = subprocess.Popen(cmd, cwd=str(install_dir), start_new_session=True)
    except OSError as exc:
        raise InstallError(f"setup.sh failed to start: {exc}") from exc
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        # setup.sh may be waiting on brew/npm children. Killing only bash leaves
        # those mutating the machine after rollback, so terminate its session as
        # one process group and escalate if a child ignores SIGTERM.
        _terminate_process_group(process)
        raise InstallError(f"setup.sh timed out after {timeout}s; terminated its process group") from exc
    except KeyboardInterrupt as exc:
        _terminate_process_group(process)
        raise InstallError("setup.sh was interrupted; terminated its process group") from exc
    except BaseException:
        _terminate_process_group(process)
        raise
    if returncode != 0:
        raise InstallError(f"setup.sh failed with exit code {returncode}")


run_setup = _run_setup_script


def repair_restored_runtime(install_dir: Path, timeout: float = SETUP_TIMEOUT_SECONDS) -> None:
    """Re-apply an old runtime's LaunchAgents after a failed upgrade rollback."""
    setup = install_dir / "yulu" / "scripts" / "setup.sh"
    if setup.is_file():
        _run_setup_script(install_dir, upgrade=True, timeout=timeout)


def move_existing_runtime_to_backup(install_dir: Path) -> Path | None:
    if not path_exists_or_symlink(install_dir):
        return None
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=f"{install_dir.name}.backup-", dir=str(install_dir.parent)))
    backup.rmdir()
    shutil.move(str(install_dir), str(backup))
    return backup


def remove_runtime(path: Path) -> None:
    if path_exists_or_symlink(path):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()


def _is_within(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def _cleanup_command(cmd: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None


def cleanup_fresh_install_side_effects(install_dir: Path, *, home: Path | None = None) -> None:
    """Remove only launch state whose recorded path belongs to a failed fresh install."""
    resolved_install = install_dir.expanduser().resolve(strict=False)
    scripts_prefix = str(resolved_install / "yulu" / "scripts")
    user_home = (home or Path.home()).expanduser().resolve(strict=False)
    errors: list[str] = []

    launchctl = shutil.which("launchctl")
    launch_agents = user_home / "Library" / "LaunchAgents"
    if launch_agents.is_dir():
        for plist in sorted(launch_agents.glob("com.yulu.*.plist")):
            try:
                raw = plist.read_bytes()
            except OSError as exc:
                errors.append(f"could not read {plist}: {exc}")
                continue
            if str(resolved_install).encode() not in raw:
                continue
            label = None
            try:
                payload = plistlib.loads(raw)
                if isinstance(payload, dict) and isinstance(payload.get("Label"), str):
                    label = payload["Label"]
            except Exception:
                pass
            if launchctl:
                _cleanup_command([launchctl, "unload", str(plist)])
                if label:
                    _cleanup_command([launchctl, "remove", label])
            try:
                plist.unlink()
            except OSError as exc:
                errors.append(f"could not remove {plist}: {exc}")

    local_cli = user_home / ".local" / "bin" / "yulu"
    if local_cli.is_symlink():
        try:
            target = (local_cli.parent / os.readlink(local_cli)).resolve(strict=False)
            if _is_within(target, resolved_install):
                local_cli.unlink()
        except OSError as exc:
            errors.append(f"could not remove {local_cli}: {exc}")

    pgrep = shutil.which("pgrep")
    ps = shutil.which("ps")
    if pgrep and ps:
        matches = _cleanup_command([pgrep, "-f", scripts_prefix])
        if matches and matches.returncode in (0, 1):
            for raw_pid in matches.stdout.splitlines():
                try:
                    pid = int(raw_pid)
                except ValueError:
                    continue
                if pid == os.getpid():
                    continue
                command = _cleanup_command([ps, "-p", str(pid), "-o", "command="])
                if command and command.returncode == 0 and scripts_prefix in command.stdout:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    except OSError as exc:
                        errors.append(f"could not terminate process {pid}: {exc}")

    if errors:
        raise InstallError("Fresh-install cleanup was incomplete: " + "; ".join(errors))


def capture_clean_dev_checkout(install_dir: Path) -> tuple[str, str]:
    """Capture rollback state only after the caller confirmed a clean worktree."""
    root = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=install_dir)).resolve(strict=False)
    expected_root = install_dir.resolve(strict=False)
    if root != expected_root:
        raise InstallError(
            f"Refusing dev update because checkout root {root} does not match install dir {expected_root}"
        )
    head = run(["git", "rev-parse", "HEAD"], cwd=install_dir).strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", head):
        raise InstallError(f"Could not capture exact dev checkout HEAD before update: {head!r}")
    # Empty means detached HEAD; otherwise this is the exact local branch name.
    branch = run(["git", "branch", "--show-current"], cwd=install_dir).strip()
    return head, branch


def dev_checkout_user_changes(install_dir: Path) -> str:
    """Return user changes while ignoring only valid installer-owned metadata."""
    status = run(["git", "status", "--porcelain"], cwd=install_dir)
    remaining: list[str] = []
    for line in status.splitlines():
        if line == "?? .yulu-install.json":
            metadata = read_install_metadata(install_dir)
            if metadata.get("source") == "dev":
                continue
        remaining.append(line)
    return "\n".join(remaining)


def restore_clean_dev_checkout(install_dir: Path, *, head: str, branch: str) -> None:
    """Restore a previously clean installer checkout to its exact ref and SHA."""
    errors: list[str] = []
    checkout_ok = False
    try:
        root = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=install_dir)).resolve(strict=False)
        if root != install_dir.resolve(strict=False):
            raise InstallError(f"checkout root changed to {root}")
        if branch:
            run(["git", "checkout", "--quiet", "--force", branch], cwd=install_dir)
        else:
            run(["git", "checkout", "--quiet", "--force", "--detach", head], cwd=install_dir)
        checkout_ok = True
    except Exception as exc:
        errors.append(f"checkout restore failed ({exc})")

    if checkout_ok:
        try:
            # Safe only because capture_clean_dev_checkout verified this installer
            # checkout had no tracked/untracked user changes before the transaction.
            run(["git", "reset", "--hard", head], cwd=install_dir)
        except Exception as exc:
            errors.append(f"HEAD reset failed ({exc})")

    if checkout_ok and not errors:
        try:
            restored_head = run(["git", "rev-parse", "HEAD"], cwd=install_dir).strip()
            restored_branch = run(["git", "branch", "--show-current"], cwd=install_dir).strip()
            status = dev_checkout_user_changes(install_dir)
            if restored_head.lower() != head.lower():
                raise InstallError(f"HEAD is {restored_head}, expected {head}")
            if restored_branch != branch:
                expected_ref = branch or "detached HEAD"
                actual_ref = restored_branch or "detached HEAD"
                raise InstallError(f"ref is {actual_ref}, expected {expected_ref}")
            if status:
                raise InstallError(f"worktree is not clean after rollback: {status}")
        except Exception as exc:
            errors.append(f"checkout verification failed ({exc})")

    if errors:
        raise InstallError("; ".join(errors))


def install_dev_channel(
    install_dir: Path,
    run_setup_flag: bool = True,
    config_path: Path | None = None,
) -> None:
    existed = path_exists_or_symlink(install_dir)
    if existed:
        assert_recording_idle(install_dir / "yulu" / "scripts")
    in_place_checkout = existed and (install_dir / ".git").exists()
    backup = None
    original_head = ""
    original_branch = ""
    if in_place_checkout:
        status = dev_checkout_user_changes(install_dir)
        if status:
            raise InstallError(f"Dev checkout has local changes in {install_dir}; commit or stash them before updating.")
        original_head, original_branch = capture_clean_dev_checkout(install_dir)

    config_snapshot = create_config_snapshot(config_path or default_config_path())
    try:
        if in_place_checkout:
            run(["git", "fetch", "--quiet", "origin"], cwd=install_dir)
            run(["git", "checkout", "--quiet", "main"], cwd=install_dir)
            run(["git", "pull", "--ff-only", "origin", "main"], cwd=install_dir)
            commit = run(["git", "rev-parse", "HEAD"], cwd=install_dir)
            origin_commit = run(["git", "rev-parse", "origin/main"], cwd=install_dir)
            if commit != origin_commit:
                raise InstallError(
                    f"Dev checkout local main differs from origin/main in {install_dir}. "
                    "Resolve local commits or reinstall with --dev."
                )
        else:
            backup = move_existing_runtime_to_backup(install_dir)
            install_dir.parent.mkdir(parents=True, exist_ok=True)
            run(["git", "clone", "--branch", "main", REPO_URL, str(install_dir)])
        commit = run(["git", "rev-parse", "--short", "HEAD"], cwd=install_dir)
        if run_setup_flag:
            if existed:
                assert_recording_idle(install_dir / "yulu" / "scripts")
            run_setup(install_dir, upgrade=existed)
        write_install_metadata(install_dir, build_dev_metadata(branch="main", commit=commit))
        discard_config_snapshot(config_snapshot)
    except Exception as install_error:
        rollback_errors: list[str] = []
        runtime_restored = False
        checkout_restored = False
        config_restored = False
        if in_place_checkout:
            try:
                restore_clean_dev_checkout(
                    install_dir,
                    head=original_head,
                    branch=original_branch,
                )
                checkout_restored = True
            except Exception as exc:
                rollback_errors.append(f"checkout restore failed ({exc})")
        else:
            if backup is not None:
                try:
                    restore_backup(backup, install_dir)
                    runtime_restored = True
                except Exception as exc:
                    rollback_errors.append(f"runtime restore failed ({exc})")
            elif not existed:
                try:
                    cleanup_fresh_install_side_effects(install_dir)
                except Exception as exc:
                    rollback_errors.append(f"fresh-install cleanup failed ({exc})")
                try:
                    remove_runtime(install_dir)
                except Exception as exc:
                    rollback_errors.append(f"new checkout removal failed ({exc})")

        try:
            restore_config_snapshot(config_snapshot)
            config_restored = True
        except Exception as exc:
            rollback_errors.append(f"config restore failed ({exc})")

        should_repair = (backup is not None and runtime_restored) or (
            in_place_checkout and checkout_restored
        )
        if should_repair and config_restored and not isinstance(
            install_error, RecordingActiveInstallError
        ):
            try:
                repair_restored_runtime(install_dir)
            except Exception as exc:
                rollback_errors.append(f"restored service repair failed ({exc})")

        # setup --upgrade can rebuild tracked native artifacts in a dev checkout.
        # Re-assert the captured clean tree after repair without touching ignored
        # dependency/build caches.
        if in_place_checkout and checkout_restored:
            try:
                restore_clean_dev_checkout(
                    install_dir,
                    head=original_head,
                    branch=original_branch,
                )
            except Exception as exc:
                rollback_errors.append(f"post-repair checkout restore failed ({exc})")

        if rollback_errors:
            raise InstallError(
                f"Dev install failed ({install_error}); rollback or service repair failed: "
                + "; ".join(rollback_errors)
            ) from install_error
        raise
    if backup is not None:
        try:
            prune_runtime_backups(install_dir, keep=backup)
        except Exception as exc:
            print(f"warning: could not prune older runtime backups: {exc}", file=sys.stderr)


def install_release_from_urls(
    *,
    tag: str,
    asset_name: str,
    asset_url: str,
    checksums_url: str,
    install_dir: Path,
    run_setup: bool = True,
    setup_timeout: float = SETUP_TIMEOUT_SECONDS,
    config_path: Path | None = None,
) -> None:
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    existed = path_exists_or_symlink(install_dir)
    with tempfile.TemporaryDirectory(prefix="yulu-install-", dir=str(install_dir.parent)) as tmp:
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
        verify_release_bundle_security(staged_runtime)
        verify_runtime_manifest(staged_runtime)
        if existed:
            installed_scripts = install_dir / "yulu" / "scripts"
            guard_scripts = (
                installed_scripts
                if (installed_scripts / "migrate" / "guard.py").is_file()
                else staged_runtime / "yulu" / "scripts"
            )
            assert_recording_idle(guard_scripts)
        config_snapshot = create_config_snapshot(config_path or default_config_path())
        try:
            backup = replace_runtime_with_backup(staged_runtime, install_dir)
        except Exception as replace_error:
            try:
                discard_config_snapshot(config_snapshot)
            except Exception as snapshot_error:
                raise InstallError(
                    f"Failed to replace runtime ({replace_error}); "
                    f"config snapshot cleanup failed ({snapshot_error})"
                ) from replace_error
            raise
        try:
            write_install_metadata(
                install_dir,
                InstallMetadata(source="release", version=tag, asset=asset_name, sha256=expected),
            )
            if run_setup:
                if existed:
                    assert_recording_idle(install_dir / "yulu" / "scripts")
                _run_setup_script(install_dir, upgrade=existed, timeout=setup_timeout)
            discard_config_snapshot(config_snapshot)
        except Exception as install_error:
            rollback_errors: list[str] = []
            runtime_restored = False
            if backup is not None:
                try:
                    restore_backup(backup, install_dir)
                    runtime_restored = True
                except Exception as exc:
                    rollback_errors.append(f"runtime restore failed ({exc})")
            else:
                try:
                    cleanup_fresh_install_side_effects(install_dir)
                except Exception as exc:
                    rollback_errors.append(f"fresh-install cleanup failed ({exc})")
                try:
                    if path_exists_or_symlink(install_dir):
                        remove_runtime(install_dir)
                except Exception as exc:
                    rollback_errors.append(f"new runtime removal failed ({exc})")

            try:
                restore_config_snapshot(config_snapshot)
            except Exception as exc:
                rollback_errors.append(f"config restore failed ({exc})")

            if (
                backup is not None
                and runtime_restored
                and not isinstance(install_error, RecordingActiveInstallError)
            ):
                try:
                    repair_restored_runtime(install_dir, timeout=setup_timeout)
                except Exception as exc:
                    rollback_errors.append(f"restored service repair failed ({exc})")

            if rollback_errors:
                raise InstallError(
                    f"Install failed ({install_error}); rollback or service repair failed: "
                    + "; ".join(rollback_errors)
                ) from install_error
            raise
        if backup is not None:
            try:
                prune_runtime_backups(install_dir, keep=backup)
            except Exception as exc:
                print(f"warning: could not prune older runtime backups: {exc}", file=sys.stderr)


def install_release_target(target: ReleaseTarget, install_dir: Path, run_setup_flag: bool = True) -> None:
    ensure_release_architecture()
    payload = fetch_json(github_release_api_url(target))
    asset = resolve_release_from_payload(payload)
    if not asset.checksums_url:
        raise InstallError(f"Release {asset.tag} asset {asset.asset_name} is missing checksums.txt")
    install_release_from_urls(
        tag=asset.tag,
        asset_name=asset.asset_name,
        asset_url=asset.asset_url,
        checksums_url=asset.checksums_url,
        install_dir=install_dir,
        run_setup=run_setup_flag,
    )


def build_install_plan(command: str, target: ReleaseTarget, install_dir: Path, run_setup_flag: bool) -> dict:
    actions: list[dict[str, object]] = [
        {"name": "acquire_install_lock"},
        {"name": "assert_recording_idle", "when": "updating an existing runtime"},
    ]
    if target.kind == "dev":
        actions.extend(
            [
                {"name": "sync_dev_checkout", "source": REPO_URL, "branch": "main"},
                {"name": "run_setup", "enabled": run_setup_flag, "mode": "dev"},
                {"name": "write_install_metadata", "source": "dev"},
            ]
        )
    else:
        actions.extend(
            [
                {"name": "resolve_github_release", "target": target_to_dict(target)},
                {"name": "download_release_zip"},
                {"name": "verify_sha256_checksums"},
                {"name": "validate_runtime_layout"},
                {"name": "verify_release_bundle_signatures"},
                {"name": "verify_signed_runtime_manifest"},
                {"name": "replace_runtime_with_backup"},
                {"name": "run_setup", "enabled": run_setup_flag, "mode": "release"},
            ]
        )
    return {
        "schema": 1,
        "command": command,
        "target": target_to_dict(target),
        "install_dir": str(install_dir.expanduser()),
        "run_setup": run_setup_flag,
        "dry_run": True,
        "actions": actions,
    }


def print_plan(plan: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return
    print("Yulu install plan")
    print(f"  command:     {plan['command']}")
    target = plan["target"]
    print(f"  target:      {target['kind']}{' ' + target['tag'] if target.get('tag') else ''}")
    print(f"  install_dir: {plan['install_dir']}")
    print(f"  run_setup:   {str(plan['run_setup']).lower()}")
    for action in plan["actions"]:
        print(f"  - {action['name']}")


def print_json_result(ok: bool, payload: dict, error: str | None = None) -> None:
    result = {"schema": 1, "ok": ok, **payload}
    if error:
        result["error"] = error
    print(json.dumps(result, indent=2, ensure_ascii=False))


def build_main_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Install or update Yulu from release assets")
    parser.add_argument("command", choices=["install", "update"])
    parser.add_argument("--install-dir", default=os.path.expanduser("~/.yulu"))
    parser.add_argument("--no-setup", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help="print machine-readable result JSON")
    parser.add_argument("--plan", action="store_true", help="print the install/update plan and exit without changing files")
    parser.add_argument("--dry-run", action="store_true", help="alias for --plan")
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
    if args.version is not None:
        target_argv.extend(["--version", args.version])
    if args.dev:
        target_argv.append("--dev")
    try:
        target = parse_target_args(target_argv)
        install_dir = Path(args.install_dir).expanduser()
        if args.plan or args.dry_run:
            print_plan(build_install_plan(args.command, target, install_dir, not args.no_setup), args.json)
            return 0
        install_dir = install_dir.resolve(strict=False)
        with acquire_install_lock(install_dir):
            installed_guard = install_dir / "yulu" / "scripts" / "migrate" / "guard.py"
            if installed_guard.is_file():
                assert_recording_idle(install_dir / "yulu" / "scripts")
            elif path_exists_or_symlink(install_dir) and target.kind == "dev":
                raise InstallError(
                    f"Yulu recording safety guard is missing at {installed_guard}; "
                    "the existing dev runtime cannot be updated safely."
                )
            if target.kind == "dev":
                install_dev_channel(install_dir, run_setup_flag=not args.no_setup)
            else:
                install_release_target(target, install_dir, run_setup_flag=not args.no_setup)
    except (InstallError, ValueError) as exc:
        if args.json:
            print_json_result(
                False,
                {
                    "command": args.command,
                    "install_dir": str(Path(args.install_dir).expanduser()),
                },
                str(exc),
            )
            return 1
        print(f"Yulu install failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print_json_result(
            True,
            {
                "command": args.command,
                "target": target_to_dict(target),
                "install_dir": str(install_dir.expanduser()),
                "run_setup": not args.no_setup,
            },
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
