import datetime
import threading
import unittest
import uuid
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch
from desktop.broker import DesktopBroker, DesktopOperationError, NativeBrowser
from desktop.driver import DesktopDriver


class Device:
    def __init__(self):
        self.events = []
        self.on_event = lambda *_: None
    def capture(self):
        return 640, 360, b"\xff" * (640 * 360 * 3)
    def event(self, *event):
        self.events.append(event)
        self.on_event(*event)
    def reset(self):
        self.events.append(("reset",))


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.session = {"id": str(uuid.uuid4()), "sessionGeneration": str(uuid.uuid4()),
                        "browserSessionId": str(uuid.uuid4()), "profileId": "personal", "width":640, "height":360}
        self.device = Device()
        self.broker = DesktopBroker("lenovo-bot", "lenovo", self.session,
                                    DesktopDriver(self.device, self.session["sessionGeneration"]))
        self.broker.update_gate({"epoch":3,"open":True,"reconciled":True,"ttl":2})
    def operation(self, args, key=None):
        return {"id":str(uuid.uuid4()),"executorId":"lenovo-bot","executorEpoch":3,
                "resourceFence":7,"resourceKey":key or "system-admin:lenovo",
                "expiresAt":(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=20)).isoformat(),
                "kind":"desktop","args":{**args,"sessionId":self.session["id"],
                "sessionGeneration":self.session["sessionGeneration"],"controlRevision":self.broker.control_revision}}
    def observe(self):
        return self.broker.perform(self.operation({"operation":"observe"}))
    def test_root_peer_and_registered_destination_are_required(self):
        with self.assertRaisesRegex(ValueError,"root"):
            self.broker.handle(1003,{"operation":"status"})
        operation=self.operation({"operation":"observe"})
        operation["args"]["sessionId"]=str(uuid.uuid4())
        with self.assertRaises(DesktopOperationError) as failure:
            self.broker.perform(operation)
        self.assertFalse(failure.exception.dispatched)
    def test_mid_drag_takeover_revokes_and_releases_before_ack(self):
        frame=self.observe(); reached=threading.Event(); done=threading.Event(); failures=[]
        def hook(*event):
            if event==("button",1,True):
                reached.set(); done.wait(2)
        self.device.on_event=hook
        def act():
            try:self.broker.perform(self.operation({"operation":"act","actor":"agent","binding":frame,
                    "action":{"action":"drag","x":10,"y":10,"toX":200,"toY":200}},"desktop:lenovo-bot:"+self.session["id"]))
            except Exception as error:failures.append(str(error))
        thread=threading.Thread(target=act);thread.start();self.assertTrue(reached.wait(2))
        reset=self.operation({"operation":"reset","control":"human","grantId":str(uuid.uuid4())})
        reset["args"]["controlRevision"]=1
        reset_thread=threading.Thread(target=lambda:self.broker.perform(reset));reset_thread.start()
        done.set();thread.join(2);reset_thread.join(2)
        self.assertFalse(thread.is_alive());self.assertFalse(reset_thread.is_alive())
        self.assertTrue(failures);self.assertEqual(self.broker.control,"human")
        self.assertEqual(self.device.events[-1],("reset",))
        self.assertFalse(any(event[0]=="move" and event[1]>10 for event in self.device.events))
    def test_gate_loss_and_epoch_change_reject_old_frames(self):
        frame=self.observe();self.broker.update_gate({"epoch":4,"open":False,"reconciled":False,"ttl":2})
        with self.assertRaises(DesktopOperationError) as failure:
            self.broker.perform(self.operation({"operation":"act","actor":"agent","binding":frame,"action":{"action":"click","x":1,"y":1}},"desktop:lenovo-bot:"+self.session["id"]))
        self.assertEqual(failure.exception.code,"BROWSER_CONTROLLED")
        self.assertFalse(failure.exception.dispatched)
        self.assertIn(("reset",),self.device.events)
    def test_masks_are_trusted_and_reset_observations(self):
        first=self.observe(); self.broker.protect([(0,0,640,360)])
        masked=self.observe();self.assertNotEqual(first["imageHash"],masked["imageHash"])
        with self.assertRaises(DesktopOperationError) as failure:
            self.broker.perform(self.operation({"operation":"act","actor":"agent","binding":masked,"action":{"action":"click","x":1,"y":1}},"desktop:lenovo-bot:"+self.session["id"]))
        self.assertFalse(failure.exception.dispatched)
        self.assertTrue(failure.exception.cleanup_confirmed)
    def test_cleanup_failure_does_not_claim_confirmed_release(self):
        frame=self.observe()
        def fail():raise RuntimeError("device reset unavailable")
        self.device.reset=fail
        with self.assertRaises(DesktopOperationError) as failure:
            self.broker.perform(self.operation({"operation":"act","actor":"agent","binding":frame,"action":{"action":"click","x":1,"y":1}},"desktop:lenovo-bot:"+self.session["id"]))
        self.assertTrue(failure.exception.dispatched)
        self.assertFalse(failure.exception.cleanup_confirmed)


class BrowserRestartTests(unittest.TestCase):
    def test_control_changes_survive_a_browser_worker_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            browser=NativeBrowser({"browserSessionId":"session","sessionGeneration":"generation","profileId":"personal","width":640,"height":360},Path(directory),Path(directory),{"DISPLAY":":71","XAUTHORITY":"authority"},"worker.js")
            browser.reset("human",10)
            browser.reset("agent",11)
            process=Mock();process.poll.return_value=None
            def launched(*args,**kwargs):
                browser.socket.touch()
                return process
            with patch("desktop.broker.subprocess.Popen",side_effect=launched), patch("desktop.broker.exchange") as exchange:
                browser.start()
                self.assertEqual(exchange.call_args.args[1]["controlRevision"],11)
                self.assertEqual(exchange.call_args.args[1]["control"],"agent")
                self.assertEqual(exchange.call_count,1)
                browser.reset("human",12)
                self.assertEqual(exchange.call_args.args[1]["controlRevision"],12)
                self.assertEqual(exchange.call_count,2)

if __name__ == "__main__":unittest.main()
