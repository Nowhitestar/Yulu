"""Build missing Host databases in a private staging directory before publication.

The Host owns exclusive publication; the existing Python writers remain the
single source of truth for schemas and bundled defaults. Never open live data.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def initialize(directory: Path, kind: str) -> None:
    path = directory / f"{kind}.sqlite"
    if path.exists() or path.is_symlink():
        raise FileExistsError("database staging path is not empty")
    if kind == "prompts":
        from prompts.db import PromptsRepo, open_db
        from prompts.seed import seed_from_current

        conn = open_db(path)
        try:
            seed_from_current(PromptsRepo(conn))
            conn.commit()
        finally:
            conn.close()
    elif kind == "vocab":
        from vocab.db import VocabRepo, open_db
        from vocab.seed import seed_from_current

        conn = open_db(path)
        try:
            seed_from_current(VocabRepo(conn))
            conn.commit()
        finally:
            conn.close()
    else:
        from search.indexer import init_db

        conn = init_db(path)
        conn.close()
    os.chmod(path, 0o600)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("kinds", nargs="+", choices=("prompts", "vocab", "search"))
    args = parser.parse_args()
    for kind in args.kinds:
        initialize(args.directory, kind)


if __name__ == "__main__":
    main()
