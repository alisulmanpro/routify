"""Copies proof photos and report PDFs from local disk (STORAGE_DIR) to the S3/R2 bucket (P7.1).

Dry run by default: it lists what it would copy. Re-runnable: objects already in the bucket with the same size are
skipped, so an interrupted run can simply be started again. Local files are never deleted.

    python -m scripts.migrate_files_to_s3                                      # dry run
    python -m scripts.migrate_files_to_s3 --apply --confirm-bucket <S3_BUCKET>  # copy

Reads S3_* and STORAGE_DIR from the environment / .env (the bucket does not need STORAGE_BACKEND=s3 yet: run this
first, then switch). Keys stay the same, so stored links (proofPhotoKey, fileKey) keep working after the switch.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from app.config import env
from app.services import s3, storage_service


def local_keys() -> list[str]:
    base = storage_service.root()
    keys = []
    for kind in ("proofs", "reports"):
        folder = base / kind
        if folder.is_dir():
            keys += [f"{kind}/{p.name}" for p in sorted(folder.iterdir()) if p.is_file() and storage_service.KEY_RE.match(f"{kind}/{p.name}")]
    return keys


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="copy (without it: dry run)")
    parser.add_argument("--confirm-bucket", help="must equal S3_BUCKET when --apply is given")
    args = parser.parse_args()

    missing = [n for n in ("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY") if not getattr(env, n)]
    if missing:
        print(f"Set {', '.join(missing)} first.", file=sys.stderr)
        return 2
    if args.apply and args.confirm_bucket != env.S3_BUCKET:
        print(f"--apply needs --confirm-bucket {env.S3_BUCKET} (the bucket this run writes to).", file=sys.stderr)
        return 2

    keys = local_keys()
    print(f"{'Copying' if args.apply else 'Dry run:'} {len(keys)} local files from {storage_service.root()} to {env.S3_ENDPOINT}/{env.S3_BUCKET}")
    copied = skipped = failed = 0
    for key in keys:
        data = storage_service.resolve_key(key).read_bytes()
        try:
            size = await s3.head(key)
        except Exception as error:  # noqa: BLE001
            print(f"  ! {key}: cannot check the bucket ({error})")
            failed += 1
            continue
        if size == len(data):
            skipped += 1
            continue
        if not args.apply:
            print(f"  would copy {key} ({len(data)} bytes)")
            copied += 1
            continue
        try:
            await s3.put(key, data, storage_service.content_type_for(key))
            copied += 1
        except Exception as error:  # noqa: BLE001
            print(f"  ! {key}: {error}")
            failed += 1
    verb = "copied" if args.apply else "to copy"
    print(f"Done: {copied} {verb}, {skipped} already in the bucket, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
