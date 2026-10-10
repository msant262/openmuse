"""Private native Python cells and host RPC, bound to canonical envelopes.

The root coordinator creates RPC sequence identities, not the interpreter.
Replies contain only a bounded private delivery reference in durable journals;
the actual host dispatcher owns provider receipts and approval decisions.
"""
from dataclasses import dataclass, field
import hashlib
import json
import re
import threading
import time
import uuid

from .python_kernel import PythonKernels, MAX_WIRE_BYTES


def python_resource_key(executor_id, owner, session_id):
    raw = json.dumps([executor_id, owner, session_id], ensure_ascii=False, separators=(",", ":"))
    return "python-session:" + hashlib.sha256(raw.encode()).hexdigest()


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def validate_cell(operation):
    if operation.get("kind") != "command" or operation.get("capability") != "python" or operation.get("inspection") is not False:
        raise ValueError("Python requires its own mutating native capability")
    args = operation.get("args", {})
    if (set(args) != {"command", "cwd", "timeoutMs", "background", "pythonCell"}
            or args.get("command") != "Python cell" or args.get("cwd") != "/workspace"
            or args.get("background") is not False or not _integer(args.get("timeoutMs"), 1, 900000)):
        raise ValueError("Invalid private Python command envelope")
    cell = args.get("pythonCell")
    if not isinstance(cell, dict) or set(cell) != {"owner", "sessionId", "code", "tools", "reset", "maxToolCalls", "outputBytes"}:
        raise ValueError("Invalid private Python cell")
    if (any(not isinstance(cell[key], str) or not 1 <= len(cell[key]) <= 256 for key in ("owner", "sessionId"))
            or not isinstance(cell["code"], str) or not 1 <= len(cell["code"]) <= 200000
            or type(cell["reset"]) is not bool or not _integer(cell["maxToolCalls"], 1, 200)
            or not _integer(cell["outputBytes"], 256, 131072)
            or not isinstance(cell["tools"], list) or len(cell["tools"]) > 512
            or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,255}", name)
                   or name == "execute_code" for name in cell["tools"])
            or len(set(cell["tools"])) != len(cell["tools"])):
        raise ValueError("Invalid Python source, tool catalog or budgets")
    budget = operation.get("resourceBudget", {})
    if (set(budget) != {"memoryBytes", "heavy"} or budget.get("heavy") is not False
            or not _integer(budget.get("memoryBytes"), 16 * 1024**2, 1024**4)
            or operation.get("resourceKey") != python_resource_key(operation["executorId"], cell["owner"], cell["sessionId"])):
        raise ValueError("Python requires its owned session lease and admitted memory budget")
    return cell


def validate_reply(operation):
    args = operation.get("args", {})
    if (operation.get("kind") != "session" or operation.get("capability") != "python"
            or operation.get("inspection") is not True or set(args) != {
                "operation", "operationId", "requestSequence", "requestHash", "replyReference", "replyHash", "replyBytes"}
            or args.get("operation") != "python-reply"
            or not isinstance(args.get("operationId"), str) or not 1 <= len(args["operationId"]) <= 128
            or not _integer(args.get("requestSequence"), 1, 200)
            or any(not isinstance(args.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", args[key])
                   for key in ("requestHash", "replyHash"))
            or not _integer(args.get("replyBytes"), 1, MAX_WIRE_BYTES - 1024)):
        raise ValueError("Invalid private Python reply envelope")
    if not isinstance(args["replyReference"], str) or str(uuid.UUID(args["replyReference"])) != args["replyReference"]:
        raise ValueError("Invalid Python reply reference")
    return args


@dataclass
class _Cell:
    operation: dict
    scope: tuple
    controller: PythonKernels
    cancelled: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None
    sequence: int = 0
    pending: dict | None = None
    paused: bool = False
    finished: bool = False


class NativePythonJobs:
    def __init__(self, executor_id, journal, *, guard, consume, launch_factory,
                 publish=lambda: None, stopped_scope=lambda scope: True, idle_seconds=1800, max_sessions=4):
        self.executor_id, self.journal, self.guard, self.consume = executor_id, journal, guard, consume
        self.launch_factory, self.publish = launch_factory, publish
        self.stopped_scope = stopped_scope
        self.idle_seconds, self.max_sessions = idle_seconds, max_sessions
        self.active, self.controllers, self.last_scope_job = {}, {}, {}
        self.lock = threading.RLock()

    def _continue(self, job):
        if job.cancelled.is_set() or job.paused: return False
        try:
            self.guard(job.operation)
            return True
        except Exception:
            return False

    def _record(self, job, status, data):
        self.journal.receipt(job.operation["id"], {"status": status, "data": data})
        # Delivery may fail after the durable commit. The watchdog owns that
        # failure; never turn an observation retry into a repeated cell.
        self.publish()

    def start(self, operation):
        cell = validate_cell(operation)
        if operation["executorId"] != self.executor_id:
            raise ValueError("Python belongs to another registered executor")
        received = self.journal.get(operation["id"])
        if received["operation"] != operation or received["receipt"] is not None:
            raise ValueError("Python requires an unchanged received operation with no prior receipt")
        self.guard(operation)
        scope = (self.executor_id, cell["owner"], cell["sessionId"])
        memory = operation["resourceBudget"]["memoryBytes"]
        with self.lock:
            if operation["id"] in self.active:
                raise ValueError("Python operation is already active")
            if any(job.scope == scope and not job.finished for job in self.active.values()):
                raise ValueError("Python conversation already has an attached native cell")
            existing = self.controllers.get(cell["owner"])
            if existing and existing[1] != memory:
                raise ValueError("Python session memory binding changed; stop its owned sessions first")
            if existing and existing[0].closed.is_set():
                if existing[0].uncertain_kernels or existing[0].pending_scopes:
                    raise ValueError("Python containment or host receipts remain pending")
                self.controllers.pop(cell["owner"])
                existing = None
            if not existing:
                controller = PythonKernels(launch=self.launch_factory(cell["owner"], memory),
                    idle_seconds=self.idle_seconds, max_sessions=self.max_sessions)
                self.controllers[cell["owner"]] = (controller, memory)
            else: controller = existing[0]
            job = _Cell(operation, scope, controller)
            self.active[operation["id"]] = job
            self.last_scope_job[scope] = operation["id"]
            job.thread = threading.Thread(target=self._run, args=(job, cell), daemon=True, name="native-python-cell")
        try:
            self._record(job, "running", {"cellSettled": False, "cleanupConfirmed": False})
            job.thread.start()
        except Exception:
            with self.lock:
                job.cancelled.set()
                job.finished = True
                self.active.pop(operation["id"], None)
                if self.last_scope_job.get(scope) == operation["id"]: self.last_scope_job.pop(scope)
            raise

    def _run(self, job, cell):
        try:
            tools = {name: lambda args, name=name: self._rpc(job, name, args) for name in cell["tools"]}
            result = job.controller.execute(job.scope, cell["code"], tools=tools,
                should_continue=lambda: self._continue(job), timeout_seconds=job.operation["args"]["timeoutMs"] / 1000,
                reset=cell["reset"], max_tool_calls=cell["maxToolCalls"], output_bytes=cell["outputBytes"])
            status = ("succeeded" if result["status"] == "ok" else "failed" if result["status"] in ("error", "not_started")
                      else "outcome_unknown")
            self._record(job, status, {"result": result, "cellSettled": True,
                "cleanupConfirmed": result.get("cleanup_confirmed") is True,
                "stateLost": result.get("state_lost") is True,
                "hostCallPending": result.get("host_call_pending") is True})
        except Exception as error:
            confirmed = job.controller.stop_scope(job.scope) and self.stopped_scope(job.scope)
            self._record(job, "outcome_unknown", {"cellSettled": True, "cleanupConfirmed": confirmed,
                "stateLost": True,
                "error": type(error).__name__ + ": " + str(error)[:500]})
        finally:
            with self.lock:
                job.finished = True
                if job.pending: job.pending["event"].set()

    def _rpc(self, job, name, args):
        self.guard(job.operation)
        raw = json.dumps({"name": name, "args": args}, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(raw.encode()) > MAX_WIRE_BYTES - 1024:
            raise ValueError("Python tool request exceeds the private transport budget")
        with self.lock:
            if job.cancelled.is_set() or job.paused or job.pending:
                raise ValueError("Python host request is retired or another request is pending")
            job.sequence += 1
            request = {"sequence": job.sequence, "json": raw, "sha256": hashlib.sha256(raw.encode()).hexdigest()}
            pending = job.pending = {"request": request, "event": threading.Event(), "reply": None}
        self._record(job, "running", {"pythonRpc": request, "cellSettled": False, "cleanupConfirmed": False})
        try:
            while not pending["event"].wait(.05):
                if not self._continue(job): raise ValueError("Python host request authority retired")
            value = pending["reply"]
            if value is None: raise ValueError("Python host request retired without an authorized reply")
            if value["continue"] is False: job.paused = True
            if "error" in value: raise RuntimeError(value["error"])
            return value["result"]
        finally:
            with self.lock:
                if job.pending is pending: job.pending = None

    def _reply_target(self, operation, args):
        job = self.active.get(args["operationId"])
        if (not job or job.finished or not job.pending or job.pending["reply"] is not None
                or job.cancelled.is_set() or job.paused):
            raise ValueError("Python reply has no current pending request; its authority retired")
        if any(operation.get(key) != job.operation.get(key) for key in
               ("executorId", "taskId", "revision", "executorEpoch", "resourceFence", "resourceKey")):
            raise ValueError("Python reply does not own the current cell envelope")
        request = job.pending["request"]
        if args["requestSequence"] != request["sequence"] or args["requestHash"] != request["sha256"]:
            raise ValueError("Python reply does not own the current request identity")
        return job

    def reply(self, operation):
        args = validate_reply(operation)
        received = self.journal.get(operation["id"])
        if received["operation"] != operation or received["receipt"] is not None:
            raise ValueError("Python reply requires its unchanged received control operation")
        self.guard(operation)
        with self.lock: job = self._reply_target(operation, args)
        self.guard(job.operation)
        payload = self.consume("python-replies/" + args["replyReference"] + "/consume", {
            "epoch": operation["executorEpoch"], "operationId": operation["id"],
            "parentOperationId": args["operationId"], "requestSequence": args["requestSequence"]})
        raw = payload.get("json")
        if (not isinstance(raw, str) or len(raw.encode()) != args["replyBytes"]
                or hashlib.sha256(raw.encode()).hexdigest() != args["replyHash"]):
            raise ValueError("Private Python reply digest/binding changed")
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) not in ({"result", "continue"}, {"error", "continue"})
                or type(value.get("continue")) is not bool
                or "error" in value and (not isinstance(value["error"], str) or len(value["error"]) > 2000)):
            raise ValueError("Invalid private Python reply payload")
        self.guard(operation)
        self.guard(job.operation)
        with self.lock:
            job = self._reply_target(operation, args)
            job.pending["reply"] = value
            job.pending["event"].set()
        return {"parentOperationId": args["operationId"], "requestSequence": args["requestSequence"],
                "replyAccepted": True, "continue": value["continue"]}

    def cancel(self, operation_id):
        with self.lock:
            job = self.active.get(operation_id)
            if not job or self.last_scope_job.get(job.scope) != operation_id:
                raise ValueError("Python cancellation no longer owns this conversation's process")
            job.cancelled.set()
            if job.pending: job.pending["event"].set()
        return job.controller.stop_scope(job.scope) and self.stopped_scope(job.scope)

    def contain(self):
        with self.lock:
            jobs, controllers = list(self.active.values()), [value[0] for value in self.controllers.values()]
            for job in jobs:
                job.cancelled.set()
                if job.pending: job.pending["event"].set()
        for controller in controllers: controller.close()
        return all(not controller.uncertain_kernels for controller in controllers)

    def wait(self, timeout=5):
        deadline = time.monotonic() + timeout
        with self.lock: threads = [job.thread for job in self.active.values() if job.thread and job.thread.ident is not None]
        for thread in threads: thread.join(timeout=max(0, deadline - time.monotonic()))
        return all(not thread.is_alive() for thread in threads)

    def release(self, operation_id):
        with self.lock:
            job = self.active.get(operation_id)
            if job and job.finished and not job.pending:
                self.active.pop(operation_id)
                if self.last_scope_job.get(job.scope) == operation_id:
                    self.last_scope_job.pop(job.scope)

    def busy(self):
        with self.lock: return any(not job.finished for job in self.active.values())
