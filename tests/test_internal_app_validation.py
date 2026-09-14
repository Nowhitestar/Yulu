"""The signed development path must not become a second release publisher."""

import os
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
SIGNER = ROOT / "packaging/scripts/sign_and_notarize.sh"


@pytest.mark.parametrize("ci,version", [
    ("false", "0.23.0-dev.ci.123"),
    ("true", "0.23.0-rc.20"),
    ("true", "0.23.0"),
    ("true", "0.23.0-dev.ci.0"),
])
def test_validation_rejects_local_signing_or_public_identity(ci, version):
    result = subprocess.run(
        ["bash", str(SIGNER), "--validation"],
        env={**os.environ, "GITHUB_ACTIONS": ci, "YULU_RELEASE_VERSION": version},
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 64
    assert "requires CI and an explicit dev.ci build identity" in result.stderr
    assert "Importing Developer ID" not in result.stdout


def test_validation_handoff_precedes_and_exits_before_public_packaging():
    source = SIGNER.read_text()
    validation = source.split('notarize_app "$YULU_APP"', 1)[1].split(
        '# Package only the already immutable/stapled App.', 1,
    )[0]
    assert '[[ "$VALIDATION_ONLY" == "1" ]]' in validation
    assert 'ditto -c -k --keepParent "$YULU_APP"' in validation
    assert "validation-checksums.txt" in validation
    assert "exit 0" in validation
    assert "unset YULU_SPARKLE_FEED_URL YULU_SPARKLE_PUBLIC_ED_KEY YULU_SPARKLE_PRIVATE_ED_KEY" in source


def test_validation_workflow_is_explicit_read_only_and_never_publishes():
    workflow = (ROOT / ".github/workflows/application-validation.yml").read_text()
    assert 'tags: ["internal/phase13-*"]' in workflow
    assert "pull_request:" not in workflow
    assert "contents: read" in workflow
    assert "persist-credentials: false" in workflow
    assert "contents: write" not in workflow
    assert "id-token: write" not in workflow
    assert "gh release" not in workflow
    assert "sparkle-feed" not in workflow
    assert "YULU_SPARKLE_PRIVATE_ED_KEY" not in workflow
    assert "sign_and_notarize.sh --validation" in workflow
    assert '"sourceCommit": os.environ["GITHUB_SHA"]' in workflow
    assert '"publicRelease": False' in workflow
    assert "if: always()" in workflow
    assert "yulu-signing.keychain-db" in workflow
