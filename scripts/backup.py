"""Backup, restore, and the drill that proves the restore is usable.

A backup nobody has restored is a hope, not a backup. So this does three things,
and the third is the one that matters:

* **backup** — a consistent snapshot.
* **restore** — put it back somewhere.
* **drill** — back up, restore into a scratch database, and then *verify the
  audit hash chain still validates*. A restore that silently loses or reorders
  audit rows would leave the platform unable to prove anything to a regulator,
  and nothing except a chain check would notice.

    uv run python scripts/backup.py backup --out backups/
    uv run python scripts/backup.py restore --from backups/gravai-....db
    uv run python scripts/backup.py drill
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

from gravai_core.db import dispose_engine, get_sessionmaker
from gravai_core.models import AuditLog, Tenant
from gravai_core.repositories import AuditRepository
from gravai_core.settings import Settings, get_settings
from sqlalchemy import func, select


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _sqlite_path(url: str) -> Path:
    """The file behind a SQLite URL."""
    return Path(url.split("///", 1)[1]).resolve()


def backup_sqlite(settings: Settings, out_dir: Path) -> Path:
    """A consistent snapshot using SQLite's own backup API.

    Copying the file with the filesystem can capture a torn write if anything is
    mid-transaction; the backup API takes a coherent point-in-time copy of a
    live database.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    source_path = _sqlite_path(settings.database_url)
    target = out_dir / f"gravai-{_stamp()}.db"

    source = sqlite3.connect(source_path)
    destination = sqlite3.connect(target)
    try:
        with destination:
            source.backup(destination)
    finally:
        source.close()
        destination.close()
    return target


def backup_postgres(settings: Settings, out_dir: Path) -> Path:
    """A custom-format dump, which restores selectively and in parallel."""
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"gravai-{_stamp()}.dump"
    parsed = urlparse(settings.database_url.replace("+asyncpg", ""))

    command = [
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        f"--file={target}",
        settings.database_url.replace("+asyncpg", ""),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"pg_dump failed against {parsed.hostname}: {result.stderr.strip()[:400]}"
        )
    return target


def take_backup(settings: Settings, out_dir: Path) -> Path:
    if settings.is_sqlite:
        return backup_sqlite(settings, out_dir)
    return backup_postgres(settings, out_dir)


def restore(settings: Settings, archive: Path, *, target_url: str | None = None) -> str:
    """Restore an archive, by default into a scratch database.

    Restoring over the live database is never the default: a drill that can
    destroy production is a drill nobody runs.
    """
    if settings.is_sqlite:
        destination = (
            _sqlite_path(target_url) if target_url else archive.with_suffix(".restored.db")
        )
        shutil.copyfile(archive, destination)
        return f"sqlite+aiosqlite:///{destination.as_posix()}"

    url = target_url or settings.database_url.replace("+asyncpg", "") + "_restore"
    result = subprocess.run(
        ["pg_restore", "--clean", "--if-exists", "--no-owner", f"--dbname={url}", str(archive)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"pg_restore failed: {result.stderr.strip()[:400]}")
    return url


async def verify(database_url: str) -> tuple[bool, str]:
    """Check the restored database is usable and its audit chain still holds."""
    import gravai_core.db as db

    await dispose_engine()
    settings = Settings(database_url=database_url, sarvam_api_key="")
    db._engine = None
    db._sessionmaker = None

    factory = get_sessionmaker(settings)
    lines: list[str] = []
    ok = True

    async with factory() as session:
        tenants = (await session.execute(select(Tenant))).scalars().all()
        entries = (
            await session.execute(select(func.count(AuditLog.id)))
        ).scalar_one()
        lines.append(f"  tenants restored        {len(tenants)}")
        lines.append(f"  audit entries restored  {entries}")

        repo = AuditRepository(session)
        for tenant in tenants:
            result = await repo.verify(tenant_id=tenant.id)
            mark = "OK" if result.ok else "BROKEN"
            lines.append(
                f"  chain {tenant.slug:<16} {mark} ({result.checked} entries)"
                + (f" — {result.reason}" if not result.ok else "")
            )
            ok = ok and result.ok

    await dispose_engine()
    return ok, "\n".join(lines)


async def drill(out_dir: Path) -> int:
    """Back up, restore to a scratch copy, and verify the chain survived."""
    settings = get_settings()
    print()
    print("=" * 70)
    print("BACKUP / RESTORE DRILL")
    print("=" * 70)
    print(f"  source                  {settings.database_url}")

    archive = take_backup(settings, out_dir)
    size_kb = archive.stat().st_size / 1024
    print(f"  archive                 {archive.name} ({size_kb:,.0f} KB)")

    restored_url = restore(settings, archive)
    print(f"  restored to             {restored_url}")
    print()

    ok, report = await verify(restored_url)
    print(report)
    print()
    print(f"  RESULT                  {'PASS' if ok else 'FAIL'}")
    if not ok:
        print("  A restored audit chain that does not verify cannot be used as evidence.")
    print("=" * 70)
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="GravAI backup and restore")
    sub = parser.add_subparsers(dest="command", required=True)

    backup_cmd = sub.add_parser("backup", help="take a snapshot")
    backup_cmd.add_argument("--out", type=Path, default=Path("backups"))

    restore_cmd = sub.add_parser("restore", help="restore an archive")
    restore_cmd.add_argument("--from", dest="archive", type=Path, required=True)
    restore_cmd.add_argument("--to", dest="target", default=None)

    drill_cmd = sub.add_parser("drill", help="back up, restore and verify")
    drill_cmd.add_argument("--out", type=Path, default=Path("backups"))

    args = parser.parse_args()
    settings = get_settings()

    if args.command == "backup":
        archive = take_backup(settings, args.out)
        print(f"backup written: {archive} ({archive.stat().st_size / 1024:,.0f} KB)")
        return 0

    if args.command == "restore":
        url = restore(settings, args.archive, target_url=args.target)
        print(f"restored to: {url}")
        ok, report = asyncio.run(verify(url))
        print(report)
        return 0 if ok else 1

    return asyncio.run(drill(args.out))


if __name__ == "__main__":
    sys.exit(main())
