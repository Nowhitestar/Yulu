#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

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
VERSION_CHECK_TIMEOUT_SECONDS = 10
SETUP_TIMEOUT_SECONDS = 300
RUN_TIMEOUT_SECONDS = 300
REPO_URL = "https://github.com/Nowhitestar/Yulu.git"
REPO = "Nowhitestar/Yulu"
GITHUB_API = "https://api.github.com"


class InstallError(RuntimeError):
    pass


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
    expected_pkg = f"yulu-macos-arm64-{tag}.pkg"
    assets = release.get("assets") or []
    by_name = {str(asset.get("name")): asset for asset in assets}
    pkg_asset = by_name.get(expected_pkg)
    if pkg_asset is None:
        raise InstallError(f"Release {tag} does not provide {expected_pkg}. It may predate pkg-based installs.")
    pkg_url = str(pkg_asset.get("browser_download_url") or "").strip()
    if not pkg_url:
        raise InstallError(f"Release {tag} asset {expected_pkg} did not include a download URL.")
    return ReleaseAsset(
        tag=tag,
        asset_name=expected_pkg,
        asset_url=pkg_url,
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
    ]
    for path in required:
        if not path.is_file():
            raise InstallError(f"Invalid release asset: missing {path.relative_to(runtime_dir)}")

    version = (runtime_dir / "VERSION").read_text(encoding="utf-8").strip()
    if version != _tag_without_v(tag):
        raise InstallError(f"VERSION {version!r} does not match release tag {tag!r}")

    try:
        result = subprocess.run(
            ["python3", str(runtime_dir / "yulu" / "scripts" / "version.py"), "--check"],
            cwd=str(runtime_dir),
            capture_output=True,
            text=True,
            timeout=VERSION_CHECK_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise InstallError(f"version.py --check timed out after {VERSION_CHECK_TIMEOUT_SECONDS}s") from exc
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


def replace_runtime_with_backup(staged_runtime: Path, install_dir: Path) -> Path | None:
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path_exists_or_symlink(install_dir):
        # Keep successful-install backups for manual recovery until a later cleanup policy exists.
        backup = Path(
            tempfile.mkdtemp(prefix=f"{install_dir.name}.backup-", dir=str(install_dir.parent))
        )
        backup.rmdir()
        shutil.move(str(install_dir), str(backup))
    try:
        shutil.move(str(staged_runtime), str(install_dir))
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


def restore_backup(backup: Path, install_dir: Path) -> None:
    if path_exists_or_symlink(install_dir):
        if install_dir.is_dir() and not install_dir.is_symlink():
            shutil.rmtree(install_dir)
        else:
            install_dir.unlink()
    shutil.move(str(backup), str(install_dir))


def _run_setup_script(install_dir: Path, upgrade: bool, timeout: float = SETUP_TIMEOUT_SECONDS) -> None:
    setup = install_dir / "yulu" / "scripts" / "setup.sh"
    cmd = ["bash", str(setup)]
    if upgrade:
        cmd.append("--upgrade")
    try:
        result = subprocess.run(cmd, cwd=str(install_dir), timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise InstallError(f"setup.sh timed out after {timeout}s") from exc
    if result.returncode != 0:
        raise InstallError(f"setup.sh failed with exit code {result.returncode}")


run_setup = _run_setup_script


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


def install_dev_channel(install_dir: Path, run_setup_flag: bool = True) -> None:
    existed = path_exists_or_symlink(install_dir)
    backup = None
    if existed and (install_dir / ".git").exists():
        status = run(["git", "status", "--porcelain"], cwd=install_dir)
        if status:
            raise InstallError(f"Dev checkout has local changes in {install_dir}; commit or stash them before updating.")
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
        try:
            backup = move_existing_runtime_to_backup(install_dir)
            install_dir.parent.mkdir(parents=True, exist_ok=True)
            run(["git", "clone", "--branch", "main", REPO_URL, str(install_dir)])
        except Exception as install_error:
            try:
                remove_runtime(install_dir)
                if backup is not None:
                    restore_backup(backup, install_dir)
            except Exception as rollback_error:
                raise InstallError(
                    f"Dev install failed ({install_error}); rollback failed ({rollback_error})"
                ) from install_error
            raise
    try:
        commit = run(["git", "rev-parse", "--short", "HEAD"], cwd=install_dir)
        if run_setup_flag:
            run_setup(install_dir, upgrade=existed)
        write_install_metadata(install_dir, build_dev_metadata(branch="main", commit=commit))
    except Exception as install_error:
        if backup is None:
            raise
        try:
            remove_runtime(install_dir)
            restore_backup(backup, install_dir)
        except Exception as rollback_error:
            raise InstallError(
                f"Dev install failed ({install_error}); rollback failed ({rollback_error})"
            ) from install_error
        raise


def install_release_from_urls(
    *,
    tag: str,
    asset_name: str,
    asset_url: str,
    checksums_url: str,
    install_dir: Path,
    run_setup: bool = True,
    setup_timeout: float = SETUP_TIMEOUT_SECONDS,
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
        backup = replace_runtime_with_backup(staged_runtime, install_dir)
        try:
            write_install_metadata(
                install_dir,
                InstallMetadata(source="release", version=tag, asset=asset_name, sha256=expected),
            )
            if run_setup:
                _run_setup_script(install_dir, upgrade=existed, timeout=setup_timeout)
        except Exception as install_error:
            try:
                if backup is not None:
                    restore_backup(backup, install_dir)
                elif path_exists_or_symlink(install_dir):
                    if install_dir.is_dir() and not install_dir.is_symlink():
                        shutil.rmtree(install_dir)
                    else:
                        install_dir.unlink()
            except Exception as rollback_error:
                raise InstallError(
                    f"Install failed ({install_error}); rollback failed ({rollback_error})"
                ) from install_error
            raise


def install_release_pkg_from_url(
    *,
    tag: str,
    asset_name: str,
    asset_url: str,
    install_dir: Path,
    run_setup: bool = True,
) -> None:
    if not sys.platform == "darwin":
        raise InstallError("The pkg installer is macOS-only. Use --dev on non-macOS systems.")
    install_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="yulu-pkg-install-", dir=str(install_dir.parent)) as tmp:
        pkg_path = Path(tmp) / asset_name
        download_to_path(asset_url, pkg_path)
        run(["installer", "-pkg", str(pkg_path), "-target", "/"])

    if run_setup and not install_dir.exists():
        raise InstallError(f"pkg install completed but {install_dir} does not exist")
    if run_setup and install_dir.exists():
        validate_runtime_layout(install_dir, tag)


def install_release_target(target: ReleaseTarget, install_dir: Path, run_setup_flag: bool = True) -> None:
    payload = fetch_json(github_release_api_url(target))
    asset = resolve_release_from_payload(payload)
    if asset.asset_name.endswith(".pkg"):
        install_release_pkg_from_url(
            tag=asset.tag,
            asset_name=asset.asset_name,
            asset_url=asset.asset_url,
            install_dir=install_dir,
            run_setup=run_setup_flag,
        )
    else:
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
    actions: list[dict[str, object]] = []
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
                {"name": "download_pkg_asset"},
                {"name": "run_macos_installer", "target": "/"},
                {"name": "validate_runtime_layout", "enabled": run_setup_flag},
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
        install_dir = Path(args.install_dir)
        if args.plan or args.dry_run:
            print_plan(build_install_plan(args.command, target, install_dir, not args.no_setup), args.json)
            return 0
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
