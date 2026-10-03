"""Explicit real-age acceptance. Run with AGE_BINARY or an installed age >=1.2.1."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from hybrid_backup import HybridBackup
from test_hybrid_deployment import FakeHybrid


class AgeTools(unittest.TestCase):
    def test_real_authenticated_encryption_isolated_restore_and_tamper_rejection(self):
        binary=os.environ.get("AGE_BINARY") or shutil.which("age")
        if not binary:raise ValueError("Explicit tool acceptance requires an actual age binary")
        keygen=Path(binary).with_name("age-keygen")
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);identity=root/"offline-operator.key"
            subprocess.run([str(keygen),"--output",str(identity)],check=True,capture_output=True)
            identity.chmod(0o600)
            public=subprocess.run([str(keygen),"-y",str(identity)],check=True,capture_output=True,text=True).stdout.strip()
            deployment=FakeHybrid(temp);deployment.config["recipient"]=public;deployment.age=binary
            delegated=deployment.run
            def run(argv,**kwargs):
                if argv[0]==binary:return subprocess.run(argv,check=True,timeout=30,stderr=subprocess.PIPE,**kwargs)
                return delegated(argv,**kwargs)
            deployment.run=run
            deployment.encrypt=lambda source,target:HybridBackup.encrypt(deployment,source,target)
            canary=b"PRIVATE-COOKIE-ARCHIVE-CANARY"
            original=deployment.volume_paths["browser"]/"cookies.json";original.write_bytes(canary)
            archive=deployment.backup(14)
            self.assertNotIn(canary,archive.read_bytes())
            calls_before=len(deployment.calls)
            restored=deployment.restore(archive,identity)
            self.assertEqual((restored/"browser/cookies.json").read_bytes(),canary)
            self.assertTrue((restored/"server/state.txt").exists())
            self.assertTrue((restored/"vault.snap").exists())
            self.assertFalse((restored/"deployment-secrets/openbao-unseal.key").exists())
            inspect=json.loads((restored/"compose.inspect.json").read_text())["services"]["inspect"]
            self.assertEqual(inspect["network_mode"],"none")
            self.assertEqual(inspect["environment"]["TASK_WORKER_ENABLED"],"false")
            self.assertEqual(inspect["environment"]["PROACTIVITY_ENABLED"],"false")
            self.assertEqual(len(deployment.calls),calls_before)  # No docker start/volume overwrite/cron.
            self.assertEqual(original.read_bytes(),canary)
            damaged=bytearray(archive.read_bytes());damaged[-4]^=1;archive.write_bytes(damaged)
            archive.with_name(archive.name+".sha256").write_text(hashlib.sha256(damaged).hexdigest()+"\n")
            before=set(deployment.restore_directory.iterdir())
            with self.assertRaises(subprocess.SubprocessError):deployment.restore(archive,identity)
            self.assertEqual(set(deployment.restore_directory.iterdir()),before)


if __name__=="__main__":unittest.main()
