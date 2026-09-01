import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "packaging" / "scripts" / "release_identity.py"


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)


def git(repository: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], repository)


def make_release_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "release-repository"
    repository.mkdir()
    (repository / "VERSION").write_text("0.23.0-rc.6\n", encoding="utf-8")
    assert git(repository, "init", "-q").returncode == 0
    assert git(repository, "config", "user.email", "release-test@example.invalid").returncode == 0
    assert git(repository, "config", "user.name", "Release Test").returncode == 0
    assert git(repository, "add", "VERSION").returncode == 0
    assert git(repository, "commit", "-qm", "chore: release 0.23.0-rc.6").returncode == 0
    assert git(repository, "tag", "v0.23.0-rc.6").returncode == 0
    assert git(repository, "tag", "v0.23.0").returncode == 0
    return repository


def resolve(repository: Path, tag: str) -> subprocess.CompletedProcess[str]:
    return run(
        [
            "python3",
            str(IDENTITY),
            "--tag",
            tag,
            "--version-file",
            str(repository / "VERSION"),
            "--repository",
            str(repository),
        ],
        repository,
    )


def test_release_identity_accepts_rc6_and_reserves_the_next_build_for_stable(tmp_path: Path):
    repository = make_release_repository(tmp_path)

    rc = resolve(repository, "v0.23.0-rc.6")
    stable = resolve(repository, "v0.23.0")

    assert rc.returncode == 0, rc.stderr
    assert stable.returncode == 0, stable.stderr
    assert json.loads(rc.stdout) == {
        "buildNumber": "2",
        "bundleShortVersion": "0.23.0",
        "releaseVersion": "0.23.0-rc.6",
        "stablePromotion": False,
    }
    assert json.loads(stable.stdout) == {
        "buildNumber": "3",
        "bundleShortVersion": "0.23.0",
        "releaseVersion": "0.23.0",
        "stablePromotion": True,
    }


def test_stable_promotion_rejects_a_different_source_commit(tmp_path: Path):
    repository = make_release_repository(tmp_path)
    (repository / "after-rc.txt").write_text("not accepted\n", encoding="utf-8")
    assert git(repository, "add", "after-rc.txt").returncode == 0
    assert git(repository, "commit", "-qm", "fix: intervening source change").returncode == 0
    assert git(repository, "tag", "-f", "v0.23.0").returncode == 0

    result = resolve(repository, "v0.23.0")

    assert result.returncode != 0
    assert "same source commit" in result.stderr


def test_release_identity_rejects_missing_and_mismatched_requested_tags(tmp_path: Path):
    repository = make_release_repository(tmp_path)
    assert git(repository, "tag", "-d", "v0.23.0-rc.6").returncode == 0

    missing = resolve(repository, "v0.23.0-rc.6")

    assert missing.returncode != 0
    assert "unknown revision" in missing.stderr.lower() or "needed a single revision" in missing.stderr.lower()

    assert git(repository, "tag", "v0.23.0-rc.6").returncode == 0
    (repository / "after-tag.txt").write_text("new source\n", encoding="utf-8")
    assert git(repository, "add", "after-tag.txt").returncode == 0
    assert git(repository, "commit", "-qm", "fix: change after tag").returncode == 0

    mismatched = resolve(repository, "v0.23.0-rc.6")

    assert mismatched.returncode != 0
    assert "current release commit" in mismatched.stderr


def test_build_numbers_remain_ordered_after_same_source_stable(tmp_path: Path):
    repository = make_release_repository(tmp_path)
    stable = resolve(repository, "v0.23.0")
    (repository / "VERSION").write_text("0.23.1\n", encoding="utf-8")
    assert git(repository, "add", "VERSION").returncode == 0
    assert git(repository, "commit", "-qm", "chore: release 0.23.1").returncode == 0
    assert git(repository, "tag", "v0.23.1").returncode == 0

    successor = resolve(repository, "v0.23.1")

    assert stable.returncode == 0, stable.stderr
    assert successor.returncode == 0, successor.stderr
    assert int(json.loads(successor.stdout)["buildNumber"]) > int(
        json.loads(stable.stdout)["buildNumber"]
    )


def test_release_identity_rejects_numeric_prerelease_leading_zero(tmp_path: Path):
    repository = make_release_repository(tmp_path)
    (repository / "VERSION").write_text("0.23.0-01\n", encoding="utf-8")

    result = resolve(repository, "v0.23.0-01")

    assert result.returncode != 0
    assert "Invalid release tag" in result.stderr


def test_stable_promotion_is_limited_to_the_accepted_release_line(tmp_path: Path):
    repository = make_release_repository(tmp_path)
    (repository / "VERSION").write_text("0.24.0-rc.4\n", encoding="utf-8")
    assert git(repository, "add", "VERSION").returncode == 0
    assert git(repository, "commit", "-qm", "chore: unrelated release candidate").returncode == 0
    assert git(repository, "tag", "v0.24.0-rc.4").returncode == 0

    result = resolve(repository, "v0.24.0")

    assert result.returncode != 0
    assert "must match VERSION" in result.stderr


def test_release_please_targets_rc6_instead_of_a_new_minor_line():
    config = json.loads((ROOT / "release-please-config.json").read_text(encoding="utf-8"))
    package = config["packages"]["."]

    assert package["versioning"] == "prerelease"
    assert package["prerelease"] is True
    assert package["prerelease-type"] == "rc"


def test_release_workflow_and_packager_share_the_validated_release_identity():
    workflow = (ROOT / ".github" / "workflows" / "release-publish.yml").read_text(
        encoding="utf-8"
    )
    package = (ROOT / "packaging" / "scripts" / "package.sh").read_text(encoding="utf-8")

    assert "id: release-identity" in workflow
    assert "packaging/scripts/release_identity.py" in workflow
    assert "steps.release-identity.outputs.release_version" in workflow
    assert "steps.release-identity.outputs.bundle_short_version" in workflow
    assert "steps.release-identity.outputs.build_number" in workflow
    assert "packaging/scripts/release_identity.py" in package
    assert 'gh release view "$TAG" --json body > "$REMOTE_RELEASE_JSON"' in workflow
    assert 'remote = json.loads(pathlib.Path(sys.argv[1]).read_text())["body"]' in workflow
    assert "if remote != local:" in workflow


def test_public_guidance_matches_current_install_provider_and_share_boundaries():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    readme_zh = (ROOT / "README.zh-CN.md").read_text(encoding="utf-8")
    skill = (ROOT / "skills" / "yulu" / "SKILL.md").read_text(encoding="utf-8")
    issue_template = (ROOT / ".github" / "ISSUE_TEMPLATE" / "bug_report.yml").read_text(
        encoding="utf-8"
    )
    release_notes = (
        (ROOT / "docs" / "release-notes" / "v0.23.0-rc.6.md").read_text(encoding="utf-8")
        + (ROOT / "docs" / "release-notes" / "v0.23.0.md").read_text(encoding="utf-8")
    )

    for guidance in (readme, readme_zh, skill, issue_template, release_notes):
        assert "CLIProxyAPI" not in guidance
    assert "Grok CLI-compatible OAuth" in readme
    assert "兼容 Grok CLI 的 OAuth" in readme_zh
    assert "releases/latest" not in readme
    assert "releases/latest" not in readme_zh
    assert "public release candidate" in readme
    assert "公开候选版" in readme_zh
    assert "xAI、Codex 或 Claude Code" in skill
    assert "Hermes 负责会议纪要" not in skill
    assert "Hermes 租约任务规则" not in skill
    assert "手动 Share Action" in skill
    assert "Official GitHub Release DMG" in issue_template
    assert "one-line installer" not in issue_template
    assert "compatible Hermes Agent" not in issue_template
    for guidance in (readme, readme_zh, skill):
        assert "~/Library/Application Support/Yulu" in guidance
        assert "~/Library/Caches/Yulu" in guidance
        assert "~/Library/Logs/Yulu" in guidance
    assert "`~/.yulu/` | 已安装 Yulu runtime" not in skill
    claude_guide = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    assert "Agent-backed summaries currently use Hermes" not in claude_guide
    assert "auto_send_notion=true` is real side-effect authorization" not in claude_guide
    assert "fresh confirmed Share Action" in claude_guide
    architecture = (ROOT / "docs/ARCHITECTURE.md").read_text(encoding="utf-8")
    assert "artifacts_committed --> sending" not in architecture
    assert 'state "sending (legacy only)"' in architecture
    config_example = (ROOT / "yulu/scripts/config.example.json").read_text(
        encoding="utf-8"
    )
    assert "automatic summaries currently use Hermes" not in config_example
    assert '"destinations": {}' in config_example
    current_path_guidance = {
        "CONTRIBUTING.md": "~/Library/Logs/Yulu",
        "CLAUDE.md": "~/Library/Application Support/Yulu",
        "docs/DEVELOPMENT.md": "~/Library/Application Support/Yulu",
        "docs/yulu_ui.md": "~/Library/Logs/Yulu",
        "tests/test_search_ipc_smoke.md": "~/Library/Application Support/Yulu",
    }
    for path, expected in current_path_guidance.items():
        assert expected in (ROOT / path).read_text(encoding="utf-8")
    assert "~/.config/yulu/*.log" not in (ROOT / "CONTRIBUTING.md").read_text()
    assert "Hermes separately owns authorized connector delivery" not in (
        ROOT / "CONTRIBUTING.md"
    ).read_text()
    assert "Config/state: `~/.config/yulu`" not in (ROOT / "docs/DEVELOPMENT.md").read_text()
    assert "~/.config/yulu/ui.log" not in (ROOT / "docs/yulu_ui.md").read_text()
    assert "~/.config/yulu/search.sqlite" not in (ROOT / "tests/test_search_ipc_smoke.md").read_text()
    for capability in (
        "transcription",
        "summary",
        "conversation",
        "Calendar",
        "manual Sharing",
    ):
        assert capability in release_notes


def test_social_card_describes_the_current_product_surface():
    card = (ROOT / "assets" / "social-card.svg").read_text(encoding="utf-8")

    assert "transcription · summaries · conversation · Calendar · manual sharing" in card
    assert "whisper.cpp · BYOA" not in card


def test_release_checklist_requires_public_surface_read_back():
    release = (ROOT / "docs" / "RELEASE.md").read_text(encoding="utf-8")

    for surface in (
        "GitHub About",
        "social preview",
        "README",
        "issue template",
        "landing page",
        "GitHub Release body",
        "Release Please PR",
    ):
        assert surface in release


def test_full_ci_budget_covers_python_and_swift_gates():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    build_job = workflow.split("  yulu_ui:\n", 1)[0]

    assert "timeout-minutes: 20" in build_job
