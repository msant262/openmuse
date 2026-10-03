import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class SessionContracts(unittest.TestCase):
    def module(self):
        return importlib.import_module("desktop.session")

    def test_launch_has_no_tcp_or_raw_viewer_input_and_no_parent_secrets(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            config = mod.SessionConfig("lenovo-bot", os.getuid(), home, home, 177, 1280, 720)
            argv = mod.xvnc_arguments(config, home / "Xauthority", home / "rfb.sock")
            self.assertEqual(argv[argv.index("-rfbport") + 1], "-1")
            for flag in ("-AcceptKeyEvents=0", "-AcceptPointerEvents=0", "-AcceptCutText=0",
                         "-SendCutText=0", "-AcceptSetDesktopSize=0"):
                self.assertIn(flag, argv)
            self.assertEqual(argv[argv.index("-AllowOverride") + 1], "")
            env = mod.session_environment(config, home / "Xauthority", bus="unix:path=/run/test-bus")
            self.assertEqual(set(env), {"HOME", "PATH", "LANG", "DISPLAY", "XAUTHORITY",
                                       "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"})

    def test_runtime_path_must_be_private_owned_directory_not_symlink(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            mod.private_directory(root, os.getuid())
            root.chmod(0o755)
            with self.assertRaises(ValueError):
                mod.private_directory(root, os.getuid())
            root.chmod(0o700)
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                mod.private_directory(alias, os.getuid())

    def test_configuration_rejects_display_dimensions_and_account_switch(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for display, width, height in ((0, 1280, 720), (177, 0, 720), (177, 9000, 720)):
                with self.assertRaises(ValueError):
                    mod.SessionConfig("lenovo", os.getuid(), root, root, display, width, height)
            with self.assertRaises(ValueError):
                mod.SessionConfig("../other", os.getuid(), root, root, 177, 1280, 720)
            with self.assertRaises(ValueError):
                mod.SessionConfig("lenovo", os.getuid() + 1, root, root, 177, 1280, 720)


if __name__ == "__main__":
    unittest.main()
