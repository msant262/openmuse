import pathlib
import subprocess
import tempfile
import unittest

from verify_mobile_baseline import verify_mobile_baseline


class MobileBaselineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Release fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.root / "apps/mobile").mkdir(parents=True)
        (self.root / "apps/server").mkdir(parents=True)
        self.mobile = self.root / "apps/mobile/App.tsx"
        self.mobile.write_text("old interface")
        self.base = self.commit()
        self.mobile.write_text("current interface and conversation recovery")
        self.published = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.PIPE).decode().strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_rejects_api_branch_that_excludes_published_mobile_history(self):
        self.git("checkout", "-q", "--detach", self.base)
        (self.root / "apps/server/main.ts").write_text("new API with old mobile tree")
        wrong = self.commit()
        with self.assertRaisesRegex(ValueError, "published mobile"):
            verify_mobile_baseline(self.root, self.published, wrong)

    def test_accepts_mobile_successor_with_separate_api_changes(self):
        self.mobile.write_text("current interface plus editable memory")
        source = self.commit()
        (self.root / "apps/server/main.ts").write_text("independent API work")
        receipt = verify_mobile_baseline(self.root, self.published, source)
        self.assertEqual(receipt["mobileSourceCommit"], source)
        self.assertEqual(receipt["previousMobileSourceCommit"], self.published)

    def test_rejects_mobile_source_changed_after_commit(self):
        self.mobile.write_text("different uncommitted interface")
        with self.assertRaisesRegex(ValueError, "working tree"):
            verify_mobile_baseline(self.root, self.published, self.published)


if __name__ == "__main__":
    unittest.main()
