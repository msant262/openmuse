"""Unprivileged persistent interpreter. Every frame is untrusted cell data.

The original Hermes cell engine is reused; the app owns the private pipe and
per-cell tool catalog. No server credential, owner selector or approval flag
is provided to this process. The registered native unit supplies containment.
"""
import contextlib
import contextvars
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
import traceback
import types
import uuid


source = Path(__file__).parent / "vendor" / "hermes_code_kernel.py"
spec = importlib.util.spec_from_file_location("_hermes_cell_source", source)
upstream = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)

MAX_WIRE_BYTES = 8 * 1024**2
SPILL_BYTES = 5 * 1024**2
authority = contextvars.ContextVar("python_cell_authority", default=None)
frames = queue.Queue(maxsize=8)
pending = {}
pending_lock, output_lock = threading.Lock(), threading.Lock()
sentinel = sys.argv[1]
original_input = sys.stdin.buffer


def send(value):
    body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
    if len(body) > MAX_WIRE_BYTES:
        raise ValueError("Python frame exceeds the private transport limit")
    # A cell can write directly to fd 1 without a newline. Preserve the
    # upstream leading newline so that raw output cannot swallow a frame.
    message = ("\n" + sentinel + " " + str(len(body)) + "\n").encode() + body
    with output_lock:
        view = memoryview(message)
        while view:
            view = view[os.write(1, view):]


def receive():
    while True:
        line = original_input.readline(MAX_WIRE_BYTES + 1)
        if not line:
            # Stdin EOF is also checked during a cell by this dedicated reader.
            # Production uses BindsTo plus KillMode=control-group for descendants.
            os._exit(0)
        if len(line) > MAX_WIRE_BYTES:
            os._exit(2)
        try:
            value = json.loads(line)
            if value.get("kind") == "cell":
                frames.put(value)
            elif value.get("kind") == "rpc_reply":
                with pending_lock:
                    target = pending.get((value.get("cell_id"), value.get("id")))
                if target is not None:
                    target.put(value)
        except (TypeError, ValueError):
            os._exit(2)


def current_authority():
    value = authority.get()
    if value is None:
        raise RuntimeError("This thread has no active Python cell tool authority")
    return value


def call_tool(name, args=None, **kwargs):
    cell_id, names = current_authority()
    if name not in names:
        raise RuntimeError(f"Tool {name!r} is not available in this cell")
    if args is not None and kwargs:
        raise TypeError("Supply an argument object or keyword arguments")
    args = kwargs if args is None else args
    if not isinstance(args, dict):
        raise TypeError("Tool arguments must be an object")
    identity, response = uuid.uuid4().hex, queue.Queue(maxsize=1)
    with pending_lock:
        pending[(cell_id, identity)] = response
    try:
        send({"kind": "tool_call", "cell_id": cell_id, "id": identity, "name": name, "args": args})
        value = response.get()
        if "error" in value:
            raise RuntimeError(value["error"])
        return value.get("result")
    finally:
        with pending_lock:
            pending.pop((cell_id, identity), None)


class ToolAPI(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        if name not in current_authority()[1]:
            raise AttributeError(f"Tool {name!r} is not available in this cell")
        return lambda args=None, **kwargs: call_tool(name, args, **kwargs)

    def list(self):
        return sorted(current_authority()[1])

    def call(self, name, args=None, **kwargs):
        return call_tool(name, args, **kwargs)


tools = ToolAPI("hermes_tools")
sys.modules["hermes_tools"] = tools
cell = dict(io=io, contextlib=contextlib, traceback=traceback,
            __builtins__=__builtins__, _CAPTURE_LIMIT=128 * 1024)
exec(upstream.RUNNER_CELL_SOURCE, cell)
cell["GLOBALS"]["tools"] = tools


def clip(text):
    limit = cell["_CAPTURE_LIMIT"]
    encoded = text.encode("utf-8", errors="replace")
    return encoded[:limit].decode("utf-8", errors="ignore"), len(encoded) > limit


# This is the only override of the copied cell core: cap UTF-8 by bytes.
cell["_clip"] = clip


def spill(text):
    # Fixed owned cwd, exclusive leaves, no overwrite of a user's document.
    directory = Path(tempfile.mkdtemp(prefix=".okami-python-output-", dir=workspace))
    target = directory / "stdout.txt"
    encoded = text.encode("utf-8", errors="replace")
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as out:
        out.write(encoded[:SPILL_BYTES])
    return str(target), len(encoded) > SPILL_BYTES


workspace = Path.cwd()
threading.Thread(target=receive, name="python-private-input", daemon=True).start()
execution_count = 0
while True:
    request = frames.get()
    execution_count += 1
    cell["_CAPTURE_LIMIT"] = request["output_bytes"]
    binding = authority.set((request["id"], frozenset(request["tools"])))
    try:
        result, full_stdout = cell["run_cell"](request, execution_count)
        result["kind"] = "result"
        result["cell_id"] = request["id"]
        result["traceback"] = clip(result["traceback"])[0]
        if result["stdout_clipped"]:
            result["stdout_spill_path"], result["spill_clipped"] = spill(full_stdout)
        send(result)
        if result["status"] == "exit":
            break
    finally:
        authority.reset(binding)
