"""The interpreter may only use registered native units and directory anchors."""
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from .job_runtime import JobRuntime
from .python_kernel_native import NativePythonLauncher, ManagedPythonLaunchers, stop_python_unit
from .job_runtime import HostBudget, host_snapshot
from .supervisor import Journal
from .user_session import UserSession


class NativePythonLauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = Path(self.directory.name) / "home"
        self.workspace = self.home / "workspace"
        self.workspace.mkdir(parents=True)
        self.home_fd = os.open(self.home, os.O_RDONLY | os.O_DIRECTORY)
        self.workspace_fd = os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY)
        account = dict(uid=1003, gid=1004, user="okami-bot", home=str(self.home),
                       workspace=str(self.workspace), trustMode="restricted")
        self.runtime = JobRuntime(UserSession({"node": account}), executor_id="node",
                                  home_fd=self.home_fd, workspace_fd=self.workspace_fd)
        self.launcher = NativePythonLauncher(self.runtime, executor_id="node", owner="owner",
                                             memory_bytes=512 * 1024**2, guard=lambda: True)
        self.scope = ("node", "owner", "conversation")

    def tearDown(self):
        os.close(self.home_fd)
        os.close(self.workspace_fd)
        self.directory.cleanup()

    def test_unit_has_fixed_account_private_pipes_slice_and_explicit_ram(self):
        argv, unit = self.launcher.command(self.scope, "@@fixed-sentinel@@")
        self.assertRegex(unit, r"^okami-python-[a-f0-9]{64}\.service$")
        self.assertIn("--pipe", argv)
        self.assertIn("--wait", argv)
        self.assertIn("--property=User=okami-bot", argv)
        self.assertIn("--property=Group=1004", argv)
        self.assertIn("--property=MemoryMax=536870912", argv)
        self.assertIn("--slice=okami-bots-u1003.slice", argv)
        self.assertIn("--property=BindsTo=okami-executor@node.service", argv)
        self.assertIn("--property=KillMode=control-group", argv)
        self.assertIn("--property=NoNewPrivileges=yes", argv)
        self.assertIn("--property=ProtectSystem=strict", argv)
        self.assertIn("--property=WorkingDirectory=/workspace", argv)
        self.assertIn("/usr/bin/python3", argv)
        self.assertNotIn("/usr/bin/bash", argv)
        self.assertIn("-I", argv)
        self.assertFalse(any("conversation" in arg or "owner" in arg for arg in argv))
        expected = f"--property=BindPaths=/proc/{os.getpid()}/fd/{self.workspace_fd}:/workspace /proc/{os.getpid()}/fd/{self.home_fd}:{self.home}"
        self.assertIn(expected, argv)

    def test_another_executor_or_owner_cannot_choose_the_registered_account(self):
        for scope in [("other-node", "owner", "conversation"), ("node", "other-owner", "conversation")]:
            with self.assertRaisesRegex(ValueError, "registered"):
                self.launcher.command(scope, "@@sentinel@@")

    def test_replacing_the_anchored_workspace_is_rejected_before_launch(self):
        self.workspace.rename(self.home / "old-workspace")
        self.workspace.mkdir()
        with self.assertRaisesRegex(ValueError, "anchor changed"):
            self.launcher.command(self.scope, "@@sentinel@@")

    def test_closed_native_gate_is_rejected_before_launch(self):
        self.launcher.guard = lambda: False
        with self.assertRaisesRegex(RuntimeError, "gate"):
            self.launcher.command(self.scope, "@@sentinel@@")

    def test_unanchored_directories_or_unsafe_ram_budget_are_rejected(self):
        with self.assertRaises(ValueError):
            NativePythonLauncher(self.runtime, executor_id="node", owner="owner", memory_bytes=True, guard=lambda: True)
        self.runtime.home_fd = None
        with self.assertRaisesRegex(ValueError, "anchors"):
            self.launcher.command(self.scope, "@@sentinel@@")

    def test_already_garbage_collected_unit_is_still_confirmed_stopped(self):
        calls = []
        def runner(args):
            calls.append(args)
            if args[1] == "stop":
                raise subprocess.CalledProcessError(5, args)
            return "LoadState=not-found\nActiveState=inactive\nControlGroup=\n"
        self.runtime.runner = runner
        process = SimpleNamespace(wait=lambda timeout: 0)
        with patch("executor.python_kernel_native.os.geteuid", return_value=0), \
                patch.object(self.launcher, "_source_is_trusted"), \
                patch("executor.python_kernel_native.subprocess.Popen", return_value=process) as popen:
            handle = self.launcher(self.scope, "@@sentinel@@")
        self.assertTrue(handle.stop())
        self.assertTrue(handle.stop())
        self.assertEqual(self.launcher.units, {})
        self.assertEqual(popen.call_args.kwargs["env"],
                         {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
        self.assertTrue(all(call[-1] == calls[0][-1] for call in calls if call[1] == "stop"))

    def test_failed_stop_of_a_live_unit_does_not_confirm_cleanup(self):
        def runner(args):
            if args[1] == "stop":
                raise subprocess.CalledProcessError(1, args)
            return "LoadState=loaded\nActiveState=active\nControlGroup=\n"
        self.runtime.runner = runner
        process = SimpleNamespace(wait=lambda timeout: 0)
        with patch("executor.python_kernel_native.os.geteuid", return_value=0), \
                patch.object(self.launcher, "_source_is_trusted"), \
                patch("executor.python_kernel_native.subprocess.Popen", return_value=process):
            handle = self.launcher(self.scope, "@@sentinel@@")
        self.assertFalse(handle.stop())
        self.assertEqual(len(self.launcher.units), 1)

    def frozen_unit(self, observed_group=None, remains_populated=False):
        self.runtime.cgroup_root = Path(self.directory.name) / "cgroups"
        group = "/okami.slice/okami-bots.slice/okami-bots-u1003.slice/okami-python-" + "c" * 64 + ".service"
        directory = self.runtime.cgroup_root / group.lstrip("/")
        directory.mkdir(parents=True)
        (directory.parent / "cgroup.freeze").write_text("1")
        (directory / "cgroup.kill").write_text("")
        (directory / "cgroup.events").write_text("populated 1\nfrozen 1\n")
        sibling = directory.parent / "unrelated.service"
        sibling.mkdir()
        (sibling / "cgroup.events").write_text("populated 1\nfrozen 1\n")
        calls = []
        def runner(args):
            calls.append(args)
            if args[1] == "stop":
                raise subprocess.CalledProcessError(1, args, stderr="Cannot perform operation on frozen unit")
            killed = (directory / "cgroup.kill").read_text() == "1"
            if killed and not remains_populated:
                (directory / "cgroup.events").write_text("populated 0\nfrozen 1\n")
            return "LoadState=loaded\nActiveState=" + ("failed" if killed and not remains_populated else "active") + "\nControlGroup=" + (observed_group or group) + "\n"
        self.runtime.runner = runner
        return directory, sibling, calls

    def test_frozen_owned_unit_is_killed_without_thawing_its_parent_or_sibling(self):
        directory, sibling, calls = self.frozen_unit()
        self.assertTrue(stop_python_unit(self.runtime, "node", directory.name))
        self.assertEqual((directory / "cgroup.kill").read_text(), "1")
        self.assertEqual((directory.parent / "cgroup.freeze").read_text(), "1")
        self.assertIn("populated 1", (sibling / "cgroup.events").read_text())
        self.assertFalse(any(args[1] == "thaw" for args in calls))

    def test_mismatched_systemd_group_is_never_killed(self):
        directory, sibling, _ = self.frozen_unit(observed_group="/okami.slice/okami-bots.slice/unrelated.service")
        self.assertFalse(stop_python_unit(self.runtime, "node", directory.name))
        self.assertEqual((directory / "cgroup.kill").read_text(), "")
        self.assertIn("populated 1", (sibling / "cgroup.events").read_text())

    def test_kill_request_without_observed_teardown_retains_uncertainty(self):
        directory, _, _ = self.frozen_unit(remains_populated=True)
        with patch("executor.python_kernel_native.time.monotonic", side_effect=[0, 6]):
            self.assertFalse(stop_python_unit(self.runtime, "node", directory.name))
        self.assertEqual((directory / "cgroup.kill").read_text(), "1")

    def managed(self):
        journal = Journal(Path(self.directory.name) / "journal.sqlite")
        budget = HostBudget(16 * 1024**3, 3 * 1024**3)
        self.addCleanup(journal.close)
        self.addCleanup(budget.close)
        snapshot = lambda: {"memoryAvailableBytes": 12 * 1024**3, "managedSessionBytes": 0}
        return ManagedPythonLaunchers(self.runtime, journal, budget, executor_id="node",
            guard=lambda: True, snapshot=snapshot), journal, budget

    def test_unit_identity_and_memory_reservation_are_durable_before_process_start(self):
        managed, journal, budget = self.managed()
        launcher = managed.factory("owner", 512 * 1024**2)
        def popen(*args, **kwargs):
            records = journal.state("python-units")
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["scope"], list(self.scope))
            self.assertEqual(budget.jobs[records[0]["unit"]]["bytes"], 512 * 1024**2)
            self.assertFalse(budget.jobs[records[0]["unit"]]["heavy"])
            return SimpleNamespace(wait=lambda timeout: 0)
        self.runtime.runner = lambda args: "LoadState=not-found\nActiveState=inactive\nControlGroup=\n"
        with patch("executor.python_kernel_native.os.geteuid", return_value=0), \
                patch.object(launcher, "_source_is_trusted"), \
                patch("executor.python_kernel_native.subprocess.Popen", side_effect=popen):
            handle = launcher(self.scope, "@@sentinel@@")
        self.assertEqual(budget.reserved_bytes, 512 * 1024**2)
        self.assertTrue(handle.stop())
        self.assertEqual(journal.state("python-units"), [])
        self.assertEqual(budget.reserved_bytes, 0)

    def test_restart_stops_the_recorded_unit_without_running_a_cell_or_forgetting_uncertainty(self):
        managed, journal, budget = self.managed()
        unit = self.launcher.command(self.scope, "@@sentinel@@")[1]
        record = {"unit": unit, "executorId": "node", "scope": list(self.scope), "memoryBytes": 512 * 1024**2}
        journal.state("python-units", [record])
        calls = []
        def runner(args):
            calls.append(args)
            return "LoadState=loaded\nActiveState=active\nControlGroup=\n"
        self.runtime.runner = runner
        self.assertFalse(managed.recover())
        self.assertEqual(budget.reserved_bytes, 512 * 1024**2)
        self.assertEqual(journal.state("python-units"), [record])
        self.runtime.runner = lambda args: calls.append(args) or "LoadState=not-found\nActiveState=inactive\nControlGroup=\n"
        self.assertTrue(managed.recover())
        self.assertEqual(budget.reserved_bytes, 0)
        self.assertEqual(journal.state("python-units"), [])
        self.assertTrue(all(args[:2] in (["systemctl", "stop"], ["systemctl", "show"]) for args in calls))

    def test_idle_kernel_ram_is_reserved_once_instead_of_charged_as_an_unowned_desktop(self):
        base = Path(self.directory.name) / "cgroups"
        bots = base / "okami.slice" / "okami-bots.slice"
        group = bots / "okami-bots-u1003.slice" / ("okami-python-" + "a" * 64 + ".service")
        group.mkdir(parents=True)
        (group / "memory.current").write_text(str(512 * 1024**2))
        for name, value in [("memory.current", 768 * 1024**2), ("memory.high", 12 * 1024**3),
                            ("memory.max", 13 * 1024**3), ("memory.pressure", "some avg10=0")]:
            (bots / name).write_text(str(value))
        meminfo = Path(self.directory.name) / "meminfo"
        meminfo.write_text("MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\n")
        with patch("executor.job_runtime.unmanaged_memory", return_value=0):
            observed = host_snapshot("node", cgroup_root=base, meminfo_path=meminfo, accounts=[{"uid": 1003}])
        self.assertEqual(observed["managedSessionBytes"], 256 * 1024**2)


if __name__ == "__main__":
    unittest.main()
