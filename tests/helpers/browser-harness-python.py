"""Local integration peer for copied helpers and actual managed child cleanup.

The Node test owns isolated Chromium and handles private browser commands.
No API credential, model call, app user data or production browser is used.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "computer"))
from executor.python_kernel import KernelProcess, PythonKernels, RUNNER_PATH


children = []
with tempfile.TemporaryDirectory(prefix="okami-sdk-peer-") as directory:
    def launch(scope, sentinel, cwd="/workspace"):
        process = subprocess.Popen([sys.executable, "-I", "-u", str(RUNNER_PATH), sentinel],
            cwd=directory, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        children.append(process)
        def stop():
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=3)
            return True
        return KernelProcess(process, stop)
    def local(args):
        print(json.dumps({"kind": "browser", "args": args}), flush=True)
        reply = json.loads(sys.stdin.readline())
        if "error" in reply: raise RuntimeError(reply["error"])
        return reply["result"]
    def no_api(args): raise AssertionError("Internal browser command used ordinary host RPC")
    program = json.loads(sys.stdin.readline())
    kernels = PythonKernels(launch=launch)
    try:
        result = kernels.execute(("isolated-qa", "qa", "sdk-conversation"), program["code"],
            fresh=True, browser_session="sdk-test", local_browser=local,
            tools={"browser_harness_rpc": no_api}, should_continue=lambda: True,
            max_tool_calls=1, timeout_seconds=30)
        print(json.dumps({"kind": "result", "result": result,
            "liveChildren": sum(child.poll() is None for child in children)}), flush=True)
    finally:
        kernels.close()
        assert all(child.poll() is not None for child in children)
