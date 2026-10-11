"""Receipt/reply contracts with real child interpreters and local host fixtures.

The test launcher owns real interpreter processes in a temporary directory.
These tests do not prove Google effects, actual UI decisions or app acceptance.
"""
import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

from .python_kernel import KernelProcess, RUNNER_PATH
from .python_transport import NativePythonJobs, python_resource_key, validate_cell
from .supervisor import Journal, Supervisor


class PythonTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.journal = Journal(Path(self.directory.name) / "journal.sqlite")
        self.children, self.payloads, self.consumed = [], {}, []
        self.gate_open = True
        self.operations = []

        def guard(operation):
            if not self.gate_open:
                raise ValueError("Native gate is closed")

        def consume(route, body):
            self.consumed.append((route, body))
            return {"json": self.payloads[route.split("/")[1]]}

        def launch(scope, sentinel, cwd="/workspace"):
            process = subprocess.Popen([sys.executable, "-I", "-u", str(RUNNER_PATH), sentinel],
                cwd=Path(self.directory.name) / cwd.removeprefix("/workspace").lstrip("/"), env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            self.children.append(process)
            def stop():
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait(timeout=3)
                return True
            return KernelProcess(process, stop)

        self.jobs = NativePythonJobs("node", self.journal, guard=guard,
            consume=consume, launch_factory=lambda owner, memory: launch)

    def tearDown(self):
        self.jobs.contain()
        self.jobs.wait(timeout=3)
        self.journal.close()
        self.assertTrue(all(child.poll() is not None for child in self.children))
        self.directory.cleanup()

    def operation(self, identity, code, tools=(), session="conversation", received=True, cwd="/workspace", version=1):
        operation = dict(id=identity, executorId="node", taskId="task", revision=3,
            executorEpoch=2, resourceFence=4, bindingHash="a" * 64,
            resourceKey=python_resource_key("node", "owner", session),
            createdAt="2026-10-10T12:00:00Z", expiresAt="2099-10-10T12:00:00Z",
            kind="command", capability="python", capabilityVersion=version, inspection=False,
            resourceBudget={"memoryBytes": 512 * 1024**2, "heavy": False},
            args={"command": "Python cell", "cwd": cwd, "background": False,
                "timeoutMs": 2000, "pythonCell": {"owner": "owner", "sessionId": session,
                    "code": code, "tools": list(tools), "reset": False,
                    "maxToolCalls": 100, "outputBytes": 131072}})
        self.operations.append(operation)
        if received: self.journal.receive(operation)
        return operation

    def final(self, operation):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            receipt = self.journal.get(operation["id"])["receipt"]
            if receipt and receipt["status"] != "running": return receipt
            time.sleep(.01)
        self.fail("Native cell did not settle")

    def test_browser_commands_stay_local_without_per_key_receipts_or_api_replies(self):
        self.assertIn("local_browser", inspect.signature(NativePythonJobs).parameters,
                      "The root coordinator needs a private local browser command receiver")
        calls, records = [], []
        original_receipt = self.journal.receipt
        def receipt(identity, data):
            records.append(data)
            return original_receipt(identity, data)
        self.journal.receipt = receipt
        def browser(operation, args):
            self.assertEqual(operation["id"], "local-browser")
            self.assertEqual(args["session"], "documents")
            calls.append(args)
            if args["request"].get("method") == "Browser.getVersion":
                return {"result": {"userAgent": "Linux"}}
            if args["request"].get("method") == "Runtime.evaluate":
                return {"result": {"result": {"type": "boolean", "value": True}}}
            return {"result": {}}
        self.jobs.local_browser = browser
        parent = self.operation("local-browser", "fill_input('#message', 'x' * 120)\nprint('typed')",
            ["browser_harness_rpc"], version=3, received=False)
        parent["args"]["pythonCell"].update(fresh=True, browserSession="documents", maxToolCalls=1)
        self.journal.receive(parent)
        self.jobs.start(parent)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "succeeded", observed)
        self.assertGreater(len(calls), 200)
        self.assertEqual(observed["data"]["result"]["stdout"], "typed\n")
        self.assertEqual(observed["data"]["result"]["tool_calls"], [])
        self.assertEqual(self.consumed, [])
        self.assertEqual(len(records), 2, "Only program start and terminal receipt belong in this journal")
        self.assertTrue(all("pythonRpc" not in item.get("data", {}) for item in records))

    def test_caught_local_transport_failure_cannot_be_reported_as_success(self):
        def browser(operation, args):
            raise TimeoutError("Local command reply was lost after dispatch")
        self.jobs.local_browser = browser
        parent = self.operation("local-browser-unknown",
            "try:\n    goto_url('https://example.org')\nexcept RuntimeError:\n    print('caught')",
            ["browser_harness_rpc"], version=3, received=False)
        parent["args"]["pythonCell"].update(fresh=True, browserSession="documents")
        self.journal.receive(parent)
        self.jobs.start(parent)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "outcome_unknown", observed)
        self.assertTrue(observed["data"]["result"]["browser_outcome_unknown"])
        self.assertTrue(observed["data"]["cleanupConfirmed"], "Interpreter cleanup does not prove browser effects")

    def test_invalid_local_command_is_known_not_dispatched(self):
        calls = []
        self.jobs.local_browser = lambda operation, args: calls.append(args)
        parent = self.operation("local-browser-invalid",
            "tools.call('browser_harness_rpc', {'session':'documents', "
            "'request':{'method':'Page.navigate'}, 'timeoutMs':0})",
            ["browser_harness_rpc"], version=3, received=False)
        parent["args"]["pythonCell"].update(fresh=True, browserSession="documents")
        self.journal.receive(parent)
        self.jobs.start(parent)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "failed", observed)
        self.assertFalse(observed["data"]["result"]["browser_outcome_unknown"])
        self.assertEqual(calls, [])

    def pending(self, operation):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            receipt = self.journal.get(operation["id"])["receipt"]
            rpc = receipt and receipt.get("data", {}).get("pythonRpc")
            if rpc: return rpc
            time.sleep(.01)
        self.fail("Cell did not publish a tool request")

    def reply(self, parent, rpc, value, proceed=True, received=True):
        reference = "9d073d59-b1c0-4f77-8897-20ea2093089c"
        raw = json.dumps({"result": value, "continue": proceed}, ensure_ascii=False, separators=(",", ":"))
        self.payloads[reference] = raw
        operation = {**parent, "id": parent["id"] + "-reply-" + str(rpc["sequence"]),
            "kind": "session", "inspection": True,
            "args": {"operation": "python-reply", "operationId": parent["id"],
                "requestSequence": rpc["sequence"], "requestHash": rpc["sha256"],
                "replyReference": reference, "replyHash": hashlib.sha256(raw.encode()).hexdigest(),
                "replyBytes": len(raw.encode())}}
        if received: self.journal.receive(operation)
        return operation

    def test_cells_reuse_variables_without_claiming_the_live_unit_was_cleaned_up(self):
        first = self.operation("first", "values = [2, 3, 5]\nprint(sum(values))")
        self.jobs.start(first)
        observed = self.final(first)
        self.assertEqual(observed["data"]["result"]["stdout"], "10\n")
        self.assertEqual(observed["status"], "succeeded")
        self.assertTrue(observed["data"]["cellSettled"])
        self.assertFalse(observed["data"]["cleanupConfirmed"])
        second = self.operation("second", "print(sum(values))")
        self.jobs.start(second)
        observed = self.final(second)
        self.assertTrue(observed["data"]["result"]["reused"])
        self.assertEqual(observed["data"]["result"]["stdout"], "10\n")
        self.assertEqual(len(self.children), 1)

    def test_v3_fresh_scripts_use_new_processes_with_the_same_owned_workspace(self):
        first = self.operation("fresh-first", "from pathlib import Path\nvalue = 42\n"
            "Path('fresh-proof.txt').write_text('owned bytes')", version=3, received=False)
        first["args"]["pythonCell"]["fresh"] = True
        first["args"]["timeoutMs"] = 1800000
        try:
            validate_cell(first)
        except ValueError as error:
            self.fail(f"Fresh Python requires its negotiated native protocol: {error}")
        self.journal.receive(first)
        self.jobs.start(first)
        observed = self.final(first)
        self.assertEqual(observed["status"], "succeeded", observed)
        self.assertTrue(observed["data"]["cleanupConfirmed"])
        self.assertTrue(observed["data"]["stateLost"])
        self.assertIsNotNone(self.children[0].poll())
        second = self.operation("fresh-second", "from pathlib import Path\n"
            "print('value' in globals(), Path('fresh-proof.txt').read_text())",
            version=3, received=False)
        second["args"]["pythonCell"]["fresh"] = True
        self.journal.receive(second)
        self.jobs.start(second)
        observed = self.final(second)
        self.assertEqual(observed["status"], "succeeded", observed)
        self.assertEqual(observed["data"]["result"]["stdout"], "False owned bytes\n")
        self.assertFalse(observed["data"]["result"]["reused"])
        self.assertTrue(observed["data"]["cleanupConfirmed"])
        self.assertEqual(len(self.children), 2)

    def test_v3_fresh_rpc_accepts_its_exact_private_reply_then_closes_the_process(self):
        parent = self.operation("fresh-rpc", "from hermes_tools import read_drive\n"
            "print(read_drive({'query': 'MovingDE'})['observed'])", ["read_drive"],
            version=3, received=False)
        parent["args"]["pythonCell"]["fresh"] = True
        try:
            validate_cell(parent)
        except ValueError as error:
            self.fail(f"Fresh Python protocol is absent: {error}")
        self.journal.receive(parent)
        self.jobs.start(parent)
        rpc = self.pending(parent)
        control = self.reply(parent, rpc, {"observed": "actual returned value"})
        self.jobs.reply(control)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "succeeded", observed)
        self.assertEqual(observed["data"]["result"]["stdout"], "actual returned value\n")
        self.assertTrue(observed["data"]["cleanupConfirmed"])
        self.assertEqual(len(self.consumed), 1)
        self.assertIsNotNone(self.children[0].poll())

    def test_old_protocol_rejects_fresh_lifecycle_and_long_timeout_before_launch(self):
        for version in (1, 2):
            for fresh, timeout in ((True, 2000), (False, 2000), (None, 900001)):
                operation = self.operation(f"old-fresh-{len(self.operations)}", "print('never')",
                    version=version, received=False)
                if fresh is not None:
                    operation["args"]["pythonCell"]["fresh"] = fresh
                operation["args"]["timeoutMs"] = timeout
                with self.assertRaises(ValueError):
                    validate_cell(operation)
        self.assertEqual(self.children, [])

    def test_v2_cell_runs_in_host_bound_workspace_and_resumes_same_interpreter(self):
        directory = Path(self.directory.name) / "cards" / "one"
        directory.mkdir(parents=True)
        first = self.operation("workspace-first", "from pathlib import Path\nvalue = 42\nPath('proof.txt').write_text('correct')\nprint(Path.cwd())",
            cwd="/workspace/cards/one", version=2)
        self.jobs.start(first)
        observed = self.final(first)
        self.assertEqual(observed["status"], "succeeded", observed)
        self.assertEqual(observed["data"]["result"]["stdout"].strip(), str(directory))
        self.assertEqual((directory / "proof.txt").read_text(), "correct")
        second = self.operation("workspace-second", "print(value)", cwd="/workspace/cards/one", version=2)
        self.jobs.start(second)
        observed = self.final(second)
        self.assertEqual(observed["data"]["result"]["stdout"], "42\n")
        self.assertTrue(observed["data"]["result"]["reused"])
        self.assertEqual(len(self.children), 1)

    def test_old_python_protocol_cannot_silently_ignore_a_custom_workspace(self):
        for version, cwd in [(1, "/workspace/cards/one"), (4, "/workspace"), (2, "/workspace/../outside"), (2, "relative")]:
            operation = self.operation(f"bad-cwd-{len(self.operations)}", "print('never')", received=False, cwd=cwd, version=version)
            with self.assertRaises(ValueError): validate_cell(operation)
        self.assertEqual(len(self.children), 0)

    def test_v3_copied_browser_helper_uses_bound_rpc_and_writes_observed_output(self):
        parent = self.operation("browser-helper", "from pathlib import Path\n"
            "Path('observed-browser.txt').write_text(goto_url('https://example.org/owned')['frameId'])",
            ["browser_harness_rpc"], version=3, received=False)
        parent["args"]["pythonCell"].update(fresh=True, browserSession="documents")
        try:
            validate_cell(parent)
        except ValueError as error:
            self.fail(f"Copied browser helper binding is absent from native protocol: {error}")
        self.journal.receive(parent)
        self.jobs.start(parent)
        rpc = self.pending(parent)
        body = json.loads(rpc["json"])
        self.assertEqual(body, {"name": "browser_harness_rpc", "args": {
            "session": "documents", "timeoutMs": 5000,
            "request": {"method": "Page.navigate", "params": {"url": "https://example.org/owned"}, "session_id": None},
        }})
        self.jobs.reply(self.reply(parent, rpc, {"result": {"frameId": "owned-frame"}}))
        observed = self.final(parent)
        self.assertEqual(observed["status"], "succeeded", observed)
        self.assertEqual(Path(self.directory.name, "observed-browser.txt").read_text(), "owned-frame")
        self.assertTrue(observed["data"]["cleanupConfirmed"])
        self.assertIsNotNone(self.children[0].poll())

    def test_browser_helper_binding_requires_v3_freshness_and_its_catalog_before_launch(self):
        for version, fresh, name, tools in [
            (1, True, "documents", ["browser_harness_rpc"]),
            (2, True, "documents", ["browser_harness_rpc"]),
            (3, False, "documents", ["browser_harness_rpc"]),
            (3, True, "../other", ["browser_harness_rpc"]),
            (3, True, "documents", []),
        ]:
            parent = self.operation(f"bad-browser-{len(self.operations)}", "print('never')",
                tools, version=version, received=False)
            parent["args"]["pythonCell"].update(fresh=fresh, browserSession=name)
            with self.assertRaises(ValueError): validate_cell(parent)
        self.assertEqual(self.children, [])

    def test_browser_script_cannot_redirect_its_rpc_to_another_named_session(self):
        parent = self.operation("browser-wrong-session", "from hermes_tools import browser_harness_rpc\n"
            "browser_harness_rpc({'session':'other','request':{'meta':'current_tab'},'timeoutMs':5000})",
            ["browser_harness_rpc"], version=3, received=False)
        parent["args"]["pythonCell"].update(fresh=True, browserSession="documents")
        self.journal.receive(parent)
        self.jobs.start(parent)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "failed", observed)
        self.assertIn("bound browser session", observed["data"]["result"]["traceback"])
        self.assertEqual(self.consumed, [])
        self.assertEqual(self.jobs.active[parent["id"]].sequence, 0)

    def test_root_sequence_and_private_reply_deliver_the_full_result_once(self):
        parent = self.operation("rpc", "from hermes_tools import read_drive\nprint(len(read_drive({'query': 'MovingDE'})['files']))", ["read_drive"])
        self.jobs.start(parent)
        rpc = self.pending(parent)
        self.assertEqual(rpc["sequence"], 1)
        self.assertEqual(hashlib.sha256(rpc["json"].encode()).hexdigest(), rpc["sha256"])
        self.assertEqual(json.loads(rpc["json"]), {"name": "read_drive", "args": {"query": "MovingDE"}})
        reply = self.reply(parent, rpc, {"files": list(range(20_000))})
        self.jobs.reply(reply)
        observed = self.final(parent)
        self.assertEqual(observed["data"]["result"]["stdout"], "20000\n")
        self.assertNotIn("pythonRpc", observed["data"])
        self.assertNotIn("20000", json.dumps(self.journal.get(reply["id"])["operation"]["args"]))
        with self.assertRaisesRegex(ValueError, "pending|retired"):
            self.jobs.reply(reply)
        self.assertEqual(len(self.consumed), 1)

    def test_changed_workspace_rejection_preserves_the_correct_session_and_variables(self):
        directory = Path(self.directory.name) / "card"
        directory.mkdir()
        first = self.operation("cwd-original", "saved = 42", cwd="/workspace/card", version=2)
        self.jobs.start(first)
        self.assertEqual(self.final(first)["status"], "succeeded")
        changed = self.operation("cwd-changed", "print('must not run')", cwd="/workspace", version=2)
        with self.assertRaisesRegex(ValueError, "workspace.*changed"):
            self.jobs.start(changed)
        resumed = self.operation("cwd-resume", "print(saved)", cwd="/workspace/card", version=2)
        self.jobs.start(resumed)
        self.assertEqual(self.final(resumed)["data"]["result"]["stdout"], "42\n")
        self.assertEqual(len(self.children), 1)

    def test_other_task_epoch_revision_fence_resource_or_request_cannot_answer(self):
        parent = self.operation("bound", "from hermes_tools import read_drive\nread_drive({})", ["read_drive"])
        self.jobs.start(parent)
        rpc = self.pending(parent)
        reply = self.reply(parent, rpc, {"found": True})
        for key, value in [("taskId", "other-task"), ("executorEpoch", 99), ("revision", 4),
                           ("resourceFence", 99), ("resourceKey", "system-admin:node"), ("executorId", "other-node")]:
            invalid = copy.deepcopy(reply); invalid[key] = value
            with self.assertRaises(ValueError): self.jobs.reply(invalid)
        for key, value in [("requestSequence", 2), ("requestHash", "b" * 64), ("operationId", "other-cell")]:
            invalid = copy.deepcopy(reply); invalid["args"][key] = value
            with self.assertRaises(ValueError): self.jobs.reply(invalid)
        self.assertEqual(self.consumed, [])
        self.jobs.reply(reply)
        self.assertEqual(self.final(parent)["status"], "succeeded")

    def test_corrupted_or_expired_private_reply_never_reaches_the_interpreter(self):
        parent = self.operation("corrupt", "from hermes_tools import read_drive\nread_drive({})\nopen('must-not-exist', 'w').write('bad')", ["read_drive"])
        self.jobs.start(parent); rpc = self.pending(parent)
        reply = self.reply(parent, rpc, {"found": True})
        self.payloads[reply["args"]["replyReference"]] = '{"result":"changed","continue":true}'
        with self.assertRaisesRegex(ValueError, "binding|digest"): self.jobs.reply(reply)
        self.assertFalse(Path(self.directory.name, "must-not-exist").exists())
        self.gate_open = False
        with self.assertRaisesRegex(ValueError, "gate"): self.jobs.reply(reply)
        self.assertTrue(self.final(parent)["data"]["cleanupConfirmed"])

    def test_actual_review_reply_stops_before_later_calls_and_file_mutations(self):
        parent = self.operation("review", "from hermes_tools import change\nchange({})\nchange({'again': True})\nopen('must-not-exist', 'w').write('bad')", ["change"])
        self.jobs.start(parent); rpc = self.pending(parent)
        reply = self.reply(parent, rpc, {"paused": True, "actionId": "host-review"}, proceed=False)
        self.jobs.reply(reply)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "failed")
        self.assertTrue(observed["data"]["stoppedByHost"])
        self.assertEqual(observed["data"]["result"]["status"], "paused")
        self.assertTrue(observed["data"]["cleanupConfirmed"])
        self.assertEqual(observed["data"]["result"]["tool_calls"][0]["result"]["actionId"], "host-review")
        self.assertFalse(Path(self.directory.name, "must-not-exist").exists())
        self.assertEqual(len(self.consumed), 1)

    def test_review_without_confirmed_containment_remains_uncertain(self):
        parent = self.operation("unconfirmed-review", "from hermes_tools import change\nchange({})\nopen('must-not-exist', 'w').write('bad')", ["change"])
        self.jobs.start(parent); rpc = self.pending(parent)
        controller = self.jobs.controllers["owner"][0]
        kernel = controller.registry.kernels[("node", "owner", "conversation")]
        stop = kernel.handle.stop
        def unconfirmed():
            stop()
            return False
        kernel.handle.stop = unconfirmed
        try:
            self.jobs.reply(self.reply(parent, rpc, {"paused": True}, proceed=False))
            observed = self.final(parent)
            self.assertEqual(observed["status"], "outcome_unknown")
            self.assertFalse(observed["data"]["cleanupConfirmed"])
            self.assertFalse(observed["data"].get("stoppedByHost", False))
            self.assertFalse(Path(self.directory.name, "must-not-exist").exists())
        finally:
            kernel.handle.stop = stop
            controller.reconcile_cleanup(("node", "owner", "conversation"))

    def test_cancellation_stops_only_the_owned_cell_and_does_not_replay_source(self):
        first = self.operation("cancel", "import time\nwhile True: time.sleep(.01)")
        other = self.operation("other", "value = 42", session="other-conversation")
        self.jobs.start(first); self.jobs.start(other)
        self.final(other)
        self.jobs.cancel(first["id"])
        self.assertTrue(self.final(first)["data"]["cleanupConfirmed"])
        later = self.operation("later", "print(value)", session="other-conversation")
        self.jobs.start(later)
        self.assertEqual(self.final(later)["data"]["result"]["stdout"], "42\n")
        with self.assertRaisesRegex(ValueError, "received|terminal|already"):
            self.jobs.start(first)

    def test_closed_gate_and_wrong_resource_budget_reject_before_process_start(self):
        for change in [lambda o: o.update(resourceKey="cpu-heavy:node"),
                       lambda o: o["resourceBudget"].update(heavy=True),
                       lambda o: o["args"].update(background=True),
                       lambda o: o["args"]["pythonCell"].update(tools=["execute_code"]),
                       lambda o: o.update(capability="command")]:
            operation = self.operation("reject-" + str(len(self.operations)), "print('bad')")
            change(operation)
            with self.assertRaises(ValueError): self.jobs.start(operation)
        self.gate_open = False
        operation = self.operation("closed", "print('bad')")
        with self.assertRaisesRegex(ValueError, "gate"): self.jobs.start(operation)
        self.assertEqual(self.children, [])

    def supervisor(self, python_jobs):
        account = {"uid": 1003, "trustMode": "restricted"}
        sessions = SimpleNamespace(account=lambda executor: account)
        def no_shell(operation): self.fail("Python must never fall back to a shell service")
        runtime = SimpleNamespace(active={}, contain=lambda *args, **kwargs: True, launch=no_shell)
        helper = SimpleNamespace(gate=lambda *args: True, contain_session=lambda *args: True)
        supervisor = Supervisor({"executorId": "node", "hostId": "host", "reserveBytes": 3 * 1024**3},
            sessions, runtime, None, self.journal, None, helper,
            resource_snapshot=lambda host: {"memoryTotalBytes": 16 * 1024**3, "memoryAvailableBytes": 12 * 1024**3},
            python_jobs=python_jobs)
        supervisor.gate.handshake(2, {"paused": False, "revision": 0}, 40)
        supervisor.gate.reconciled()
        if python_jobs:
            python_jobs.guard = lambda operation: supervisor.gate.check(operation, inspection=operation.get("inspection") is True)
        return supervisor

    def test_disabled_native_surface_rejects_python_without_a_shell_fallback(self):
        supervisor = self.supervisor(None)
        operation = self.operation("disabled", "print('must not run')", received=False)
        supervisor.perform(operation)
        self.assertEqual(self.journal.get(operation["id"])["receipt"]["status"], "rejected_not_dispatched")
        self.assertEqual(self.children, [])

    def test_supervisor_receipt_retransmission_is_not_a_second_execution(self):
        supervisor = self.supervisor(self.jobs)
        operation = self.operation("native", "counter = globals().get('counter', 0) + 1\nprint(counter)", received=False)
        supervisor.perform(operation)
        self.assertEqual(self.final(operation)["data"]["result"]["stdout"], "1\n")
        supervisor.perform(operation)
        later = self.operation("native-later", "print(counter)", received=False)
        supervisor.perform(later)
        self.assertEqual(self.final(later)["data"]["result"]["stdout"], "1\n")

    def test_supervisor_pause_while_rpc_waits_finishes_without_a_lock_deadlock(self):
        supervisor = self.supervisor(self.jobs)
        parent = self.operation("pause", "from hermes_tools import read_drive\nread_drive({})", ["read_drive"], received=False)
        supervisor.perform(parent); self.pending(parent)
        worker = threading.Thread(target=lambda: supervisor.gate.pause({"paused": True, "revision": 1}), daemon=True)
        worker.start(); worker.join(timeout=2)
        self.assertFalse(worker.is_alive(), "Native gate and Python callback locks deadlocked")
        self.assertTrue(self.final(parent)["data"]["cleanupConfirmed"])

    def test_failed_initial_receipt_delivery_starts_no_process_and_leaves_no_phantom_job(self):
        def failed(): raise OSError("Receipt delivery unavailable")
        self.jobs.publish = failed
        operation = self.operation("delivery-failed", "print('must not run')")
        with self.assertRaises(OSError): self.jobs.start(operation)
        self.assertFalse(self.jobs.busy())
        self.assertTrue(self.jobs.wait(timeout=.1))
        self.assertEqual(self.children, [])

    def test_another_cell_cannot_steal_the_attached_session(self):
        first = self.operation("busy", "import time\nwhile True: time.sleep(.01)")
        self.jobs.start(first)
        other = self.operation("steal", "print('must not run')")
        with self.assertRaisesRegex(ValueError, "attached"): self.jobs.start(other)
        self.jobs.cancel(first["id"])
        self.assertTrue(self.final(first)["data"]["cleanupConfirmed"])

    def test_supervisor_accepts_the_bound_reply_once_and_publishes_its_control_receipt(self):
        supervisor = self.supervisor(self.jobs)
        parent = self.operation("supervisor-rpc", "from hermes_tools import read_drive\nprint(read_drive({})['title'])",
            ["read_drive"], received=False)
        supervisor.perform(parent); rpc = self.pending(parent)
        reply = self.reply(parent, rpc, {"title": "MovingDE"}, received=False)
        supervisor.perform(reply)
        self.assertTrue(self.journal.get(reply["id"])["receipt"]["data"]["replyAccepted"])
        self.assertEqual(self.final(parent)["data"]["result"]["stdout"], "MovingDE\n")
        supervisor.perform(reply)
        self.assertEqual(len(self.consumed), 1)

    def test_python_capability_cannot_start_or_stop_the_desktop_session(self):
        supervisor = self.supervisor(self.jobs)
        operation = self.operation("wrong-kind", "unused", received=False)
        operation.update(kind="session", args={"operation": "stop"})
        supervisor.perform(operation)
        self.assertEqual(self.journal.get(operation["id"])["receipt"]["status"], "rejected_not_dispatched")

    def test_supervisor_cancel_retains_uncertainty_and_releases_the_finished_cell_entry(self):
        supervisor = self.supervisor(self.jobs)
        parent = self.operation("cancel-native", "import time\nwhile True: time.sleep(.01)", received=False)
        supervisor.perform(parent)
        deadline = time.monotonic() + 1
        while not self.children and time.monotonic() < deadline: time.sleep(.01)
        self.assertTrue(self.children)
        cancel = {**parent, "id": "cancel-native-control", "kind": "cancel", "capability": "command",
            "args": {"operationId": parent["id"]}}
        supervisor.perform(cancel)
        observed = self.final(parent)
        self.assertEqual(observed["status"], "outcome_unknown")
        self.assertTrue(observed["data"]["cellSettled"])
        self.assertTrue(observed["data"]["stateLost"])
        self.assertTrue(observed["data"]["cleanupConfirmed"])
        self.assertTrue(self.jobs.wait(timeout=2))
        self.jobs.release(parent["id"])
        self.assertNotIn(parent["id"], self.jobs.active)


if __name__ == "__main__": unittest.main()
