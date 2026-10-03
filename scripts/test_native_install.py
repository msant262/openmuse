"""Native deployment contracts; no host changes and no credential values in output."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"apps/computer"))
from executor.deployment import render_units
from executor.job_runtime import JobRuntime
from executor.user_session import UserSession
from executor.admin_helper import NetworkPolicy, ruleset, policy_identity

ACCOUNT={"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot",
         "workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}


class PrivilegeContracts(unittest.TestCase):
    def test_native_proxy_is_fixed_reciprocal_and_obeys_pause(self):
        policy=NetworkPolicy(1003,["1.1.1.1"],browser_proxy_port=18777)
        self.assertTrue(policy.permits("127.0.0.1",18777,source_address="127.0.0.1"))
        self.assertTrue(policy.permits("127.0.0.1",49152,source_address="127.0.0.1",source_port=18777,direction="reply",state="established"))
        for gate in (True,False):
            self.assertFalse(policy.permits("127.0.0.1",49152,gate_open=gate,source_address="127.0.0.1",source_port=18777,direction="original",state="established"))
            self.assertFalse(policy.permits("127.0.0.1",18778,gate_open=gate,source_address="127.0.0.1"))
        self.assertFalse(policy.permits("127.0.0.1",18777,gate_open=False,source_address="127.0.0.1"))
        self.assertFalse(policy.permits("127.0.0.1",49152,gate_open=False,source_address="127.0.0.1",source_port=18777,direction="reply",state="established"))
        self.assertFalse(policy.permits("127.0.0.1",49152,source_address="100.91.96.14",source_port=18777,direction="reply",state="established"))
        rendered=ruleset([policy])
        self.assertLess(rendered.index("meta skuid @closed_uids reject"),rendered.index("tcp dport 18777"))
        self.assertEqual(policy_identity(rendered),policy_identity(rendered.replace("ct direction original","ct direction 0").replace("ct direction reply","ct direction 1")))

    def test_full_trust_preserves_sudo_and_managed_budgets_while_restricted_stays_hardened(self):
        for mode in ("full-trust","restricted"):
            account={**ACCOUNT,"trustMode":mode}
            registry={"lenovo-okami":account}
            units=render_units(registry,16*1024**3,4*1024**3)
            service=units["okami-session@lenovo-okami.service"]["Service"]
            calls=[]
            runtime=JobRuntime(UserSession(registry),runner=lambda argv:calls.append(argv) or "")
            runtime.launch({"id":"deployment-sudo-mode","executorId":"lenovo-okami",
                "args":{"command":"sudo -n true","memoryMaxBytes":1024**3}})
            self.assertEqual(service["NoNewPrivileges"],"no" if mode=="full-trust" else "yes")
            self.assertIn("--property=NoNewPrivileges="+service["NoNewPrivileges"],calls[0])
            self.assertEqual("CapabilityBoundingSet" in service,mode=="restricted")
            self.assertEqual(any(p.startswith("--property=CapabilityBoundingSet=") for p in calls[0]),mode=="restricted")
            self.assertIn("--property=MemoryMax=1073741824",calls[0])
            self.assertIn("--property=BindsTo=okami-executor@lenovo-okami.service",calls[0])
            self.assertEqual(service["Slice"],"okami-bots-u1003.slice")
            self.assertEqual(units["okami-bots.slice"]["Slice"]["MemoryMax"],str(12*1024**3))


if __name__=="__main__":unittest.main()
