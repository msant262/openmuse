"""Real journal/gate tests with an account whose private IPC stops on freeze."""
import hashlib
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from executor.supervisor import Journal, Supervisor


def operation(identity, session="display", generation="generation", revision=1, executor="node"):
    return {"id":identity,"bindingHash":hashlib.sha256(identity.encode()).hexdigest(),
            "executorId":executor,"executorEpoch":3,"kind":"desktop","inspection":False,
            "resourceKey":"desktop:node:display","resourceFence":1,"expiresAt":"2999-01-01T00:00:00Z",
            "args":{"operation":"act","sessionId":session,"sessionGeneration":generation,"controlRevision":revision}}


class SupervisorDesktopTests(unittest.TestCase):
    def test_cleanup_only_confirms_the_reset_fixed_session_and_preserves_uncertainty(self):
        with tempfile.TemporaryDirectory() as temporary:
            journal=Journal(Path(temporary)/"journal.sqlite");self.addCleanup(journal.close)
            for value in (operation("same"),operation("other-display",session="other"),
                          operation("other-generation",generation="other"),operation("other-account",executor="other"),
                          operation("new-revision",revision=2)):
                journal.receive(value);journal.receipt(value["id"],{"status":"outcome_unknown","data":{"cleanupConfirmed":False}})
            reset=operation("reset",revision=2);reset["args"]["operation"]="reset"
            journal.graphical_cleanup(reset)
            same=journal.get("same")
            self.assertEqual(same["receipt"]["status"],"outcome_unknown")
            self.assertTrue(same["receipt"]["data"]["cleanupConfirmed"])
            sequence=same["sequence"];journal.graphical_cleanup(reset)
            self.assertEqual(journal.get("same")["sequence"],sequence)
            for identity in ("other-display","other-generation","other-account","new-revision"):
                self.assertFalse(journal.get(identity)["receipt"]["data"]["cleanupConfirmed"])

    def test_pause_readiness_and_watchdog_never_wait_for_frozen_account_ipc(self):
        with tempfile.TemporaryDirectory() as temporary:
            journal=Journal(Path(temporary)/"journal.sqlite");self.addCleanup(journal.close)
            state={"frozen":False,"ipc":0}
            preview={key:{"state":"ready"} for key in ("display","capture","input","browser")}
            def ipc(*_):
                self.assertFalse(state["frozen"],"private IPC cannot answer from the frozen account")
                state["ipc"]+=1
                return preview
            def freeze(*_):state["frozen"]=True;return True
            def thaw(*_):state["frozen"]=False;return True
            desktop=SimpleNamespace(status=ipc,cached_status=lambda:preview,gate=ipc,close_gate=ipc,perform=ipc)
            account={"trustMode":"full-trust","uid":1003}
            sessions=SimpleNamespace(account=lambda _:account,registry={"node":account},preflight=lambda _:{"state":"ready"})
            runtime=SimpleNamespace(active={},contain=lambda *_,**__:True)
            workspace=SimpleNamespace(pending_publications=lambda:[])
            helper=SimpleNamespace(gate=lambda *_:True,contain_account=freeze,contain_session=lambda _:True,
                                   resume_session=lambda _:True,resume_account=thaw)
            def transport(route,_):
                if route=="register":return {"protocolVersion":1,"epoch":3,"pause":{"paused":False,"revision":(journal.state("pause") or {"revision":1})["revision"]+1},"watchdogMs":40000}
                if route=="reconcile":return {"reconciled":True,"acknowledged":[]}
                raise AssertionError(route)
            supervisor=Supervisor({"executorId":"node","hostId":"lenovo"},sessions,runtime,workspace,journal,
                SimpleNamespace(request=transport),helper,desktop=desktop,
                resource_snapshot=lambda _:{"memoryTotalBytes":16*1024**3,"memoryAvailableBytes":12*1024**3,"botsMaxBytes":12*1024**3})
            self.assertTrue(supervisor.desktop_frozen)
            supervisor.connect();self.assertFalse(state["frozen"])
            supervisor.readiness()
            ack=supervisor.gate.pause({"paused":True,"revision":3})
            self.assertTrue(ack["contained"]);before=state["ipc"]
            for _ in range(3):
                self.assertEqual(supervisor.readiness()["display"]["state"],"ready")
                self.assertTrue(supervisor.gate.pause({"paused":True,"revision":3})["contained"])
            with patch.object(supervisor.stop_event,"wait",side_effect=[False,True]):supervisor.watchdog()
            self.assertEqual(state["ipc"],before)
            self.assertFalse(supervisor.gate.quarantined)
            inspection=operation("paused-inspection");inspection["args"]["operation"]="observe";inspection["inspection"]=True
            supervisor.perform(inspection)
            self.assertEqual(journal.get(inspection["id"])["receipt"]["status"],"rejected_not_dispatched")
            self.assertEqual(state["ipc"],before)
            supervisor.connect();self.assertFalse(state["frozen"])
            self.assertGreater(state["ipc"],before)


if __name__=="__main__":unittest.main()
