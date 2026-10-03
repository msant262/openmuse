import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

from renew_openbao_tokens import PERIOD, Renewal, validate_identity


def identity(policy):
    return {"type": "service", "orphan": True, "renewable": True, "num_uses": 0,
        "explicit_max_ttl": 0, "period": PERIOD, "policies": [policy], "ttl": 3600}


class RenewalContracts(unittest.TestCase):
    def test_root_parented_short_or_limited_tokens_are_rejected(self):
        original = identity("openmuse-credentials")
        validate_identity(original, "openmuse-credentials")
        for key, value in (("policies", ["root"]), ("policies", ["openmuse-credentials", "default"]),
            ("identity_policies", ["extra"]), ("orphan", False), ("type", "batch"),
            ("renewable", False), ("num_uses", 1), ("period", 3600),
            ("ttl", 0), ("explicit_max_ttl", 32 * 86400)):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_identity({**original, key: value}, "openmuse-credentials")

    def fixture(self, folder, fail_broker=False, short_renewal=False):
        root = Path(folder)
        env = root / ".env"; env.write_text("private config"); env.chmod(0o600)
        backup = root / "snapshot-token"; backup.write_text("private-snapshot-canary"); backup.chmod(0o600)
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            self.assertNotIn("private-", " ".join(argv))
            if "config" in argv:
                response = {"services": {"server": {"environment": {"CREDENTIALS_OPENBAO_TOKEN": "private-broker-canary"}}}}
            else:
                token = kwargs["input"].decode().strip()
                self.assertIn(token, ("private-broker-canary", "private-snapshot-canary"))
                if fail_broker and token == "private-broker-canary":
                    raise subprocess.CalledProcessError(1, argv, stderr=b"private-broker-canary")
                if "token lookup" in argv[-1]:
                    response = {"data": identity("openmuse-credentials" if token == "private-broker-canary" else "openmuse-backup")}
                else:
                    response = {"auth": {"renewable": True, "client_token": token,
                        "lease_duration": 30 if short_renewal else PERIOD}}
            return SimpleNamespace(stdout=json.dumps(response).encode())
        return Renewal(root, env, backup, run=run), calls

    def test_both_tokens_renew_without_argv_or_result_secret_disclosure(self):
        with tempfile.TemporaryDirectory() as directory:
            service, calls = self.fixture(directory)
            result = service.renew()
            self.assertEqual([item["policy"] for item in result], ["openmuse-credentials", "openmuse-backup"])
            self.assertNotIn("private-", json.dumps(result))
            self.assertEqual(len(calls), 5)

    def test_one_revoked_token_does_not_prevent_other_renewal_or_leak_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            service, calls = self.fixture(directory, fail_broker=True)
            with self.assertRaisesRegex(ValueError, "openmuse-credentials") as error:
                service.renew()
            self.assertNotIn("private-", str(error.exception))
            self.assertTrue(any("token renew" in argv[-1] and args["input"] == b"private-snapshot-canary\n" for argv, args in calls))

    def test_short_extension_does_not_claim_indefinite_renewal(self):
        with tempfile.TemporaryDirectory() as directory:
            service, _ = self.fixture(directory, short_renewal=True)
            with self.assertRaises(ValueError):
                service.renew()


if __name__ == "__main__":
    unittest.main()
