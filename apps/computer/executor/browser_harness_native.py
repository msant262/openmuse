"""Unchanged browser-harness helpers over the cell's owned host RPC.

The browser remains in the registered native broker, not in this interpreter.
No daemon, cloud client, CDP port, credential or owner selector is exposed.
The host binds the session and applies ordinary task/control/effect authority.
"""
import importlib
import importlib.util
import math
import os
from pathlib import Path
import re
import sys
import types


RPC_TOOL = "browser_harness_rpc"
SOURCE = Path(__file__).parent / "vendor" / "browser_harness"


def validate_browser_session(session):
    if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", session):
        raise ValueError("Browser script requires an owned named session")
    return session


def browser_helpers(session, workspace, call):
    """Load the copied package after this source call's RPC authority is bound."""
    validate_browser_session(session)
    workspace = Path(workspace).resolve()
    home = workspace / ".browser-harness"
    temporary = home / "tmp" / session
    temporary.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Set before helpers._load_env(), which uses setdefault: neither a local
    # .env nor editable agent_helpers.py can select another native authority.
    os.environ.update({
        "BH_AGENT_WORKSPACE": str(workspace), "BH_HOME": str(home),
        "BH_TMP_DIR": str(temporary), "BH_RUNTIME_DIR": str(home / "runtime"),
        "BU_NAME": session, "BH_TAB_MARKER": "false",
    })
    if "browser_harness" in sys.modules:
        raise RuntimeError("Browser helper bootstrap requires a fresh interpreter")
    spec = importlib.util.spec_from_file_location("browser_harness", SOURCE / "__init__.py",
                                                submodule_search_locations=[str(SOURCE)])
    package = importlib.util.module_from_spec(spec)
    sys.modules["browser_harness"] = package
    spec.loader.exec_module(package)
    ipc = types.ModuleType("browser_harness._ipc")
    ipc._TMP = temporary

    class Channel:
        def __init__(self):
            self.timeout, self.closed = 5.0, False

        def settimeout(self, seconds):
            if (self.closed or type(seconds) not in (int, float)
                    or not math.isfinite(seconds) or not 0 < seconds <= 1800):
                raise ValueError("Invalid native browser response deadline")
            self.timeout = seconds

        def close(self):
            self.closed = True

    def connect(name, timeout=5.0):
        if name != session:
            raise ValueError("Browser helper session differs from its bound source call")
        channel = Channel()
        channel.settimeout(timeout)
        return channel, None

    def request(channel, token, value):
        if not isinstance(channel, Channel) or channel.closed or token is not None:
            raise ValueError("Browser helper has no current native channel")
        response = call(RPC_TOOL, {
            "session": session, "request": value,
            "timeoutMs": max(1, int(channel.timeout * 1000)),
        })
        if not isinstance(response, dict):
            raise RuntimeError("Native browser returned an invalid helper response")
        return response

    ipc.sock_addr = lambda name: "native-task-browser:" + validate_browser_session(name)
    ipc.connect, ipc.request = connect, request
    sys.modules["browser_harness._ipc"] = ipc
    package._ipc = ipc
    helpers = importlib.import_module("browser_harness.helpers")
    return {name: value for name, value in vars(helpers).items() if not name.startswith("_")}
