"""The interpreter may only use registered native units and directory anchors."""
import os
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
