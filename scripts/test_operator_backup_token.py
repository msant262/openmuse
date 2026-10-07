"""Real private bootstrap files; no secret is printed or exported as API env."""
import hashlib
from pathlib import Path
import tempfile
import unittest
import operator_backup_token as bootstrap


class OperatorBootstrap(unittest.TestCase):
    def setUp(self):
        # The bootstrap deliberately rejects writable ancestry. An application
        # TMPDIR can sit beneath a shared user directory; use a root-owned
        # sticky directory for this protected-file contract instead.
        self.temp=tempfile.TemporaryDirectory(dir="/var/tmp");self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name);self.directory.chmod(0o700)
        self.env=self.directory/"deployment.env";self.env.write_text("MODEL=fixture\nOPENMUSE_ACCESS_KEY=PAIRING-CANARY\n");self.env.chmod(0o600)
        self.token=self.directory/"api-bearer"
    def test_random_secret_is_exclusive_private_and_only_hash_enters_preserved_env(self):
        digest=bootstrap.create(self.token,self.env)
        token=self.token.read_text().strip()
        self.assertRegex(token,r"^odb1\.[A-Za-z0-9_-]{43}$")
        self.assertEqual(self.token.stat().st_mode&0o777,0o600)
        self.assertEqual(digest,hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token,self.env.read_text());self.assertIn("PAIRING-CANARY",self.env.read_text())
        self.assertIn("DEPLOYMENT_OPERATOR_TOKEN_SHA256="+digest,self.env.read_text())
        with self.assertRaises(FileExistsError):bootstrap.create(self.token,self.env)
        self.assertEqual(bootstrap.sync_env(self.token,self.env),digest)
    def test_replacement_hash_revokes_old_secret_without_keeping_old_plaintext_in_env(self):
        old=bootstrap.create(self.token,self.env)
        replacement=self.directory/"api-bearer.next"
        new=bootstrap.create(replacement,self.env)
        self.assertNotEqual(old,new)
        self.assertNotIn(old,self.env.read_text());self.assertNotIn(replacement.read_text().strip(),self.env.read_text())
        self.assertEqual(self.env.read_text().count("DEPLOYMENT_OPERATOR_TOKEN_SHA256="),1)
    def test_broad_modes_links_ambiguous_hash_or_session_file_fail_closed(self):
        bootstrap.create(self.token,self.env)
        self.token.chmod(0o644)
        with self.assertRaises(ValueError):bootstrap.sync_env(self.token,self.env)
        self.token.chmod(0o600);self.token.write_text("om1.expiring.session")
        with self.assertRaises(ValueError):bootstrap.sync_env(self.token,self.env)
        self.token.unlink();self.token.symlink_to(self.env)
        with self.assertRaises(ValueError):bootstrap.sync_env(self.token,self.env)
        self.token.unlink();bootstrap.create(self.token,self.env)
        self.env.write_text(self.env.read_text()+"DEPLOYMENT_OPERATOR_TOKEN_SHA256=duplicate\n")
        with self.assertRaises(ValueError):bootstrap.sync_env(self.token,self.env)


if __name__=="__main__":unittest.main()
