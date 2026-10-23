"""Copies Prisma's query engine into backend-py/ after `prisma generate` (Render build step).

`prisma generate` downloads the engine to ~/.cache/prisma-python. Render keeps only the project folder for the running
service, so at start the engine is gone (BinaryNotFoundError). Prisma looks in the working directory first, so a copy
here is found without any environment variable.

Usage (from backend-py, after prisma generate):  python -m scripts.bundle_prisma_engine
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

from prisma.client import BINARY_PATHS
from prisma.engine.utils import _resolve_from_binary_paths, query_engine_name


def main() -> int:
    source = _resolve_from_binary_paths(BINARY_PATHS.query_engine)
    if source is None or not source.exists():
        print(f"No query engine to copy (expected {source}); run `prisma generate` first.", file=sys.stderr)
        return 1
    target = Path.cwd() / query_engine_name()
    shutil.copy2(source, target)
    target.chmod(0o755)
    print(f"Prisma query engine copied to {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
