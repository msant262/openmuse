"""Mock Docker control/namespace only; real GNU tar IO. No Docker or host deployment."""
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import deployment_backup as backup


class FakeDeployment(backup.Deployment):
    def __init__(self, directory):
        project = Path(directory) / "project"
        project.mkdir(mode=0o700)
        (project / "deployment-secrets").mkdir(mode=0o700)
        (project / ".env").write_text("MODEL=local/fixture\n")
        (project / ".env").chmod(0o600)
        super().__init__(project, project / ".env", Path(directory) / "backups")
        self.calls, self.volume_paths, self.states = [], {}, {}
        self.dirty, self.fail_copy, self.fail_start, self.change_volume = None, False, None, False
        for name in backup.WRITERS:
            self.states[name] = {"Id": name, "Config": {"Image": "fixture-image", "Env": []},
                                 "State": {"Running": True, "Status": "running", "ExitCode": 0, "OOMKilled": False}, "Mounts": []}
        for name, (service, target) in backup.MOUNTS.items():
            path = Path(directory) / ("original-" + name)
            path.mkdir(mode=0o700)
            content = path / "state.txt"
            content.write_text("durable " + name)
            content.chmod(0o600)
            self.volume_paths[name] = path
            self.states[service]["Mounts"].append({"Type": "volume", "Name": name, "Destination": target})

    def run(self, argv, **kwargs):
        self.calls.append(argv)
        result = subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")
        if argv[1] == "compose":
            if "ps" in argv:
                result.stdout = argv[-1].encode()
            elif "stop" in argv:
                state = self.states[argv[-1]]["State"]
                state.update(Running=False, Status="exited")
                if self.dirty and argv[-1] == "computer":
                    state.update(self.dirty)
            elif "start" in argv:
                self.states[argv[-1]]["State"].update(Running=True, Status="running")
                if argv[-1] == self.fail_start:
                    raise subprocess.CalledProcessError(1, argv)
        elif argv[1] == "inspect":
            value = copy.deepcopy(self.states[argv[-1]])
            if self.change_volume and not value["State"]["Running"] and argv[-1] == "server":
                value["Mounts"][0]["Name"] = "changed"
            result.stdout = json.dumps([value]).encode()
        elif argv[1:3] == ["volume", "create"]:
            path = self.directory / argv[-1]
            path.mkdir(mode=0o700)
            self.volume_paths[argv[-1]] = path
        elif argv[1] == "run":
            if self.fail_copy:
                raise subprocess.CalledProcessError(1, argv)
            self.assert_helper(argv)
            with tempfile.TemporaryDirectory(dir=self.directory) as work:
                root = Path(work)
                volume_targets = {}
                for index, arg in enumerate(argv):
                    if arg != "--mount":
                        continue
                    values = dict(item.split("=", 1) for item in argv[index + 1].split(",") if "=" in item)
                    key = values["dst"].removeprefix("/state/")
                    source = Path(values["src"]) if values["type"] == "bind" else self.volume_paths[values["src"]]
                    if values["type"] == "volume":
                        volume_targets[key] = source
                    if source.is_dir():
                        shutil.copytree(source, root / key)
                    else:
                        shutil.copyfile(source, root / key)
                tar_index = argv.index("--entrypoint") + 3
                tar_args = argv[tar_index:]
                tar_args[tar_args.index("/state")] = str(root)
                actual = subprocess.run(["tar", *tar_args], check=True, **kwargs)
                if "--interactive" in argv:
                    for key, target in volume_targets.items():
                        for entry in (root / key).iterdir():
                            if entry.is_dir():
                                shutil.copytree(entry, target / entry.name, copy_function=shutil.copy2)
                            else:
                                shutil.copy2(entry, target / entry.name)
                    recovery = next(Path(argv[i + 1].split("src=", 1)[1].split(",", 1)[0]) for i, arg in enumerate(argv) if arg == "--mount" and "dst=/state/recovery" in argv[i + 1])
                    shutil.copytree(root / "recovery", recovery, dirs_exist_ok=True)
                return actual
        return result

    @staticmethod
    def assert_helper(argv):
        assert argv[argv.index("--network") + 1] == "none"
        assert argv[argv.index("--memory") + 1] == "128m"
        assert argv[argv.index("--memory-swap") + 1] == "128m"
        assert "--read-only" in argv and "--init" in argv
        assert "docker.sock" not in str(argv)


class BackupContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openmuse-backup-test-")
        self.deployment = FakeDeployment(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def archives(self):
        return list(self.deployment.directory.glob("*.tar.gz"))

    def test_roundtrip_preserves_state_private_modes_and_does_not_overwrite_originals(self):
        d = self.deployment
        archive = d.backup(14)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(d.directory.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(value["State"]["Running"] for value in d.states.values()))
        for value in d.states.values():
            value["State"].update(Running=False, Status="exited")
        original = {key: (path / "state.txt").read_bytes() for key, path in d.volume_paths.items()}
        override = d.restore(archive)
        self.assertEqual(override.stat().st_mode & 0o777, 0o600)
        assignments = dict(line.split("=", 1) for line in override.read_text().splitlines())
        for key in backup.MOUNTS:
            restored = d.volume_paths[assignments[backup.VOLUME_ENV[key]]] / "state.txt"
            self.assertEqual(restored.read_bytes(), original[key])
            self.assertEqual(restored.stat().st_mode & 0o777, 0o600)
            self.assertEqual(restored.stat().st_uid, os.geteuid())
            self.assertEqual((d.volume_paths[key] / "state.txt").read_bytes(), original[key])
        self.assertEqual((override.parent / "deployment.env").read_bytes(), d.env.read_bytes())
        self.assertTrue(all(not value["State"]["Running"] for value in d.states.values()))

    def test_kill_oom_error_and_nonzero_stop_refuse_copy_but_resume(self):
        for dirty in ({"ExitCode": 137}, {"ExitCode": 143}, {"OOMKilled": True}, {"ExitCode": 1}, {"Error": "failed stop"}):
            with self.subTest(dirty=dirty):
                d = self.deployment
                for state in d.states.values():
                    state["State"] = {"Running": True, "Status": "running", "ExitCode": 0, "OOMKilled": False}
                d.calls.clear()
                d.dirty = dirty
                with self.assertRaises(ValueError):
                    d.backup(14)
                self.assertFalse(any(call[1] == "run" for call in d.calls))
                self.assertFalse(self.archives())
                self.assertTrue(all(value["State"]["Running"] for value in d.states.values()))

    def test_copy_failure_keeps_previous_archive_and_initial_stopped_service(self):
        d = self.deployment
        good = d.backup(14)
        os.utime(good, (1, 1))
        d.states["browser"]["State"].update(Running=False, Status="exited")
        d.fail_copy = True
        d.calls.clear()
        with self.assertRaises(subprocess.CalledProcessError):
            d.backup(1)
        self.assertTrue(good.exists())
        self.assertEqual(self.archives(), [good])
        starts = [call[-1] for call in d.calls if "start" in call]
        self.assertEqual(starts, ["computer", "server"])
        self.assertFalse(d.states["browser"]["State"]["Running"])
        self.assertFalse(list(d.directory.glob(".pending-*")))

    def test_resume_attempts_every_previous_service_even_if_one_start_fails(self):
        d = self.deployment
        d.fail_copy = True
        d.fail_start = "computer"
        with self.assertRaises(RuntimeError):
            d.backup(14)
        self.assertEqual([call[-1] for call in d.calls if "start" in call], ["computer", "browser", "server"])

    def test_external_db_and_volume_changes_refuse_copy(self):
        d = self.deployment
        d.states["server"]["Config"]["Env"] = ["DATABASE_URL=postgres://fixture"]
        with self.assertRaises(ValueError):
            d.backup(14)
        self.assertFalse(any("stop" in call for call in d.calls))
        d.states["server"]["Config"]["Env"] = []
        d.change_volume = True
        with self.assertRaises(ValueError):
            d.backup(14)
        self.assertFalse(any(call[1] == "run" for call in d.calls))

    def test_lock_and_symlink_destination_fail_closed(self):
        d = self.deployment
        with d.lock():
            with self.assertRaises(BlockingIOError):
                with d.lock():
                    pass
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(d.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            backup.private_path(alias, directory=True)

    def test_checksum_running_writer_and_unsafe_archive_refuse_restore(self):
        d = self.deployment
        archive = d.backup(14)
        with self.assertRaises(ValueError):
            d.restore(archive)
        for value in d.states.values():
            value["State"].update(Running=False, Status="exited")
        checksum = archive.with_name(archive.name + ".sha256")
        checksum.write_text("0" * 64)
        with self.assertRaises(ValueError):
            d.restore(archive)
        with tarfile.open(archive, "w:gz") as tar:
            member = tarfile.TarInfo("../../escape")
            member.size = 3
            tar.addfile(member, io.BytesIO(b"bad"))
        checksum.write_text(backup.checksum(archive))
        with self.assertRaises(ValueError):
            d.restore(archive)
        self.assertFalse(any(call[1:3] == ["volume", "create"] for call in d.calls))


if __name__ == "__main__":
    unittest.main()
