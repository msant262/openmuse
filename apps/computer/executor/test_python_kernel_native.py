"""The interpreter may only use registered native units and directory anchors."""
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from .job_runtime import JobRuntime
from .python_kernel_native import NativePythonLauncher
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


if __name__ == "__main__":
    unittest.main()
