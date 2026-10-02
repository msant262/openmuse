"""OpenMuse MIT. Nonroot RPC computer. No Docker/host execution or credentials."""
import hashlib
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("openmuse_files", os.path.join(os.path.dirname(__file__), "files.py"))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)
MAX_OUTPUT = 128 * 1024
MAX_TIMEOUT = 1800000


def now():
    return datetime.now(timezone.utc).isoformat()


class Jobs:
    def __init__(self, workspace=None, state_dir=None, max_jobs=1, home="/home/node", isolated=False):
        self.workspace = workspace or files.Workspace()
        self.directory = state_dir or "/home/node/.openmuse-computer"
        self.home = home
        if int(max_jobs) != 1:
            raise ValueError("The open computer supervises one job at a time; use background jobs and poll their receipts")
        self.max_jobs = 1
        # Only main() enables a PID-namespace sweep after verifying Docker init.
        # Host-side test constructors never signal unrelated host processes.
        self.isolated = isolated
        self.quarantined = False
        self.lock = threading.RLock()
        self.enabled = True
        self.active = {}
        self.receipts = {}
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        # Reconcile interrupted jobs; never automatically execute a persisted intent.
        for name in os.listdir(self.directory):
            if re.fullmatch(r"[a-f0-9]{64}\.json", name):
                try:
                    with open(os.path.join(self.directory, name)) as saved:
                        receipt = json.load(saved)
                    if receipt["status"] == "running":
                        receipt.update(status="interrupted", completedAt=now(), stderr="Computer restarted; outcome unknown. Inspect files before repeating work.")
                    self.receipts[receipt["id"]] = receipt
                    self.save(receipt)
                except (ValueError, KeyError, OSError):
                    pass

    def save(self, receipt):
        path = os.path.join(self.directory, receipt["id"] + ".json")
        temporary = path + ".tmp"
        with open(temporary, "w") as target:
            json.dump(receipt, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)

    def submit(self, request):
        job_id = request["id"]
        if not re.fullmatch(r"[a-f0-9]{64}", job_id):
            raise ValueError("Invalid operation ID")
        kind = request.get("kind", "command")
        timeout = request.get("timeoutMs", MAX_TIMEOUT)
        if type(timeout) is not int or not 1000 <= timeout <= MAX_TIMEOUT or kind not in ("command", "transcribe", "preview"):
            raise ValueError("Invalid command timeout or kind")
        cwd = request.get("cwd", "/workspace")
        parts = self.workspace.parts(cwd)
        directory_fd = self.workspace.directory(parts)
        os.close(directory_fd)
        parameters = request.get("parameters", {})
        if kind == "command":
            command = request["command"]
            if not isinstance(command, str) or not command.strip() or len(command) > 16000:
                raise ValueError("Invalid command")
        else:
            self.workspace.parts(parameters["path"])
            command = kind + " " + parameters["path"]
        binding = hashlib.sha256(json.dumps({"command": command, "cwd": cwd, "kind": kind, "parameters": parameters,
                                            "timeoutMs": timeout, "background": bool(request.get("background"))}, sort_keys=True).encode()).hexdigest()
        with self.lock:
            previous = self.receipts.get(job_id)
            if previous:
                if previous.get("binding") != binding:
                    raise ValueError("Operation ID already belongs to different arguments")
                return self.public(previous)
            if not self.enabled or self.quarantined:
                raise ValueError("Start the computer before running commands")
            if len(self.active) >= self.max_jobs or (kind != "command" and any(r.get("kind") != "command" for r in self.active.values())):
                raise ValueError("Computer is busy; wait for a running job")
            receipt = {"id": job_id, "command": command, "cwd": cwd, "kind": kind, "status": "running", "stdout": "", "stderr": "",
                       "truncated": False, "startedAt": now(), "timeoutMs": timeout, "background": bool(request.get("background")), "binding": binding}
            self.receipts[job_id] = receipt
            self.active[job_id] = {"kind": kind, "cancel": threading.Event(), "process": None}
            self.save(receipt)
            threading.Thread(target=self.run, args=(receipt, parameters), daemon=True).start()
            return self.public(receipt)

    def public(self, receipt):
        return {key: value for key, value in receipt.items() if key != "binding"}

    def get(self, job_id):
        with self.lock:
            if job_id not in self.receipts:
                raise KeyError("Command receipt not found")
            return self.public(self.receipts[job_id])

    def status(self):
        with self.lock:
            return {"ready": True, "status": "running" if self.enabled else "stopped", "commands":
                    [self.public(r) for r in sorted(self.receipts.values(), key=lambda r: r["startedAt"], reverse=True)[:100]],
                    **({"message": "Process cleanup is unconfirmed. Recreate the computer before more work."} if self.quarantined else {})}

    def cancel(self, job_id):
        with self.lock:
            if job_id in self.active:
                self.active[job_id]["cancel"].set()
        return self.get(job_id)

    def stop(self):
        with self.lock:
            self.enabled = False
            for entry in self.active.values():
                entry["cancel"].set()
        deadline = time.monotonic() + 8
        while self.active and time.monotonic() < deadline:
            time.sleep(.02)
        if self.active:
            raise RuntimeError("Command stop is not yet confirmed")
        try:
            cleaned = self.sweep()
        except Exception:
            cleaned = False
        if not cleaned:
            self.quarantined = True
            raise RuntimeError("Detached process stop is not confirmed; recreate the computer")
        return self.status()

    def sweep(self):
        if not self.isolated:
            return True
        # One active job plus a separate PID namespace makes detached `setsid`
        # processes safe to terminate as well; no per-job cgroup is claimed.
        def processes():
            result = []
            for name in os.listdir("/proc"):
                if not name.isdigit() or int(name) in (1, os.getpid()):
                    continue
                try:
                    if os.stat("/proc/" + name).st_uid == os.getuid():
                        with open("/proc/" + name + "/stat") as info:
                            if info.read().split(") ", 1)[1].split()[0] != "Z":
                                result.append(int(name))
                except OSError:
                    pass
            return result
        for _ in range(100):
            pending = processes()
            if not pending:
                return True
            for pid in pending:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            time.sleep(.02)
        return not processes()

    def run(self, receipt, parameters):
        job_id = receipt["id"]
        state = self.active[job_id]
        env = {"PATH": "/opt/openmuse/venv/bin:/usr/local/bin:/usr/bin:/bin", "HOME": self.home, "LANG": "C.UTF-8",
               "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"}
        if os.environ.get("WHISPER_MODEL_PATH"):
            env["WHISPER_MODEL_PATH"] = os.environ["WHISPER_MODEL_PATH"]
        command = ["/bin/bash", "--noprofile", "--norc", "-c", receipt["command"]]
        body = None
        if receipt["kind"] != "command":
            command = [sys.executable, "-I", os.path.join(os.path.dirname(__file__), "media.py")]
            body = json.dumps({"kind": receipt["kind"], "parameters": parameters}).encode()
        process = None
        completion = {"status": "interrupted", "completedAt": now(),
                      "stderr": "Execution was interrupted; inspect files before repeating work."}
        output = {"stdout": bytearray(), "stderr": bytearray()}
        def drain(stream, name):
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                with self.lock:
                    available = max(0, MAX_OUTPUT - len(output["stdout"]) - len(output["stderr"]))
                    output[name].extend(chunk[:available])
                    receipt["truncated"] |= len(chunk) > available
                    receipt[name] = output[name].decode("utf-8", errors="replace")
                    self.save(receipt)
            stream.close()
        try:
            directory_fd = self.workspace.directory(self.workspace.parts(receipt["cwd"]))
            try:
                with self.lock:
                    if state["cancel"].is_set():
                        completion.update(stderr="Stopped before execution")
                        return
                    process = subprocess.Popen(command, cwd=f"/proc/self/fd/{directory_fd}", pass_fds=(directory_fd,), env=env,
                                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                    state["process"] = process
            finally:
                os.close(directory_fd)
            process.stdin.write(body or b"")
            process.stdin.close()
            readers = [threading.Thread(target=drain, args=(getattr(process, name), name), daemon=True) for name in output]
            for reader in readers:
                reader.start()
            deadline = time.monotonic() + receipt["timeoutMs"] / 1000
            timed_out = False
            while process.poll() is None:
                if state["cancel"].is_set() or time.monotonic() >= deadline:
                    timed_out = not state["cancel"].is_set()
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=2)
                    except ProcessLookupError:
                        pass
                    break
                time.sleep(.02)
            # Also terminate ordinary descendants after the shell exits; background
            # work is supported through durable jobs rather than escaped '&' processes.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            for reader in readers:
                reader.join(timeout=2)
            with self.lock:
                completion = {"status": "interrupted" if state["cancel"].is_set() else "timed_out" if timed_out else "succeeded" if process.returncode == 0 else "failed",
                              "exitCode": process.returncode, "completedAt": now()}
                if receipt["kind"] != "command" and completion["status"] == "succeeded" and not receipt["truncated"]:
                    completion["result"] = json.loads(receipt["stdout"])
                    completion["stdout"] = ""  # Structured text/result is stored once.
        except Exception:
            completion = {"status": "interrupted", "completedAt": now(),
                          "stderr": "Execution was interrupted; inspect files before repeating work."}
            if process and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        finally:
            try:
                cleaned = self.sweep()
            except Exception:
                cleaned = False
            with self.lock:
                if not cleaned:
                    self.quarantined = True
                    self.enabled = False
                    completion.update(status="interrupted", stderr="Detached process stop is unconfirmed. Recreate the computer before more work.")
                # Keep the public receipt running through cleanup. Completion and
                # release of the single-job slot become visible together.
                receipt.update(completion)
                self.save(receipt)
                self.active.pop(job_id, None)


def handler(jobs):
    class RPC(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            self.dispatch()
        def do_POST(self):
            self.dispatch()
        def dispatch(self):
            self.connection.settimeout(30)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 0 or size > 36 * 1024 * 1024 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("Request is too large")
                body = json.loads(self.rfile.read(size)) if size else {}
                if self.command == "GET" and self.path == "/health":
                    result = {"ready": not jobs.quarantined}
                elif self.command == "GET" and self.path == "/rpc/status":
                    result = jobs.status()
                elif self.command == "POST" and self.path == "/rpc/start":
                    if jobs.quarantined:
                        raise RuntimeError("Computer process cleanup is not confirmed")
                    with jobs.lock:
                        jobs.enabled = True
                    result = jobs.status()
                elif self.command == "POST" and self.path == "/rpc/stop":
                    result = jobs.stop()
                elif self.command == "POST" and self.path == "/rpc/jobs":
                    result = jobs.submit(body)
                elif self.command == "GET" and re.fullmatch(r"/rpc/jobs/[a-f0-9]{64}", self.path):
                    result = jobs.get(self.path.rsplit("/", 1)[-1])
                elif self.command == "POST" and re.fullmatch(r"/rpc/jobs/[a-f0-9]{64}/cancel", self.path):
                    result = jobs.cancel(self.path.split("/")[-2])
                elif self.command == "POST" and self.path == "/rpc/files":
                    if not jobs.enabled:
                        raise ValueError("Start the computer before using its files")
                    result = jobs.workspace.handle(body)
                else:
                    raise KeyError("RPC route not found")
                self.respond(200, result)
            except KeyError:
                self.respond(404, {"error": "Computer receipt or route not found"})
            except (ValueError, OSError, TypeError):
                self.respond(422, {"error": "Computer request failed. Check path, size, active jobs and operation ID."})
            except Exception:
                self.respond(503, {"error": "Computer operation could not be confirmed"})
        def respond(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    return RPC


def main():
    if os.getuid() == 0:
        raise RuntimeError("The computer must run as a nonroot user")
    if os.getppid() != 1 or os.path.basename(os.readlink("/proc/1/exe")) not in ("docker-init", "tini", "tini-static"):
        raise RuntimeError("The computer requires its own PID namespace and Docker init as PID 1")
    # No secret token is required or accepted here. Gateway alone authenticates.
    jobs = Jobs(max_jobs=os.environ.get("COMPUTER_MAX_BACKGROUND_JOBS", "1"), isolated=True)
    server = ThreadingHTTPServer(("127.0.0.1", 8810), handler(jobs))
    server.daemon_threads = True
    def stop(*args):
        jobs.stop()
        os._exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()


if __name__ == "__main__":
    main()
