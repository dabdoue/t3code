import importlib.util
from pathlib import Path
import hashlib
import io
import sqlite3
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "installer", Path(__file__).with_name("install-fork-runtime.py")
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.base = self.root / "home"
        self.archive = self.root / "runtime.tgz"
        with tarfile.open(self.archive, "w:gz") as tar:
            data = b'#!/bin/sh\nprintf "t3 v0.0.45-fork.1\\n"\n'
            info = tarfile.TarInfo("runtime/t3")
            info.size = len(data)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(data))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def tearDown(self):
        self.tmp.cleanup()

    def test_stage_keeps_service_state_untouched(self):
        target = installer.stage(self.archive, self.sha, "0.0.45-fork.1", self.base)
        self.assertEqual(
            (target / ".install-complete").read_text().strip(), "0.0.45-fork.1"
        )
        self.assertFalse((self.base / "runtime/service-state.json").exists())
        self.assertEqual(
            installer.stage(self.archive, self.sha, "0.0.45-fork.1", self.base), target
        )

    def test_checksum_failure_writes_nothing(self):
        with self.assertRaises(ValueError):
            installer.stage(self.archive, "bad", "0.0.45-fork.1", self.base)
        self.assertFalse(self.base.exists())

    def test_version_mismatch_not_published(self):
        with self.assertRaises(ValueError):
            installer.stage(self.archive, self.sha, "0.0.45-fork.2", self.base)
        self.assertFalse((self.base / "runtime/versions/0.0.45-fork.2").exists())

    def test_rejects_escape(self):
        with tarfile.open(self.archive, "w:gz") as tar:
            info = tarfile.TarInfo("runtime/../../escape")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with self.assertRaises((ValueError, tarfile.FilterError)):
            installer.stage(self.archive, sha, "0.0.45-fork.1", self.base)
        self.assertFalse((self.root / "escape").exists())

    def test_busy_v1_refuses_before_backup(self):
        (self.base / "userdata").mkdir(parents=True)
        with sqlite3.connect(self.base / "userdata/state.sqlite") as db:
            db.execute(
                "CREATE TABLE projection_thread_sessions(status TEXT,active_turn_id TEXT)"
            )
            db.execute(
                "INSERT INTO projection_thread_sessions VALUES ('running','turn')"
            )
        with self.assertRaisesRegex(RuntimeError, "activation refused"):
            installer.activate(self.root, self.base)
        self.assertFalse((self.base / "runtime/fork-backups").exists())

    def test_v2_uses_current_runs_not_legacy_sessions(self):
        (self.base / "userdata").mkdir(parents=True)
        with sqlite3.connect(self.base / "userdata/state.sqlite") as db:
            db.execute(
                "CREATE TABLE projection_thread_sessions(status TEXT,active_turn_id TEXT)"
            )
            db.execute(
                "INSERT INTO projection_thread_sessions VALUES ('running','legacy-turn')"
            )
        with sqlite3.connect(self.base / "userdata/statev2.sqlite") as db:
            db.execute("CREATE TABLE orchestration_v2_projection_runs(status TEXT)")
            db.execute(
                "INSERT INTO orchestration_v2_projection_runs VALUES ('completed')"
            )
        self.assertEqual(installer.active_work(self.base), 0)


if __name__ == "__main__":
    unittest.main()
