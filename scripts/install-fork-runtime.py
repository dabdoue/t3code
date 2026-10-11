#!/usr/bin/env python3
"""Stage a verified Linux fork archive; activate through T3's own service installer."""
import argparse
from contextlib import closing
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone


def readonly_database(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def active_work(base):
    database = base / "userdata/statev2.sqlite"
    if not database.exists():
        database = base / "userdata/state.sqlite"
    if not database.exists():
        raise RuntimeError("Cannot verify active work: no existing T3 database.")
    with closing(readonly_database(database)) as db:
        tables = {
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "orchestration_v2_projection_runs" in tables:
            return db.execute(
                "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','queued','starting','running','waiting')"
            ).fetchone()[0]
        if "projection_thread_sessions" in tables:
            return db.execute(
                "SELECT count(*) FROM projection_thread_sessions WHERE status IN ('running','connecting') OR active_turn_id IS NOT NULL"
            ).fetchone()[0]
        raise RuntimeError("Cannot verify active work: unknown T3 schema.")


def stage(archive, expected_sha, version, base):
    if not version or any(
        c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-"
        for c in version
    ):
        raise ValueError("Invalid runtime version.")
    with archive.open("rb") as source:
        sha = hashlib.file_digest(source, "sha256").hexdigest()
    if sha != expected_sha:
        raise ValueError("Archive checksum mismatch.")
    versions = base / "runtime/versions"
    versions.mkdir(parents=True, exist_ok=True)
    target = versions / version
    if target.exists():
        if (target / ".fork-archive-sha256").read_text().strip() != sha:
            raise RuntimeError(
                "This runtime version already contains a different build."
            )
        return target
    temporary = Path(tempfile.mkdtemp(prefix=".fork-stage-", dir=versions))
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            members = bundle.getmembers()
            roots = {Path(member.name).parts[0] for member in members}
            if len(roots) != 1:
                raise ValueError("Expected a single archive root.")
            # The data filter rejects paths and links escaping the staging directory.
            bundle.extractall(temporary, filter="data")
            content = temporary / roots.pop()
        binary = content / "t3"
        result = subprocess.run(
            [str(binary), "--version"], check=True, capture_output=True, text=True
        )
        if result.stdout.strip().split()[-1] != "v" + version:
            raise ValueError("Runtime version does not match the requested build.")
        (content / ".install-complete").write_text(version + "\n")
        (content / ".fork-archive-sha256").write_text(sha + "\n")
        content.rename(target)
    finally:
        shutil.rmtree(temporary)
    return target


def activate(target, base):
    busy = active_work(base)
    if busy:
        raise RuntimeError(
            f"Update staged; activation refused because {busy} T3 runs are active or queued."
        )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = base / "runtime/fork-backups" / stamp
    backup.mkdir(parents=True, mode=0o700)
    for name in ["state.sqlite", "statev2.sqlite"]:
        database = base / "userdata" / name
        if database.exists():
            with closing(readonly_database(database)) as source, closing(
                sqlite3.connect(backup / name)
            ) as destination:
                source.backup(destination)
    for path in [
        base / "runtime/service-state.json",
        base / "userdata/settings.json",
        Path.home() / ".config/systemd/user/t3code.service",
    ]:
        if path.exists():
            shutil.copy2(path, backup / path.name)
    print(f"Consistent database and service backup: {backup}", flush=True)
    # Recheck after snapshotting. Mainline owns the launcher/unit reconciliation.
    if active_work(base):
        raise RuntimeError(
            "New work started while preparing the backup; activation refused."
        )
    subprocess.run(
        [str(target / "t3"), "service", "install", "--base-dir", str(base)], check=True
    )
    print(f"Activated {target.name}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--base-dir", type=Path, default=Path.home() / ".t3")
    parser.add_argument(
        "--activate",
        action="store_true",
        help="Back up idle state and install/restart the user service.",
    )
    args = parser.parse_args()
    os.umask(0o077)
    target = stage(
        args.archive.resolve(), args.sha256, args.version, args.base_dir.resolve()
    )
    print(f"Verified and staged {target}", flush=True)
    if args.activate:
        activate(target, args.base_dir.resolve())


if __name__ == "__main__":
    main()
