"""Owner-scoped Hermes Python cells with fresh host RPC authority per call.

This controller never chooses an OS user or launches a shell. A trusted native
launcher must supply the fixed registered user's managed process and a stop
function that confirms its entire cgroup is empty. The API must not launch it
under its own UID. Interpreter output is data, never execution/approval proof.
"""
from __future__ import annotations

import contextvars
from dataclasses import dataclass
import json
import math
from pathlib import Path
import queue
import secrets
import subprocess
import threading
import time
from typing import Callable

from .vendor.hermes_code_kernel import KernelRegistry

RUNNER_PATH = Path(__file__).with_name("python_kernel_runner.py")
MAX_WIRE_BYTES = 8 * 1024**2


@dataclass
class KernelProcess:
    process: subprocess.Popen
    stop: Callable[[], bool]


class _Kernel:
    def __init__(self, scope, launch):
        self.scope, self.launch = scope, launch
        self.lock, self.write_lock, self.stop_lock = threading.Lock(), threading.Lock(), threading.Lock()
        self.handle = None
        self.sentinel = "@@OKAMI-PYTHON-" + secrets.token_hex(24) + "@@"
        self.responses = queue.Queue(maxsize=64)
        self.raw = bytearray()
        self.stderr = bytearray()
        self.buffer_lock = threading.Lock()
        self.attached, self.last_used = 0, time.monotonic()
        self.closed, self.cleanup_confirmed = False, False

    def dead(self):
        return self.closed or self.handle is not None and self.handle.process.poll() is not None

    def spawn(self):
        # Owner teardown must not race a launch and lose its new process.
        with self.stop_lock:
            if self.closed:
                raise RuntimeError("Python session has been closed")
            if self.handle is not None:
                return
            self.handle = self.launch(self.scope, self.sentinel)
            threading.Thread(target=self._read, daemon=True, name="python-private-output").start()
            threading.Thread(target=self._read_stderr, daemon=True, name="python-private-stderr").start()

    def _push(self, value):
        while not self.closed:
            try:
                self.responses.put(value, timeout=.05)
                return
            except queue.Full:
                pass

    def _read(self):
        stream = self.handle.process.stdout
        try:
            while not self.closed:
                line = stream.readline(4096)
                if not line:
                    self._push({"kind": "dead"})
                    return
                prefix = (self.sentinel + " ").encode()
                if not line.startswith(prefix):
                    with self.buffer_lock:
                        self.raw.extend(line[:max(0, 131072 - len(self.raw))])
                    continue
                size = int(line[len(prefix):].strip())
                if not 0 < size <= MAX_WIRE_BYTES:
                    raise ValueError("Invalid Python frame length")
                body = bytearray()
                while len(body) < size:
                    part = stream.read(size - len(body))
                    if not part:
                        raise ValueError("Incomplete Python frame")
                    body.extend(part)
                value = json.loads(body)
                if not isinstance(value, dict):
                    raise ValueError("Invalid Python frame")
                self._push(value)
        except (OSError, ValueError):
            self._push({"kind": "protocol_error"})

    def _read_stderr(self):
        try:
            while not self.closed:
                chunk = self.handle.process.stderr.read1(4096)
                if not chunk:
                    return
                with self.buffer_lock:
                    self.stderr.extend(chunk[:max(0, 131072 - len(self.stderr))])
        except (OSError, ValueError):
            pass

    def send(self, value):
        encoded = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode()
        if len(encoded) > MAX_WIRE_BYTES:
            raise ValueError("Python message exceeds the private transport limit")
        with self.write_lock:
            if self.closed:
                return
            self.handle.process.stdin.write(encoded)
            self.handle.process.stdin.flush()

    def teardown(self):
        with self.stop_lock:
            if self.closed and self.cleanup_confirmed:
                return self.cleanup_confirmed
            self.closed = True
            if self.handle is None:
                self.cleanup_confirmed = True
            else:
                try:
                    self.cleanup_confirmed = self.handle.stop() is True
                except Exception:
                    self.cleanup_confirmed = False
                # Buffered stdout.close() can wait for a reader lock forever
                # if a failed containment attempt left the process alive.
                if self.handle.process.poll() is not None:
                    for stream in (self.handle.process.stdin, self.handle.process.stdout, self.handle.process.stderr):
                        try:
                            stream.close()
                        except (OSError, ValueError):
                            pass
            return self.cleanup_confirmed


class _Authority:
    def __init__(self, tools, should_continue, maximum):
        self.tools, self.should_continue, self.maximum = dict(tools), should_continue, maximum
        self.context = contextvars.copy_context()
        self.active, self.inflight, self.calls = True, False, []
        self.lock = threading.Lock()

    def retire(self):
        with self.lock:
            self.active = False


class PythonKernels:
    def __init__(self, *, launch, idle_seconds=1800, max_sessions=4):
        if not callable(launch) or idle_seconds <= 0 or max_sessions < 1:
            raise ValueError("A trusted native launcher and positive lifecycle budgets are required")
        self.launch, self.idle_seconds, self.max_sessions = launch, idle_seconds, max_sessions
        self.registry = KernelRegistry(lambda kernel: kernel.teardown())
        self.pending_scopes = {}
        self.uncertain_kernels = {}
        self.closed = threading.Event()
        self.reaper = threading.Thread(target=self._reap, daemon=True, name="python-idle-reaper")
        self.reaper.start()

    def _acquire(self, scope, reset):
        if not isinstance(scope, tuple) or len(scope) != 3 or any(not isinstance(v, str) or not 1 <= len(v) <= 1024 for v in scope):
            raise ValueError("Python requires a trusted executor, owner and conversation scope")
        expired = []
        with self.registry.lock:
            if self.closed.is_set():
                raise RuntimeError("Python controller is closed")
            if self.pending_scopes.get(scope):
                raise RuntimeError("Prior Python host call is still pending; reconcile its receipt before another cell")
            if scope in self.uncertain_kernels:
                raise RuntimeError("Prior Python process cleanup is unconfirmed; reconcile the exact native unit before another cell")
            now = time.monotonic()
            for key, item in list(self.registry.kernels.items()):
                if item.attached == 0 and now - item.last_used >= self.idle_seconds:
                    expired.append(self.registry.kernels.pop(key))
            kernel = self.registry.kernels.get(scope)
            state_reset = kernel is not None and (reset or kernel.dead())
            if state_reset:
                if kernel.attached:
                    raise RuntimeError("Cannot reset a Python session with attached cells")
                expired.append(self.registry.kernels.pop(scope))
                kernel = None
            if kernel is None:
                if len(self.registry.kernels) >= self.max_sessions:
                    candidates = [item for item in self.registry.kernels.values() if item.attached == 0]
                    if not candidates:
                        raise RuntimeError("Native Python session capacity is busy; wait for an existing cell")
                    oldest = min(candidates, key=lambda item: item.last_used)
                    expired.append(self.registry.kernels.pop(oldest.scope))
                kernel = self.registry.kernels[scope] = _Kernel(scope, self.launch)
            kernel.attached += 1
            kernel.last_used = now
        for item in expired:
            self._stop(item)
        # Teardown happens outside the registry lock, as upstream requires.
        # A failed stop must still fence a replacement chosen before teardown.
        with self.registry.lock:
            if scope in self.uncertain_kernels or len(self.registry.kernels) + len(self.uncertain_kernels) > self.max_sessions:
                kernel.attached -= 1
                if kernel.attached == 0 and kernel.handle is None and self.registry.kernels.get(scope) is kernel:
                    self.registry.kernels.pop(scope)
                raise RuntimeError("Prior Python process cleanup is unconfirmed; reconcile the exact native unit before another cell")
        return kernel, state_reset

    def _stop(self, kernel):
        confirmed = kernel.teardown()
        if not confirmed:
            with self.registry.lock:
                self.uncertain_kernels[kernel.scope] = kernel
        return confirmed

    def reconcile_cleanup(self, scope):
        """Inspect/stop the SAME managed unit; never start or replay any cell."""
        with self.registry.lock:
            kernel = self.uncertain_kernels.get(scope)
        if kernel is None:
            return True
        if not kernel.teardown():
            return False
        with self.registry.lock:
            if self.uncertain_kernels.get(scope) is kernel:
                self.uncertain_kernels.pop(scope)
        return True

    def stop_scope(self, scope):
        """Stop this exact conversation, including an attached cell; no replay."""
        with self.registry.lock:
            kernel = self.registry.kernels.get(scope) or self.uncertain_kernels.get(scope)
        if kernel is None:
            return True
        confirmed = self._stop(kernel)
        self.registry.discard(scope, kernel)
        if confirmed:
            with self.registry.lock:
                if self.uncertain_kernels.get(scope) is kernel:
                    self.uncertain_kernels.pop(scope)
        return confirmed

    def _release(self, kernel):
        with self.registry.lock:
            kernel.attached -= 1
            kernel.last_used = time.monotonic()

    def _reap(self):
        interval = min(30, max(.1, self.idle_seconds / 2))
        while not self.closed.wait(interval):
            with self.registry.lock:
                expired = [self.registry.kernels.pop(key) for key, item in list(self.registry.kernels.items())
                           if item.attached == 0 and time.monotonic() - item.last_used >= self.idle_seconds]
            for kernel in expired:
                self._stop(kernel)

    def close(self, owner=None):
        if owner is None:
            self.closed.set()
        # Upstream treats key[0] as owner. Our key includes executor identity,
        # so exact owner filtering happens explicitly rather than broadening scope.
        with self.registry.lock:
            kernels = [self.registry.kernels.pop(key) for key in list(self.registry.kernels)
                       if owner is None or key[1] == owner]
            kernels.extend(item for key, item in self.uncertain_kernels.items()
                           if owner is None or key[1] == owner)
        for kernel in kernels:
            self._stop(kernel)
            if kernel.cleanup_confirmed:
                with self.registry.lock:
                    if self.uncertain_kernels.get(kernel.scope) is kernel:
                        self.uncertain_kernels.pop(kernel.scope)
        if owner is None:
            self.reaper.join(timeout=1)

    def execute(self, scope, code, *, tools, should_continue, timeout_seconds=300,
                max_tool_calls=100, reset=False, output_bytes=131072):
        if not isinstance(code, str) or not 1 <= len(code) <= 200000:
            raise ValueError("Python cell code must contain 1–200000 characters")
        if (not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool)
                or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 1800
                or not isinstance(max_tool_calls, int) or isinstance(max_tool_calls, bool) or not 1 <= max_tool_calls <= 200
                or not isinstance(output_bytes, int) or isinstance(output_bytes, bool) or not 256 <= output_bytes <= 131072
                or not isinstance(tools, dict) or any(not isinstance(name, str) or not callable(tool) for name, tool in tools.items())
                or not callable(should_continue) or not isinstance(reset, bool)):
            raise ValueError("Invalid Python cell time, call or output budget")
        kernel, state_reset = self._acquire(scope, reset)
        authority = _Authority(tools, should_continue, max_tool_calls)
        identity = secrets.token_hex(24)
        start = time.monotonic()
        result = dict(reused=False, state_reset=state_reset, state_lost=False,
                      cleanup_confirmed=False, stdout="", stderr="")
        try:
            # Waiting for another cell consumes this request's timeout, too.
            while not kernel.lock.acquire(timeout=.05):
                if time.monotonic() - start >= timeout_seconds or not should_continue():
                    result.update(status="not_started", error="Cell did not acquire its session before its deadline or cancellation")
                    return result
            try:
                if not should_continue():
                    result.update(status="not_started", error="Cell authority is no longer active")
                    return result
                result["reused"] = kernel.handle is not None and not kernel.dead()
                kernel.spawn()
                with kernel.buffer_lock:
                    kernel.raw.clear()
                    kernel.stderr.clear()
                kernel.send(dict(kind="cell", id=identity, code=code, tools=list(tools), output_bytes=output_bytes))
                while True:
                    if kernel.closed:
                        result["status"] = "interrupted"
                        break
                    if self.closed.is_set() or not should_continue():
                        result["status"] = "paused"
                        break
                    if time.monotonic() - start >= timeout_seconds:
                        result["status"] = "timeout"
                        break
                    try:
                        frame = kernel.responses.get(timeout=.05)
                    except queue.Empty:
                        continue
                    if frame.get("kind") in ("dead", "protocol_error"):
                        result["status"] = "interrupted"
                        break
                    if frame.get("cell_id") != identity:
                        # Old or forged cell identities never gain current authority.
                        if (frame.get("kind") == "tool_call" and isinstance(frame.get("cell_id"), str)
                                and len(frame["cell_id"]) <= 128 and isinstance(frame.get("id"), str)
                                and len(frame["id"]) <= 128):
                            kernel.send(dict(kind="rpc_reply", cell_id=frame["cell_id"], id=frame["id"],
                                             error="This Python cell authority has retired"))
                        continue
                    if frame.get("kind") == "tool_call":
                        self._dispatch(kernel, authority, identity, frame)
                        continue
                    if frame.get("kind") == "result":
                        with authority.lock:
                            if authority.inflight:
                                result["status"] = "interrupted"
                                break
                        result.update({key: value for key, value in frame.items()
                                       if key in ("status", "stdout", "stderr", "stdout_clipped", "stderr_clipped",
                                                  "traceback", "execution_count", "stdout_spill_path", "spill_clipped")})
                        if result["status"] not in ("ok", "error", "exit"):
                            result["status"] = "interrupted"
                        # The child can forge its own output frames. Shape and
                        # byte budgets remain a host responsibility.
                        for key in ("stdout", "stderr", "traceback"):
                            value = result.get(key, "")
                            if not isinstance(value, str):
                                result["status"] = "interrupted"
                                result[key] = ""
                            else:
                                encoded = value.encode(errors="replace")
                                result[key] = encoded[:output_bytes].decode(errors="ignore")
                                if len(encoded) > output_bytes:
                                    result[key + "_clipped"] = True
                        break
                if result["status"] not in ("ok", "error"):
                    # Review/input pauses cannot execute later source lines. A
                    # fresh cell may continue only from settled ordinary receipts.
                    authority.retire()
                    result["cleanup_confirmed"] = self._stop(kernel)
                    result["state_lost"] = True
                    self.registry.discard(scope, kernel)
                with kernel.buffer_lock:
                    result["raw_stdout"] = bytes(kernel.raw).decode(errors="replace")
                    result["raw_stderr"] = bytes(kernel.stderr).decode(errors="replace")
                return result
            finally:
                kernel.lock.release()
        except Exception:
            authority.retire()
            self._stop(kernel)
            self.registry.discard(scope, kernel)
            raise
        finally:
            authority.retire()
            with authority.lock:
                result["tool_calls"] = [dict(item) for item in authority.calls]
                result["host_call_pending"] = authority.inflight
            result["duration_seconds"] = round(time.monotonic() - start, 3)
            self._release(kernel)

    def _dispatch(self, kernel, authority, identity, frame):
        name, args, call_id = frame.get("name"), frame.get("args"), frame.get("id")
        error = None
        with authority.lock:
            if not authority.active or not authority.should_continue():
                error = "This Python cell authority has retired"
            elif not isinstance(name, str) or name not in authority.tools:
                error = "Tool is not available in this cell"
            elif not isinstance(args, dict) or not isinstance(call_id, str) or not 1 <= len(call_id) <= 128:
                error = "Invalid Python tool call"
            elif authority.inflight:
                error = "Another tool call is still pending in this cell"
            elif len(authority.calls) >= authority.maximum:
                error = "Python tool call budget reached for this cell"
            if error is None:
                # Exact args/results belong in the ordinary host journal, not
                # a second unbounded in-memory transcript. Python still receives
                # the full result through the private reply below.
                preview = json.dumps(args, ensure_ascii=False)[:500]
                entry = dict(id=call_id, name=name, args_preview=preview, status="running")
                authority.calls.append(entry)
                authority.inflight = True
        if error is not None:
            kernel.send(dict(kind="rpc_reply", cell_id=identity, id=call_id, error=error))
            return
        with self.registry.lock:
            self.pending_scopes[kernel.scope] = self.pending_scopes.get(kernel.scope, 0) + 1

        def run():
            response = dict(kind="rpc_reply", cell_id=identity, id=call_id)
            try:
                # Context comes from this cell's caller, never the spawning cell.
                def execute():
                    if not authority.active or not authority.should_continue():
                        raise RuntimeError("Python cell authority retired before dispatch")
                    return authority.tools[name](args)
                value = authority.context.run(execute)
                # Bound the transport before claiming the host result was sent.
                encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
                with authority.lock:
                    entry.update(status="settled", result_preview=encoded[:1000].decode(errors="ignore"))
                    if not authority.should_continue():
                        if len(encoded) <= 16384:
                            entry["result"] = value
                        else:
                            entry["result_clipped"] = True
                            if isinstance(value, dict):
                                entry["result"] = {key: item for key, item in value.items()
                                    if key in ("status", "paused", "actionId", "taskId", "operationId", "outcomeUnknown", "dispatched")
                                    and isinstance(item, (str, int, bool, type(None)))
                                    and (not isinstance(item, str) or len(item) <= 2000)}
                if len(encoded) > MAX_WIRE_BYTES - 1024:
                    raise ValueError("Host tool output exceeds the Python transport; recover the ordinary preserved tool output")
                response["result"] = value
            except Exception as error:
                with authority.lock:
                    entry.update(status="error", error=str(error)[:2000])
                response["error"] = str(error)[:2000]
            finally:
                with authority.lock:
                    authority.inflight = False
                with self.registry.lock:
                    self.pending_scopes[kernel.scope] -= 1
                    if self.pending_scopes[kernel.scope] == 0:
                        self.pending_scopes.pop(kernel.scope)
            # Do not unblock the interpreter after a review or cancelled task.
            if authority.active and authority.should_continue():
                try:
                    kernel.send(response)
                except (OSError, ValueError):
                    pass
        threading.Thread(target=run, daemon=True, name="python-host-call").start()
