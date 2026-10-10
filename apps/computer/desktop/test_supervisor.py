"""Real journal/gate tests with an account whose private IPC stops on freeze."""
import hashlib
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest.mock import patch
from executor.supervisor import Journal, Supervisor
from desktop.client import DesktopClient


def operation(identity, session="display", generation="generation", revision=1, executor="node"):
    return {"id":identity,"bindingHash":hashlib.sha256(identity.encode()).hexdigest(),
            "executorId":executor,"executorEpoch":3,"kind":"desktop","inspection":False,
            "resourceKey":"desktop:node:display","resourceFence":1,"expiresAt":"2999-01-01T00:00:00Z",
            "args":{"operation":"act","sessionId":session,"sessionGeneration":generation,"controlRevision":revision}}


class SupervisorDesktopTests(unittest.TestCase):
    def test_blocked_browser_version_read_reconciles_cleanup_without_replaying_or_faking_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            journal=Journal(Path(temporary)/"journal.sqlite");self.addCleanup(journal.close)
            for identity,method in [("version","Browser.getVersion"),("mutation","Page.navigate")]:
                value=operation(identity);value["kind"]="browser";value["args"].update(operation="cdp",body={"method":method,"params":{}})
                journal.receive(value);journal.receipt(identity,{"status":"outcome_unknown","message":"Original failed read","data":{"code":"BROWSER_CONTROLLED","cleanupConfirmed":False}})
            original=journal.get("mutation")
            journal.diagnostic_cleanup()
            receipt=journal.get("version")
            self.assertEqual(receipt["receipt"]["status"],"outcome_unknown")
            self.assertEqual(receipt["receipt"]["message"],"Original failed read")
            self.assertTrue(receipt["receipt"]["data"]["cleanupConfirmed"])
            self.assertEqual(journal.get("mutation"),original)
            journal.diagnostic_cleanup();self.assertEqual(journal.get("version"),receipt)

    def test_cold_desktop_waits_only_before_socket_connection_and_respects_gate(self):
        client=DesktopClient("node",{"uid":1003})
        gate=SimpleNamespace(quarantined=False,open=True,clock=lambda:0,deadline=40)
        with patch.object(client,"gate",side_effect=[FileNotFoundError(),ConnectionRefusedError(),{"accepted":True}]) as permit,patch("desktop.client.time.sleep"):
            self.assertEqual(client.resume_gate(gate),{"accepted":True})
            self.assertEqual(permit.call_count,3)
        for error in (PermissionError(),ValueError("wrong socket UID"),TimeoutError("ambiguous IPC")):
            with patch.object(client,"gate",side_effect=error) as permit:
                with self.assertRaises(type(error)):client.resume_gate(gate)
                self.assertEqual(permit.call_count,1)
        with patch.object(client,"gate",side_effect=FileNotFoundError()) as permit:
            with self.assertRaises(FileNotFoundError):client.resume_gate(gate,timeout=0)
            self.assertEqual(permit.call_count,1)
        gate.open=False
        with patch.object(client,"gate") as permit:
            with self.assertRaisesRegex(ValueError,"gate closed"):client.resume_gate(gate)
            permit.assert_not_called()

    def test_graphical_receipt_is_published_while_claim_is_blocked_and_never_replayed(self):
        with tempfile.TemporaryDirectory() as temporary:
            journal=Journal(Path(temporary)/"journal.sqlite");self.addCleanup(journal.close)
            supervisor=object.__new__(Supervisor)
            supervisor.journal=journal;supervisor.flush_lock=threading.Lock()
            supervisor.gate=SimpleNamespace(epoch=3,close=lambda reason:closed.append(reason))
            supervisor.workspace=SimpleNamespace(pending_publications=lambda:[])
            closed=[];performed=[];published=threading.Event();claim_waiting=threading.Event();release_claim=threading.Event()
            def request(route,payload):
                if route=="claim":
                    claim_waiting.set();release_claim.wait(3);return {}
                self.assertEqual(route,"receipt")
                published.set();return {"sequence":payload["sequence"]}
            supervisor.transport=SimpleNamespace(request=request)
            def perform(value):
                performed.append(value["id"]);journal.receive(value)
                journal.receipt(value["id"],{"status":"succeeded","data":{"frameId":"fresh"}})
            supervisor.perform=perform
            claim=threading.Thread(target=lambda:request("claim",{}));claim.start()
            try:
                self.assertTrue(claim_waiting.wait(1))
                supervisor.perform_graphical(operation("capture"))
                self.assertTrue(published.wait(.5));self.assertTrue(claim.is_alive())
                self.assertEqual(journal.unacknowledged(),[])
                def failed(*_):raise OSError("offline")
                supervisor.transport.request=failed
                supervisor.perform_graphical(operation("input"))
                self.assertEqual(closed,["receipt-transport-lost"])
                self.assertEqual(performed,["capture","input"])
                self.assertEqual(journal.get("input")["receipt"]["status"],"succeeded")
                supervisor.transport.request=request;supervisor.flush()
                self.assertEqual(performed,["capture","input"])
            finally:release_claim.set();claim.join(2)

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
            def transport(route,payload):
                if route=="register":
                    self.assertIn({"name":"transcribe","version":1},payload["capabilities"])
                    return {"protocolVersion":1,"epoch":3,"pause":{"paused":False,"revision":(journal.state("pause") or {"revision":1})["revision"]+1},"watchdogMs":40000}
                if route=="reconcile":return {"reconciled":True,"acknowledged":[]}
                raise AssertionError(route)
            supervisor=Supervisor({"executorId":"node","hostId":"lenovo"},sessions,runtime,workspace,journal,
                SimpleNamespace(request=transport),helper,desktop=desktop,
                resource_snapshot=lambda _:{"memoryTotalBytes":16*1024**3,"memoryAvailableBytes":12*1024**3,"botsMaxBytes":12*1024**3})
            self.assertTrue(supervisor.desktop_frozen)
            def resume_gate(gate):
                self.assertFalse(state["frozen"])
                self.assertTrue(supervisor.desktop_frozen,"watchdog cannot use cold IPC before startup acknowledgement")
                return ipc(gate)
            desktop.resume_gate=resume_gate
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
