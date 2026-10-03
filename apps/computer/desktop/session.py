"""Persistent private Xvnc/Xfce process for a fixed registered native UID.

Run inside the account's systemd session unit, wrapped by dbus-run-session.
Viewer disconnects do not terminate this process. Stopping it only terminates
its own two child process groups; native jobs in separate units are untouched.
"""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import uuid

from .driver import integer


def private_directory(path, uid):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Desktop runtime must be an absolute directory without symlinks")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise ValueError("Desktop runtime must be private and owned by the registered account")


@dataclass(frozen=True)
class SessionConfig:
    executor_id: str
    uid: int
    home: Path
    runtime: Path
    display: int
    width: int = 1280
    height: int = 720

    def __post_init__(self):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", self.executor_id):
            raise ValueError("Invalid registered executor")
        if type(self.uid) is not int or self.uid != os.getuid():
            raise ValueError("Desktop must run as its registered native account")
        if not self.home.is_absolute() or not self.runtime.is_absolute():
            raise ValueError("Registered home/runtime must be absolute")
        integer(self.display, 60, 199)
        integer(self.width, 320, 3840)
        integer(self.height, 240, 2160)


def session_environment(config, authority, *, bus=None):
    value = {"HOME": str(config.home), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
             "DISPLAY": f":{config.display}", "XAUTHORITY": str(authority),
             "XDG_RUNTIME_DIR": str(config.runtime),
             "PLAYWRIGHT_BROWSERS_PATH": "/opt/okami-computer/playwright-browsers"}
    if bus:
        value["DBUS_SESSION_BUS_ADDRESS"] = bus
    return value


def xvnc_arguments(config, authority, socket):
    return ["/usr/bin/Xtigervnc", f":{config.display}", "-geometry", f"{config.width}x{config.height}",
            "-depth", "24", "-nolisten", "tcp", "-auth", str(authority),
            "-rfbport", "-1", "-rfbunixpath", str(socket), "-rfbunixmode", "0600",
            "-SecurityTypes", "None", "-AcceptKeyEvents=0", "-AcceptPointerEvents=0",
            "-AcceptCutText=0", "-SendCutText=0", "-AcceptSetDesktopSize=0", "-AllowOverride", "",
            "-AlwaysShared=1", "-DisconnectClients=0", "-FrameRate", "8"]


class NativeSession:
    def __init__(self, config):
        self.config, self.processes, self.directory = config, [], None
        self.generation = str(uuid.uuid4())

    def start(self, *, xfce=True):
        if self.directory is not None:
            raise ValueError("Native session already started")
        config = self.config
        private_directory(config.runtime, config.uid)
        if (Path(f"/tmp/.X{config.display}-lock").exists()
                or Path(f"/tmp/.X11-unix/X{config.display}").exists()):
            raise ValueError("Registered desktop display is already in use")
        self.generation = str(uuid.uuid4())
        self.directory = Path(tempfile.mkdtemp(prefix="desktop-", dir=config.runtime))
        authority = self.directory / "Xauthority"
        socket = self.directory / "rfb.sock"
        if len(os.fsencode(socket)) > 100:
            self.close()
            raise ValueError("Desktop runtime path exceeds the Unix socket limit")
        authority.touch(mode=0o600)
        self.env = session_environment(config, authority, bus=os.environ.get("DBUS_SESSION_BUS_ADDRESS"))
        if xfce and not self.env.get("DBUS_SESSION_BUS_ADDRESS"):
            self.close()
            raise ValueError("Managed Xfce requires its private dbus-run-session")
        try:
            # Keep the generated X cookie out of process arguments and logs.
            subprocess.run(["/usr/bin/xauth", "-f", str(authority), "source", "-"],
                           input=f"add :{config.display} . {secrets.token_hex(16)}\n", text=True,
                           env=self.env, capture_output=True, check=True, timeout=5)
            self.processes.append(subprocess.Popen(xvnc_arguments(config, authority, socket),
                                                  env=self.env, stdout=subprocess.DEVNULL,
                                                  stderr=subprocess.DEVNULL, start_new_session=True))
            deadline = time.monotonic() + 10
            while not socket.exists():
                if self.processes[0].poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Private desktop failed to start")
                time.sleep(.05)
            info = socket.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != config.uid or info.st_mode & 0o077:
                raise RuntimeError("Desktop viewer socket is not private")
            if xfce:
                self.processes.append(subprocess.Popen(["/usr/bin/startxfce4"], env=self.env,
                                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                      start_new_session=True))
            return {"executorId": config.executor_id, "sessionGeneration": self.generation,
                    "display": self.env["DISPLAY"], "authorityPath": str(authority),
                    "viewerSocket": str(socket), "width": config.width, "height": config.height}
        except Exception:
            self.close()
            raise

    def alive(self):
        return bool(self.processes) and all(process.poll() is None for process in self.processes)

    def close(self):
        failures = []
        for process in reversed(self.processes):
            try:
                # The session leader may already have exited while its children
                # remain. Signal the owned group, not all processes of the UID.
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                # Any child still in that group receives SIGKILL as well. The
                # enclosing systemd KillMode=control-group also catches a child
                # which deliberately created a new process session.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            except ProcessLookupError:
                process.poll()
            except Exception as error:
                failures.append(error)
        if failures:
            raise RuntimeError("Owned desktop process cleanup could not be confirmed")
        self.processes.clear()
        if self.directory:
            shutil.rmtree(self.directory)
            self.directory = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor-id", required=True)
    parser.add_argument("--display", required=True, type=int)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    args = parser.parse_args()
    if os.getuid() == 0:
        raise RuntimeError("Desktop must run as a non-root registered native account")
    config = SessionConfig(args.executor_id, os.getuid(), Path.home(), args.runtime,
                           args.display, args.width, args.height)
    stop = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stop.set())
    session = NativeSession(config)
    try:
        print(json.dumps(session.start()), flush=True)
        while not stop.wait(.5):
            if not session.alive():
                raise RuntimeError("A managed desktop process stopped")
    finally:
        session.close()


if __name__ == "__main__":
    main()
