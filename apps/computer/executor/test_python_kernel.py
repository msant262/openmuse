"""Actual child-interpreter tests; no model fixtures or fake tool receipts."""
import contextvars
import base64
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
import unittest

from .python_kernel import PythonKernels, KernelProcess, RUNNER_PATH
from .files import Workspace


class PythonKernelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.children = []

        def launch(scope, sentinel, cwd="/workspace"):
            # Test-only launch: the production adapter must select a registered
            # bot account, cgroup and workspace, never the API process account.
            process = subprocess.Popen(
                [sys.executable, "-I", "-u", str(RUNNER_PATH), sentinel],
                cwd=Path(self.directory.name) / cwd.removeprefix("/workspace").lstrip("/"), env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            )
            self.children.append(process)

            def stop():
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
                return True
            return KernelProcess(process, stop)

        self.kernels = PythonKernels(launch=launch, idle_seconds=30, max_sessions=4)
        self.scope = ("registered-executor", "owner", "conversation")

    def tearDown(self):
        self.kernels.close()
        self.assertTrue(all(child.poll() is not None for child in self.children))
        self.directory.cleanup()

    def run_cell(self, code, **options):
        return self.kernels.execute(self.scope, code, tools={}, should_continue=lambda: True,
                                    timeout_seconds=5, **options)

    def fresh_cell(self, code, **options):
        self.assertIn("fresh", inspect.signature(self.kernels.execute).parameters,
                      "The browser harness needs a fresh process lifecycle, not namespace reset")
        return self.run_cell(code, fresh=True, **options)

    def browser_cell(self, code, callback, session="research", **options):
        self.assertIn("browser_session", inspect.signature(self.kernels.execute).parameters,
                      "The original browser helpers need a bound native transport")
        return self.kernels.execute(self.scope, code, fresh=True, browser_session=session,
            tools={"browser_harness_rpc": callback}, should_continue=lambda: True,
            timeout_seconds=5, **options)

    def local_browser_cell(self, code, callback, **options):
        self.assertIn("local_browser", inspect.signature(self.kernels.execute).parameters,
                      "Browser driver commands must stay local instead of using the host-tool quota")
        def wrong_transport(_):
            self.fail("An internal browser command used the ordinary host-tool transport")
        return self.kernels.execute(self.scope, code, fresh=True, browser_session="research",
            tools={"browser_harness_rpc": wrong_transport}, local_browser=callback,
            should_continue=options.pop("should_continue", lambda: True), timeout_seconds=5, **options)

    def test_local_browser_types_long_text_without_consuming_tool_calls_or_retaining_text(self):
        requests = []
        text = "a" * 120
        def callback(args):
            requests.append(args)
            request = args["request"]
            if request.get("method") == "Browser.getVersion":
                return {"result": {"userAgent": "Linux"}}
            if request.get("method") == "Runtime.evaluate":
                return {"result": {"result": {"type": "boolean", "value": True}}}
            return {"result": {}}
        result = self.local_browser_cell(f"fill_input('#message', {text!r})\nprint('typed')",
                                        callback, max_tool_calls=1)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["stdout"], "typed\n")
        self.assertGreater(len(requests), 200)
        self.assertEqual(result["tool_calls"], [])
        self.assertEqual(result["browser_commands"], {
            "dispatched": len(requests), "settled": len(requests), "failed": 0,
        })
        self.assertNotIn(text, json.dumps(result))
        self.assertTrue(result["cleanup_confirmed"])

    def test_local_browser_does_not_expand_the_ordinary_tool_budget(self):
        self.assertIn("local_browser", inspect.signature(self.kernels.execute).parameters)
        calls = []
        result = self.kernels.execute(self.scope,
            "for _ in range(20):\n    goto_url('https://example.org')\n"
            "tools.call('ordinary', {})\ntools.call('ordinary', {})", fresh=True,
            browser_session="research", local_browser=lambda args: {"result": {}},
            tools={"browser_harness_rpc": lambda args: self.fail("Used host transport"),
                   "ordinary": lambda args: calls.append(args)},
            should_continue=lambda: True, timeout_seconds=5, max_tool_calls=1)
        self.assertEqual(result["status"], "error", result)
        self.assertIn("tool call budget", result["traceback"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(result["tool_calls"]), 1)
        self.assertEqual(result["browser_commands"]["settled"], 20)

    def test_local_browser_rejects_foreign_session_before_driver_dispatch(self):
        calls = []
        result = self.local_browser_cell("tools.call('browser_harness_rpc', "
            "{'session': 'foreign', 'request': {'method': 'Page.navigate'}, 'timeoutMs': 5000})",
            lambda args: calls.append(args))
        self.assertEqual(result["status"], "error", result)
        self.assertEqual(calls, [])
        self.assertIn("bound browser session", result["traceback"])

    def test_local_browser_inflight_command_blocks_replacement_after_cancellation(self):
        self.assertIn("local_browser", inspect.signature(self.kernels.execute).parameters)
        started, release, active = threading.Event(), threading.Event(), threading.Event()
        active.set()
        def callback(args):
            started.set()
            release.wait(3)
            return {"result": {}}
        results = []
        thread = threading.Thread(target=lambda: results.append(self.local_browser_cell(
            "goto_url('https://example.org')\nprint('must not resume')", callback,
            should_continue=active.is_set)))
        thread.start()
        try:
            self.assertTrue(started.wait(2))
            active.clear()
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertNotIn("must not resume", results[0]["stdout"])
            self.assertTrue(results[0]["host_call_pending"])
            self.assertTrue(results[0]["cleanup_confirmed"])
            with self.assertRaisesRegex(RuntimeError, "still pending"):
                self.fresh_cell("print('replacement must not start')")
        finally:
            release.set()
            thread.join(3)
        deadline = time.monotonic() + 2
        while self.kernels.pending_scopes and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.kernels.pending_scopes, {})

    def test_browser_helpers_are_preimported_and_use_the_current_owned_host_rpc(self):
        requests = []
        def callback(args):
            requests.append(args)
            request = args["request"]
            if request.get("meta") == "pending_dialog": return {"dialog": None}
            if request.get("method") == "Page.navigate": return {"result": {"frameId": "owned-frame"}}
            if request.get("method") == "Runtime.evaluate":
                return {"result": {"result": {"type": "string", "value": json.dumps({
                    "url": "https://example.org/owned", "title": "Owned page", "w": 1280,
                    "h": 720, "sx": 0, "sy": 0, "pw": 1280, "ph": 720,
                })}}}
            raise AssertionError(request)
        result = self.browser_cell("print(goto_url('https://example.org/owned')['frameId'])\n"
            "print(page_info()['title'])", callback)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["stdout"], "owned-frame\nOwned page\n")
        self.assertTrue(all(req["session"] == "research" and req["timeoutMs"] == 5000 for req in requests))
        self.assertEqual(len(requests), 3)
        self.assertTrue(result["cleanup_confirmed"])
        self.assertIsNotNone(self.children[0].poll())

    def test_browser_workspace_agent_helpers_and_future_imports_work_without_source_rewriting(self):
        Path(self.directory.name, "agent_helpers.py").write_text(
            "from browser_harness.helpers import js\n"
            "print('workspace helpers loaded')\n"
            "def own_title(): return js('document.title')\n")
        def callback(args):
            self.assertEqual(args["session"], "documents")
            self.assertEqual(args["request"]["params"]["expression"], "document.title")
            return {"result": {"result": {"type": "string", "value": "Owned document"}}}
        result = self.browser_cell("from __future__ import annotations\n"
            "from pathlib import Path\nPath('browser-document.txt').write_text(own_title())\n"
            "print(own_title())", callback, session="documents")
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["stdout"], "workspace helpers loaded\nOwned document\n")
        self.assertEqual(Path(self.directory.name, "browser-document.txt").read_text(), "Owned document")

    def test_original_browser_screenshot_writes_host_bytes_in_the_persistent_workspace(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=")
        def callback(args):
            self.assertEqual(args["request"]["method"], "Page.captureScreenshot")
            self.assertEqual(args["timeoutMs"], 60000)
            return {"result": {"data": base64.b64encode(png).decode()}}
        result = self.browser_cell("print(capture_screenshot('owned-page.png'))", callback)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["stdout"], "owned-page.png\n")
        self.assertEqual(Path(self.directory.name, "owned-page.png").read_bytes(), png)
        self.assertTrue(result["cleanup_confirmed"])

    def test_original_browser_helper_error_is_not_reported_as_success(self):
        result = self.browser_cell("goto_url('https://example.org/owned')\n"
            "from pathlib import Path\nPath('must-not-continue').write_text('wrong')",
            lambda args: {"error": "Native browser is controlled by the user"})
        self.assertEqual(result["status"], "error")
        self.assertIn("Native browser is controlled by the user", result["traceback"])
        self.assertFalse(Path(self.directory.name, "must-not-continue").exists())
        self.assertTrue(result["cleanup_confirmed"])

    def test_browser_bootstrap_rejects_unbound_or_persistent_source_before_launch(self):
        self.assertIn("browser_session", inspect.signature(self.kernels.execute).parameters)
        for session, fresh, tools in [
            ("../other", True, {"browser_harness_rpc": lambda args: {}}),
            ("research", False, {"browser_harness_rpc": lambda args: {}}),
            ("research", True, {}),
        ]:
            with self.assertRaisesRegex(ValueError, "browser|Browser"):
                self.kernels.execute(self.scope, "print('must not run')", browser_session=session,
                    fresh=fresh, tools=tools, should_continue=lambda: True)
        self.assertEqual(self.children, [])

    def test_fresh_calls_preserve_workspace_but_replace_process_and_all_python_state(self):
        first = self.fresh_cell("import os, sys, types, builtins\nfrom pathlib import Path\n"
            "private_value = 41\nsys.modules['owned_probe'] = types.ModuleType('owned_probe')\n"
            "os.environ['OWNED_BROWSER_PROBE'] = 'first'\nbuiltins.owned_probe = 42\n"
            "Path('browser-proof.txt').write_text('persistent workspace')\nprint(os.getpid())")
        self.assertEqual(first["status"], "ok")
        self.assertTrue(first["cleanup_confirmed"])
        self.assertTrue(first["state_lost"])
        self.assertIsNotNone(self.children[0].poll())
        second = self.fresh_cell("import os, sys, builtins\nfrom pathlib import Path\n"
            "print('private_value' in globals(), 'owned_probe' in sys.modules, "
            "'OWNED_BROWSER_PROBE' in os.environ, hasattr(builtins, 'owned_probe'))\n"
            "print(Path('browser-proof.txt').read_text())\nprint(os.getpid())")
        self.assertEqual(second["status"], "ok")
        self.assertTrue(second["cleanup_confirmed"])
        self.assertFalse(second["reused"])
        self.assertIn("False False False False\npersistent workspace\n", second["stdout"])
        self.assertNotEqual(first["stdout"].strip(), second["stdout"].strip().splitlines()[-1])
        self.assertEqual(len(self.children), 2)
        self.assertEqual(self.kernels.registry.kernels, {})

    def test_fresh_error_closes_process_and_keeps_actual_workspace_output(self):
        failed = self.fresh_cell("from pathlib import Path\nvalue = 99\n"
            "Path('before-error.txt').write_text('actual output')\nraise ValueError('owned failure')")
        self.assertEqual(failed["status"], "error")
        self.assertTrue(failed["cleanup_confirmed"])
        self.assertIn("owned failure", failed["traceback"])
        self.assertIsNotNone(self.children[0].poll())
        after = self.fresh_cell("from pathlib import Path\nprint('value' in globals())\n"
            "print(Path('before-error.txt').read_text())")
        self.assertEqual(after["stdout"], "False\nactual output\n")

    def test_fresh_success_stops_spawned_descendants_before_claiming_cleanup(self):
        result = self.fresh_cell("import subprocess\nfrom pathlib import Path\n"
            "p = subprocess.Popen(['/bin/sleep', '60'])\nPath('fresh-child-pid').write_text(str(p.pid))\n"
            "print('script finished')")
        self.assertEqual(result["stdout"], "script finished\n")
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["cleanup_confirmed"])
        pid = int(Path(self.directory.name, "fresh-child-pid").read_text())
        status = Path(f"/proc/{pid}/stat")
        self.assertTrue(not status.exists() or status.read_text().split()[2] == "Z")
        self.assertIsNotNone(self.children[0].poll())

    def test_fresh_unconfirmed_cleanup_cannot_claim_success_or_start_a_replacement(self):
        self.assertIn("fresh", inspect.signature(self.kernels.execute).parameters)
        original_launch = self.kernels.launch
        confirmed = [False]
        def launch(scope, sentinel):
            handle = original_launch(scope, sentinel)
            stop = handle.stop
            handle.stop = lambda: stop() and confirmed[0]
            return handle
        self.kernels.launch = launch
        result = self.fresh_cell("value = 42\nprint('actual script result')")
        self.assertEqual(result["stdout"], "actual script result\n")
        self.assertEqual(result["status"], "interrupted")
        self.assertFalse(result["cleanup_confirmed"])
        self.assertIn("cleanup", result["error"])
        with self.assertRaisesRegex(RuntimeError, "cleanup is unconfirmed"):
            self.fresh_cell("print('must not start')")
        self.assertEqual(len(self.children), 1)
        confirmed[0] = True
        self.assertTrue(self.kernels.reconcile_cleanup(self.scope))
        self.assertEqual(self.fresh_cell("print('value' in globals())")["stdout"], "False\n")

    def test_fresh_pending_host_call_fences_replacement_without_repeating_the_call(self):
        self.assertIn("fresh", inspect.signature(self.kernels.execute).parameters)
        entered, release = threading.Event(), threading.Event()
        active = [True]
        seen, results = [], []
        def pending(args):
            seen.append(args)
            entered.set()
            release.wait(timeout=5)
            return {"actual": "settled"}
        def run():
            results.append(self.kernels.execute(self.scope,
                "from hermes_tools import pending\npending({'owned': True})\n"
                "open('after-retirement.txt', 'w').write('must not run')",
                tools={"pending": pending}, should_continue=lambda: active[0],
                timeout_seconds=5, fresh=True))
        thread = threading.Thread(target=run)
        thread.start()
        try:
            self.assertTrue(entered.wait(timeout=2))
            active[0] = False
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(results[0]["status"], "paused")
            self.assertTrue(results[0]["cleanup_confirmed"])
            self.assertTrue(results[0]["host_call_pending"])
            with self.assertRaisesRegex(RuntimeError, "host call is still pending"):
                self.fresh_cell("print('must not start')")
            self.assertEqual(seen, [{"owned": True}])
            self.assertFalse(Path(self.directory.name, "after-retirement.txt").exists())
        finally:
            active[0] = False
            release.set()
            thread.join(timeout=3)
        deadline = time.monotonic() + 2
        while self.kernels.pending_scopes and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.fresh_cell("print('resumed')")["stdout"], "resumed\n")

    def test_host_workspace_is_used_by_real_interpreter_and_reused_on_resume(self):
        directory = Path(self.directory.name) / "cards" / "first"
        directory.mkdir(parents=True)
        first = self.run_cell("from pathlib import Path\nmarker = 41\nPath('proof.txt').write_text('owned')\nprint(Path.cwd())", cwd="/workspace/cards/first")
        self.assertEqual(first["status"], "ok")
        self.assertEqual(first["stdout"].strip(), str(directory))
        self.assertEqual((directory / "proof.txt").read_text(), "owned")
        self.assertFalse((Path(self.directory.name) / "proof.txt").exists())
        resumed = self.run_cell("print(marker + 1)", cwd="/workspace/cards/first")
        self.assertEqual(resumed["stdout"], "42\n")
        self.assertTrue(resumed["reused"])
        with self.assertRaisesRegex(ValueError, "workspace.*changed"):
            self.run_cell("print('wrong directory')", cwd="/workspace", reset=True)
        still_owned = self.run_cell("print(marker)", cwd="/workspace/cards/first")
        self.assertEqual(still_owned["stdout"], "41\n")
        self.assertEqual(len(self.children), 1)

    def test_distinct_task_sessions_keep_their_workspaces_and_globals_separate(self):
        for name in ["a", "b"]:
            (Path(self.directory.name) / name).mkdir()
            scope = (self.scope[0], self.scope[1], name)
            result = self.kernels.execute(scope, f"from pathlib import Path\nvalue = '{name}'\nPath('proof.txt').write_text(value)",
                tools={}, should_continue=lambda: True, cwd=f"/workspace/{name}")
            self.assertEqual(result["status"], "ok")
        self.assertEqual((Path(self.directory.name) / "a" / "proof.txt").read_text(), "a")
        self.assertEqual((Path(self.directory.name) / "b" / "proof.txt").read_text(), "b")
        self.assertEqual(len(self.children), 2)

    def test_invalid_workspace_is_rejected_before_any_child_is_launched(self):
        for cwd in ["relative", "/etc", "/workspace/../outside", "/workspace-other", "/workspace/a\x00b"]:
            with self.assertRaises(ValueError):
                self.run_cell("print('must not run')", cwd=cwd)
        self.assertEqual(len(self.children), 0)

    def test_variables_functions_and_imports_survive_errors_and_turns(self):
        first = self.run_cell("import math\nnumbers = [2, 3, 5]\ndef total(): return sum(numbers)\nprint(total())")
        self.assertEqual(first["stdout"], "10\n")
        failed = self.run_cell("numbers.append(7)\nraise ValueError('expected failure')")
        self.assertEqual(failed["status"], "error")
        self.assertIn("ValueError: expected failure", failed["traceback"])
        last = self.run_cell("print(total(), math.isqrt(144))")
        self.assertEqual(last["stdout"], "17 12\n")
        self.assertTrue(last["reused"])
        self.assertEqual(last["execution_count"], 3)

    def test_full_results_and_fresh_caller_context_go_through_host_rpc(self):
        identity = contextvars.ContextVar("test_identity")
        observed = []
        def read(args):
            observed.append((identity.get(), args))
            return {"numbers": list(range(20_000))}
        identity.set("turn-one")
        first = self.kernels.execute(self.scope,
            "from hermes_tools import read_sample\nvalues = read_sample({'account': 'x'})['numbers']\nprint(len(values))",
            tools={"read_sample": read}, should_continue=lambda: True)
        identity.set("turn-two")
        second = self.kernels.execute(self.scope, "print(sum(values), len(read_sample({'account': 'y'})['numbers']))",
            tools={"read_sample": read}, should_continue=lambda: True)
        self.assertEqual(first["stdout"], "20000\n")
        self.assertEqual(second["stdout"], "199990000 20000\n")
        self.assertEqual(observed, [("turn-one", {"account": "x"}), ("turn-two", {"account": "y"})])
        self.assertEqual([call["name"] for call in second["tool_calls"]], ["read_sample"])
        self.assertNotIn("result", second["tool_calls"][0])
        self.assertLess(len(json.dumps(second["tool_calls"])), 2000)

    def test_old_tool_alias_cannot_reuse_an_authorization(self):
        seen = []
        self.kernels.execute(self.scope, "from hermes_tools import change\nprint(change({}))",
            tools={"change": lambda args: seen.append(args) or {"ok": True}}, should_continue=lambda: True)
        denied = self.run_cell("change({'new': True})")
        self.assertEqual(denied["status"], "error")
        self.assertIn("not available", denied["traceback"])
        self.assertEqual(seen, [{}])

    def test_background_thread_has_no_tool_authority_in_a_later_cell(self):
        seen = []
        first = self.kernels.execute(self.scope,
            "import threading, time\nfrom hermes_tools import change\nready = threading.Event()\n"
            "def late():\n ready.wait()\n try: change({'late': True})\n except Exception: pass\n"
            "thread = threading.Thread(target=late)\nthread.start()",
            tools={"change": lambda args: seen.append(args)}, should_continue=lambda: True)
        self.assertEqual(first["status"], "ok")
        self.run_cell("ready.set()\nthread.join(timeout=1)\nprint('settled')")
        self.assertEqual(seen, [])

    def test_review_receipt_stops_the_cell_before_another_effect(self):
        observed = []
        active = [True]
        def review(args):
            observed.append("review")
            active[0] = False
            return {"paused": True, "actionId": "owned-real-host-action"}
        result = self.kernels.execute(self.scope,
            "from hermes_tools import review, change\nreview({})\nchange({})\nopen('must-not-exist', 'w').write('bad')",
            tools={"review": review, "change": lambda args: observed.append("change")},
            should_continue=lambda: active[0])
        self.assertEqual(result["status"], "paused")
        self.assertTrue(result["state_lost"])
        self.assertTrue(result["cleanup_confirmed"])
        self.assertEqual(result["tool_calls"][0]["result"]["actionId"], "owned-real-host-action")
        self.assertEqual(observed, ["review"])
        self.assertFalse(Path(self.directory.name, "must-not-exist").exists())

    def test_explicitly_copied_old_thread_context_gets_a_rejection_not_a_new_authority(self):
        seen = []
        self.kernels.execute(self.scope,
            "import contextvars, threading\nfrom hermes_tools import change\n"
            "ready = threading.Event()\nold_context = contextvars.copy_context()\nlate_result = []\n"
            "def late():\n ready.wait()\n try: change({'late': True})\n except RuntimeError as e: late_result.append(str(e))\n"
            "thread = threading.Thread(target=lambda: old_context.run(late), daemon=True)\nthread.start()",
            tools={"change": lambda args: seen.append(args)}, should_continue=lambda: True)
        result = self.kernels.execute(self.scope,
            "ready.set()\nthread.join(timeout=1)\nprint(thread.is_alive(), late_result)",
            tools={"change": lambda args: seen.append(args)}, should_continue=lambda: True)
        self.assertEqual(seen, [])
        self.assertIn("False", result["stdout"])
        self.assertIn("authority has retired", result["stdout"])

    def test_timeout_kills_child_and_reports_state_loss_without_replay(self):
        result = self.kernels.execute(self.scope, "marker = 42\nwhile True: pass", tools={},
            should_continue=lambda: True, timeout_seconds=.15)
        self.assertEqual(result["status"], "timeout")
        self.assertTrue(result["state_lost"])
        self.assertTrue(result["cleanup_confirmed"])
        self.assertIsNotNone(self.children[0].poll())
        next_cell = self.run_cell("print('marker' in globals())")
        self.assertEqual(next_cell["stdout"], "False\n")
        self.assertFalse(next_cell["reused"])

    def test_owned_namespaces_are_separate_and_reset_is_explicit(self):
        self.run_cell("secret_value = 123")
        other = self.kernels.execute(("registered-executor", "other-owner", "conversation"),
            "print('secret_value' in globals())", tools={}, should_continue=lambda: True)
        self.assertEqual(other["stdout"], "False\n")
        reset = self.run_cell("print('secret_value' in globals())", reset=True)
        self.assertEqual(reset["stdout"], "False\n")
        self.assertTrue(reset["state_reset"])

    def test_tool_budget_resets_per_cell_without_restarting_interpreter(self):
        seen = []
        options = dict(tools={"read_sample": lambda args: seen.append(args) or {"ok": True}},
                       should_continue=lambda: True, max_tool_calls=1)
        limited = self.kernels.execute(self.scope,
            "from hermes_tools import read_sample\nread_sample({'n': 1})\nread_sample({'n': 2})", **options)
        self.assertEqual(limited["status"], "error")
        self.assertIn("call budget", limited["traceback"])
        again = self.kernels.execute(self.scope, "print(read_sample({'n': 3})['ok'])", **options)
        self.assertEqual(again["stdout"], "True\n")
        self.assertTrue(again["reused"])
        self.assertEqual(seen, [{"n": 1}, {"n": 3}])

    def test_output_is_bounded_in_bytes_and_full_text_has_owned_spill(self):
        result = self.run_cell("print('á' * 10000)", output_bytes=1024)
        self.assertTrue(result["stdout_clipped"])
        self.assertLessEqual(len(result["stdout"].encode()), 1024)
        spill = Path(self.directory.name, result["stdout_spill_path"])
        self.assertEqual(spill.read_text(), "á" * 10000 + "\n")
        self.assertEqual(spill.stat().st_mode & 0o777, 0o600)

    def test_long_output_can_be_exported_by_the_ordinary_workspace_file_transport(self):
        files = Workspace(self.directory.name, Path(self.directory.name) / ".okami-state")
        self.addCleanup(files.close)
        result = self.run_cell("print('á' * 10000)", output_bytes=1024)
        path = "/workspace/" + str(Path(result["stdout_spill_path"]).relative_to(self.directory.name))
        exported = files.handle({"kind": "file", "args": {"operation": "read_binary", "path": path}})
        data = base64.b64decode(exported["base64"])
        self.assertEqual(data, ("á" * 10000 + "\n").encode())
        self.assertEqual(exported["size"], len(data))
        self.assertEqual(exported["sha256"], hashlib.sha256(data).hexdigest())
        self.assertIn(path, [entry["path"] for entry in files.list(str(Path(path).parent))["entries"]])
        # Making normal output downloadable must never open internal files.
        with self.assertRaisesRegex(ValueError, "Reserved"):
            files.read("/workspace/.okami-state/files.sqlite")

    def test_spilled_output_survives_kernel_reset_and_uses_existing_file_recovery(self):
        files = Workspace(self.directory.name, Path(self.directory.name) / ".okami-state")
        self.addCleanup(files.close)
        result = self.run_cell("print('original output ' * 200)", output_bytes=1024)
        path = "/workspace/" + str(Path(result["stdout_spill_path"]).relative_to(self.directory.name))
        self.run_cell("print('new session')", reset=True)
        source = files.handle({"kind": "file", "args": {"operation": "stat", "path": path}})
        expected = ("original output " * 200 + "\n").encode()
        self.assertEqual(files.read(path), expected)
        removed = files.trash(source["artifactId"], source["version"], task_id="owned-output-cleanup")
        with self.assertRaises(FileNotFoundError):
            files.read(path)
        recovered = files.restore(removed["id"], None)
        self.assertEqual(files.read(recovered["path"]), expected)

    def test_concurrent_cells_use_one_process_and_serialize_state_changes(self):
        results = []
        barrier = threading.Barrier(3)
        def call(value):
            barrier.wait()
            results.append(self.run_cell(f"import time\ntime.sleep(.1)\nx = globals().get('x', 0) + {value}\nprint(x)"))
        threads = [threading.Thread(target=call, args=(value,)) for value in (2, 3)]
        for thread in threads: thread.start()
        barrier.wait()
        for thread in threads: thread.join(timeout=5)
        self.assertEqual(len(results), 2)
        self.assertEqual(len(self.children), 1)
        self.assertEqual(self.run_cell("print(x)")["stdout"], "5\n")

    def test_copied_source_is_the_exact_pinned_hermes_file(self):
        source = Path(RUNNER_PATH).parent / "vendor" / "hermes_code_kernel.py"
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
            "ab88721b4a82c6b32d4160b441daccbb0e84e44c100d7bb29bcb6491a882ca5f")

    def test_raw_fd_output_does_not_swallow_the_next_response_frame(self):
        result = self.run_cell("import os\nos.write(1, b'raw without newline')\nprint('captured')")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["stdout"], "captured\n")
        self.assertIn("raw without newline", result["raw_stdout"])

    def test_invalid_frame_cannot_claim_a_successful_cell(self):
        result = self.run_cell("import os, sys\nos.write(1, ('\\n' + sys.argv[1] + ' 99999999\\n').encode())\nwhile True: pass")
        self.assertEqual(result["status"], "interrupted")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertTrue(result["state_lost"])

    def test_tool_thread_that_outlives_timeout_blocks_new_cells_until_settled(self):
        # This test times an attached host callback, not a cold interpreter
        # launch competing with other regression processes for CPU/RAM.
        self.assertEqual(self.run_cell("print('ready')")["status"], "ok")
        entered, release = threading.Event(), threading.Event()
        def pending(args):
            entered.set()
            release.wait(timeout=3)
            return {"actual": "settled"}
        try:
            result = self.kernels.execute(self.scope, "from hermes_tools import pending\npending({})",
                tools={"pending": pending}, should_continue=lambda: True, timeout_seconds=.3)
            self.assertTrue(entered.is_set())
            self.assertTrue(result["host_call_pending"])
            with self.assertRaisesRegex(RuntimeError, "still pending"):
                self.run_cell("print('must not start')")
        finally:
            release.set()
        deadline = time.monotonic() + 2
        while self.kernels.pending_scopes and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.run_cell("print('next cell')")["stdout"], "next cell\n")

    def test_full_tool_result_near_private_byte_budget_is_not_inflated_by_frame_whitespace(self):
        value = {"values": [0] * 3_000_000}
        self.assertLess(len(json.dumps({"result": value, "continue": True}, separators=(",", ":")).encode()), 8 * 1024**2 - 1024)
        observed = self.kernels.execute(self.scope, "from hermes_tools import read_sample\nprint(len(read_sample({})['values']))",
            tools={"read_sample": lambda args: value}, should_continue=lambda: True, timeout_seconds=10)
        self.assertEqual(observed["status"], "ok", observed)
        self.assertEqual(observed["stdout"], "3000000\n")

    def test_idle_reaping_and_lru_bound_only_stop_unattached_sessions(self):
        self.kernels.idle_seconds = .15
        self.run_cell("value = 1")
        deadline = time.monotonic() + 2
        while self.children[0].poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        # The reaper interval is selected at initialization; explicit acquisition
        # also sweeps idle sessions, regardless of background reaper cadence.
        next_cell = self.run_cell("print('value' in globals())")
        self.assertEqual(next_cell["stdout"], "False\n")
        self.kernels.idle_seconds = 30
        self.kernels.max_sessions = 1
        other = self.kernels.execute(("registered-executor", "owner", "other-conversation"),
            "print('other')", tools={}, should_continue=lambda: True)
        self.assertEqual(other["stdout"], "other\n")
        self.assertEqual(len(self.kernels.registry.kernels), 1)

    def test_unconfirmed_cleanup_blocks_replacement_until_exact_stop_is_confirmed(self):
        self.run_cell("value = 1")
        kernel = self.kernels.registry.kernels[self.scope]
        original_stop = kernel.handle.stop
        confirmed = [False]
        kernel.handle.stop = lambda: original_stop() and confirmed[0]
        result = self.kernels.execute(self.scope, "while True: pass", tools={},
            should_continue=lambda: True, timeout_seconds=.1)
        self.assertFalse(result["cleanup_confirmed"])
        with self.assertRaisesRegex(RuntimeError, "cleanup is unconfirmed"):
            self.run_cell("print('must not start')")
        self.assertFalse(self.kernels.reconcile_cleanup(self.scope))
        confirmed[0] = True
        self.assertTrue(self.kernels.reconcile_cleanup(self.scope))
        self.assertEqual(self.run_cell("print('reconciled')")["stdout"], "reconciled\n")

    def test_nonfinite_timeout_is_rejected_before_starting_a_process(self):
        with self.assertRaises(ValueError):
            self.kernels.execute(self.scope, "while True: pass", tools={},
                should_continue=lambda: True, timeout_seconds=float("nan"))
        self.assertEqual(self.children, [])

    def test_owner_close_during_launch_does_not_orphan_the_new_process(self):
        entered, proceed = threading.Event(), threading.Event()
        original_launch = self.kernels.launch
        def delayed_launch(scope, sentinel):
            entered.set()
            proceed.wait(timeout=2)
            return original_launch(scope, sentinel)
        self.kernels.launch = delayed_launch
        observed = []
        def execute():
            try:
                observed.append(self.run_cell("while True: pass"))
            except RuntimeError:
                pass
        cell = threading.Thread(target=execute)
        cell.start()
        self.assertTrue(entered.wait(timeout=1))
        close = threading.Thread(target=lambda: self.kernels.close("owner"))
        close.start()
        proceed.set()
        close.join(timeout=3)
        cell.join(timeout=3)
        self.assertFalse(close.is_alive())
        self.assertFalse(cell.is_alive())
        self.assertEqual(len(self.children), 1)
        self.assertIsNotNone(self.children[0].poll())
        self.assertNotIn(self.scope, self.kernels.registry.kernels)

    def test_reset_cannot_replace_a_process_with_unconfirmed_cleanup(self):
        self.run_cell("value = 1")
        kernel = self.kernels.registry.kernels[self.scope]
        stop = kernel.handle.stop
        kernel.handle.stop = lambda: stop() and False
        with self.assertRaisesRegex(RuntimeError, "cleanup is unconfirmed"):
            self.run_cell("print('must not run')", reset=True)
        self.assertEqual(len(self.children), 1)
        kernel.handle.stop = stop
        self.assertTrue(self.kernels.reconcile_cleanup(self.scope))

    def test_timeout_stops_the_process_group_including_a_spawned_descendant(self):
        result = self.kernels.execute(self.scope,
            "import subprocess, pathlib\np = subprocess.Popen(['/bin/sleep', '60'])\npathlib.Path('child-pid').write_text(str(p.pid))\nwhile True: pass",
            tools={}, should_continue=lambda: True, timeout_seconds=.3)
        self.assertEqual(result["status"], "timeout")
        pid = int(Path(self.directory.name, "child-pid").read_text())
        status = Path(f"/proc/{pid}/stat")
        self.assertTrue(not status.exists() or status.read_text().split()[2] == "Z")


if __name__ == "__main__":
    unittest.main()
