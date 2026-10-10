import hashlib
from pathlib import Path
import tempfile
import unittest

from reload_native_browser import reload_browser


class ReloadNativeBrowserTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.worker = Path(self.directory.name) / "native.js"
        self.worker.write_text("published browser source")
        self.digest = hashlib.sha256(self.worker.read_bytes()).hexdigest()
        self.calls = []
        tests = self
        class Client:
            units = ["okami-executor@fixture.service", "okami-session@fixture.service"]
            account = {"uid": 1003}
            status = {"maintenance": {"id": "publication"}, "pause": {"paused": False, "revision": 16},
                      "activeTasks": 0, "activeConversations": 0, "activeHttpRequests": 0,
                      "nativeDeliveries": 0, "workAdmissions": 0, "heldResources": 0,
                      "activeOperations": 40}
            def api(self):
                return {**self.status, "pause": dict(self.status["pause"])}
            def quiesce(self):
                return {"running": list(self.units)}
            def stop(self, context):
                tests.calls.append(("stop", list(context["running"])))
            def resume(self, context):
                tests.calls.append(("resume", list(context["running"])))
        self.client = Client()
        self.current = {"10": "before"}
    def processes(self, worker, unit, uid):
        self.assertEqual(worker, self.worker)
        self.assertEqual(unit, self.client.units[1])
        self.assertEqual(uid, 1003)
        if self.calls:
            return {"20": "after"}
        return self.current
    def reload(self, processes=None):
        return reload_browser(self.client, "publication", self.worker, self.digest,
                              processes=processes or self.processes)
    def test_both_writers_reload_and_historical_uncertainties_remain(self):
        result = self.reload()
        self.assertTrue(result["reloaded"])
        self.assertEqual(result["previousProcesses"], {"10": "before"})
        self.assertEqual(result["currentProcesses"], {"20": "after"})
        self.assertEqual(result["after"]["activeOperations"], 40)
        self.assertEqual(self.calls, [("stop", self.client.units), ("resume", self.client.units)])
    def test_an_old_graphical_process_cannot_count_as_a_published_browser(self):
        with self.assertRaisesRegex(ValueError, "previous build"):
            self.reload(lambda *_: {"10": "before"})
    def test_active_work_or_lost_maintenance_prevents_any_restart(self):
        original = dict(self.client.status)
        for change in ({"activeTasks": 1}, {"maintenance": {"id": "someone-else"}}):
            with self.subTest(change=change):
                self.client.status = {**original, **change}
                with self.assertRaises(ValueError):
                    self.reload()
                self.assertEqual(self.calls, [])
    def test_changed_source_blocks_restart(self):
        self.worker.write_text("unselected browser build")
        with self.assertRaisesRegex(ValueError, "selected build"):
            self.reload()
        self.assertEqual(self.calls, [])
    def test_failed_stop_still_restores_prior_writers(self):
        def stop(_):
            raise RuntimeError("stop failed")
        self.client.stop = stop
        with self.assertRaisesRegex(RuntimeError, "stop failed"):
            self.reload()
        self.assertEqual(self.calls, [("resume", self.client.units)])
    def test_runtime_pause_changes_are_rejected_without_overriding_them(self):
        original = self.client.resume
        def resume(context):
            original(context)
            self.client.status["pause"] = {"paused": True, "revision": 17}
        self.client.resume = resume
        with self.assertRaisesRegex(ValueError, "pause or historical"):
            self.reload()
        self.assertTrue(self.client.status["pause"]["paused"])


if __name__ == "__main__":
    unittest.main()
