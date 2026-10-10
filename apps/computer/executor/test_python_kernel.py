"""Actual child-interpreter tests; no model fixtures or fake tool receipts."""
import contextvars
import hashlib
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


class PythonKernelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.children = []

        def launch(scope, sentinel):
            # Test-only launch: the production adapter must select a registered
            # bot account, cgroup and workspace, never the API process account.
            process = subprocess.Popen(
                [sys.executable, "-I", "-u", str(RUNNER_PATH), sentinel],
                cwd=self.directory.name, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
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
