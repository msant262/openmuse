"""Persistent native supervisor, scoped authenticated pull and durable local receipts.

Only this process sees node credentials. Bot jobs never receive its environment,
database, HTTP listener, administrative catalog or tailnet privileges. A watchdog
thread independently closes the gate, including suspend time (CLOCK_BOOTTIME).
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import socket
import stat
import struct
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

TERMINAL = {"succeeded", "failed", "rejected_not_dispatched", "superseded", "outcome_unknown"}
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def boottime():
    # monotonic() excludes sleep on Linux. Failing closed beats a fallback that
    # leaves effects permitted for a suspend-length extension of the lease.
    if not hasattr(time, "CLOCK_BOOTTIME"):
        raise RuntimeError("Native watchdog requires CLOCK_BOOTTIME")
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


class Journal:
    def __init__(self, path):
        Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,binding TEXT NOT NULL,envelope TEXT NOT NULL,
                receipt TEXT,sequence INTEGER NOT NULL DEFAULT 0,ack INTEGER NOT NULL DEFAULT 0);
        """)
        self.lock = threading.RLock()

    def close(self):
        self.db.close()

    def state(self, key, value=None):
        with self.lock:
            if value is not None:
                self.db.execute("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
                self.db.commit()
                return value
            row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def receive(self, operation):
        if not SAFE_ID.fullmatch(operation["id"]) or not re.fullmatch(r"[0-9a-f]{64}", operation["bindingHash"]):
            raise ValueError("Invalid operation identity/binding")
        with self.lock:
            row = self.db.execute("SELECT binding,envelope FROM operations WHERE id=?", (operation["id"],)).fetchone()
            if row:
                if row[0] != operation["bindingHash"] or json.loads(row[1]) != operation:
                    raise ValueError("Operation ID binding/epoch conflict")
                return False
            self.db.execute("INSERT INTO operations(id,binding,envelope) VALUES(?,?,?)", (operation["id"], operation["bindingHash"], json.dumps(operation)))
            self.db.commit()  # Before any executable effect.
            return True

    def get(self, operation_id):
        with self.lock:
            row = self.db.execute("SELECT envelope,receipt,sequence,ack FROM operations WHERE id=?", (operation_id,)).fetchone()
            if not row:
                raise ValueError("Operation is not in native journal")
            return {"operation": json.loads(row[0]), "receipt": json.loads(row[1]) if row[1] else None,
                    "sequence": row[2], "ack": row[3]}

    def receipt(self, operation_id, receipt):
        if receipt.get("status") not in TERMINAL | {"running"}:
            raise ValueError("Invalid native receipt status")
        with self.lock:
            previous = self.get(operation_id)
            if previous["receipt"] and previous["receipt"]["status"] in TERMINAL:
                cleanup_upgrade = (previous["receipt"]["status"] == receipt["status"] == "outcome_unknown"
                    and previous["receipt"].get("data", {}).get("cleanupConfirmed") is not True
                    and receipt.get("data", {}).get("cleanupConfirmed") is True)
                if not cleanup_upgrade:
                    return {"operationId": operation_id, "sequence": previous["sequence"], "receipt": previous["receipt"]}
            sequence = previous["sequence"] + 1
            self.db.execute("UPDATE operations SET receipt=?,sequence=? WHERE id=?", (json.dumps(receipt), sequence, operation_id))
            self.db.commit()
            return {"operationId": operation_id, "sequence": sequence, "receipt": receipt}

    def acknowledge(self, operation_id, sequence):
        with self.lock:
            self.db.execute("UPDATE operations SET ack=MAX(ack,?) WHERE id=? AND sequence>=?", (sequence, operation_id, sequence))
            self.db.commit()

    def manifest(self):
        with self.lock:
            return [{"operationId": row[0], "bindingHash": row[1], "executorEpoch": json.loads(row[2])["executorEpoch"],
                     "sequence": row[4], "receipt": json.loads(row[3]) if row[3] else {"status": "outcome_unknown", "message": "Receipt absent after receive"}}
                    for row in self.db.execute("SELECT id,binding,envelope,receipt,sequence FROM operations WHERE ack<sequence OR receipt IS NULL OR json_extract(receipt,'$.status')='running' OR (json_extract(receipt,'$.status')='outcome_unknown' AND COALESCE(json_extract(receipt,'$.data.cleanupConfirmed'),0)!=1)")]

    def unacknowledged(self):
        with self.lock:
            return [{"operationId": row[0], "sequence": row[1], "receipt": json.loads(row[2])}
                    for row in self.db.execute("SELECT id,sequence,receipt FROM operations WHERE sequence>ack AND receipt IS NOT NULL")]

    def owned_commands(self, executor_id):
        # Cleanup handoff survives ACK and a crash between two durable stores.
        # ACK controls delivery; it cannot discard local resource ownership.
        with self.lock:
            return [{"operation":json.loads(envelope),"receipt":json.loads(receipt) if receipt else None}
                    for envelope,receipt in self.db.execute(
                        "SELECT envelope,receipt FROM operations WHERE json_extract(envelope,'$.kind')='command' AND json_extract(envelope,'$.executorId')=?",
                        (executor_id,))]

    def graphical_cleanup(self, reset):
        """A completed fixed-session reset proves input release, not success.

        Preserve outcome_unknown and never replay an earlier action. The reset
        has already revoked its control revision and waited for GUI/DOM cleanup.
        """
        with self.lock:
            rows=self.db.execute("SELECT id,envelope,receipt FROM operations WHERE json_extract(envelope,'$.kind') IN ('desktop','browser')").fetchall()
            for operation_id,envelope,raw in rows:
                operation=json.loads(envelope);receipt=json.loads(raw) if raw else None
                if (operation_id==reset["id"] or operation["executorId"]!=reset["executorId"]
                        or any(operation["args"].get(key)!=reset["args"].get(key) for key in ("sessionId","sessionGeneration"))
                        or operation["args"].get("controlRevision",0)>=reset["args"]["controlRevision"]
                        or operation["args"].get("operation") in ("observe","reset","snapshot","read","inspect","agent-screenshot","screenshot","control","downloads","download")
                        or receipt and (receipt["status"] not in ("running","outcome_unknown") or receipt.get("data",{}).get("cleanupConfirmed") is True)):
                    continue
                self.receipt(operation_id,{**(receipt or {}),"status":"outcome_unknown",
                    "data":{**((receipt or {}).get("data") or {}),"cleanupConfirmed":True,"cleanupOperationId":reset["id"]},
                    "message":"Fixed desktop session inputs were released; earlier effects remain uncertain"})

    def recover(self):
        with self.lock:
            rows = self.db.execute("SELECT id,receipt,envelope FROM operations").fetchall()
            for operation_id, raw, envelope in rows:
                if not raw or json.loads(raw)["status"] not in TERMINAL:
                    local_file=json.loads(envelope)["kind"] in ("file","file-version")
                    self.receipt(operation_id, {"status": "outcome_unknown", "data": {"cleanupConfirmed":local_file},
                        "message": "Supervisor restarted; reconcile old service before another effect"})


class Gate:
    def __init__(self, journal, contain, clock=boottime, trust_mode="restricted"):
        self.journal, self.contain, self.clock, self.trust_mode = journal, contain, clock, trust_mode
        self.epoch, self.deadline, self.open, self.needs_reconciliation = None, 0, False, True
        self.quarantined = False
        self.server_anchor = None
        self.pause_state = journal.state("pause") or {"paused": False, "revision": 0}
        self.lock = threading.RLock()
        self.local_mutations = 0

    def handshake(self, epoch, pause, watchdog_seconds, server_time=None):
        with self.lock:
            if not isinstance(epoch, int) or epoch < 1 or not 1 <= watchdog_seconds <= 60:
                raise ValueError("Invalid epoch/watchdog lease")
            self.open, self.needs_reconciliation = False, True
            self.epoch, self.deadline = epoch, self.clock() + watchdog_seconds
            if server_time is not None:
                self.server_anchor = (datetime.datetime.fromisoformat(server_time.replace("Z", "+00:00")).timestamp(), self.clock())
            self.pause(pause)
            self.journal.state("epoch", epoch)

    def reconciled(self):
        with self.lock:
            if self.quarantined:
                raise ValueError("Native executor is quarantined")
            if self.epoch is None or self.clock() >= self.deadline:
                raise ValueError("Native effect gate is closed")
            self.needs_reconciliation = False
            self.open = not self.pause_state["paused"]

    def renew(self, epoch, pause, watchdog_seconds):
        with self.lock:
            if epoch != self.epoch or self.needs_reconciliation:
                raise ValueError("New handshake/reconciliation required")
            if self.clock() >= self.deadline:
                self.close("watchdog")
                raise ValueError("Watchdog expired; new handshake required")
            self.pause(pause)
            self.deadline = self.clock() + watchdog_seconds

    def pause(self, pause):
        with self.lock:
            if not isinstance(pause.get("paused"), bool) or not isinstance(pause.get("revision"), int):
                raise ValueError("Invalid pause state")
            if pause["revision"] >= self.pause_state["revision"]:
                was_paused = self.pause_state["paused"]
                self.pause_state = {"paused": pause["paused"], "revision": pause["revision"]}
                self.journal.state("pause", self.pause_state)
                if pause["paused"]:
                    contained = self.close("pause")
                else:
                    contained = True
                    if was_paused:
                        self.open, self.needs_reconciliation = False, True
            else:
                contained = self.pause_state["paused"] and not self.quarantined and self.local_mutations == 0
            return {"epoch": self.epoch, "revision": self.pause_state["revision"], "contained": contained,
                    "guaranteed": contained and self.trust_mode == "restricted"}

    def close(self, reason):
        with self.lock:
            self.open = False
            if reason != "pause":
                self.needs_reconciliation = True
            try:
                confirmed = bool(self.contain(reason))
            except Exception:
                confirmed = False
            if not confirmed:
                self.quarantined = True
            # Account freeze does not freeze this root file mutator. An active
            # destructive publication must finish/rollback before a true ACK.
            return confirmed and self.local_mutations == 0

    @contextlib.contextmanager
    def local_mutation(self, operation):
        with self.lock:
            self.check(operation)
            self.local_mutations += 1
        try:
            yield
        finally:
            with self.lock:
                self.local_mutations -= 1

    def suspend(self):
        with self.lock:
            return self.close("suspend")

    def watchdog(self):
        with self.lock:
            if self.clock() >= self.deadline and not self.needs_reconciliation:
                self.close("watchdog")
            return self.open and not self.quarantined

    def check(self, operation, inspection=False, containment=False):
        with self.lock:
            self.watchdog()
            if containment and not (operation["kind"]=="cancel" and set(operation["args"])=={"operationId"}
                    or operation["kind"]=="session" and operation["args"]=={"operation":"stop"}
                    or operation["kind"]=="desktop" and operation["args"].get("operation")=="reset"):
                raise ValueError("Containment requires a fixed owned stop/cancel operation")
            if self.pause_state["paused"] and not inspection and not containment:
                raise ValueError("Native executor is globally paused")
            if self.quarantined or self.needs_reconciliation or (not self.open and not inspection and not containment):
                raise ValueError("Native effect gate is closed; reconciliation or quarantine resolution required")
            if operation["executorEpoch"] != self.epoch:
                raise ValueError("Native executor epoch is stale")
            now = time.time()
            if self.server_anchor is not None:
                now = max(now, self.server_anchor[0] + self.clock() - self.server_anchor[1])
            if datetime.datetime.fromisoformat(operation["expiresAt"].replace("Z", "+00:00")).timestamp() <= now:
                raise ValueError("Native command expired before dispatch")
            resource_key = operation.get("resourceKey")
            if not isinstance(resource_key, str) or not 1 <= len(resource_key) <= 256:
                raise ValueError("Native operation has no authoritative resource key")
            fence_key = "fence:" + operation["executorId"] + ":" + resource_key
            previous = self.journal.state(fence_key) or 0
            if operation["resourceFence"] < previous:
                raise ValueError("Native resource fence is stale")
            self.journal.state(fence_key, operation["resourceFence"])


class NodeTransport:
    def __init__(self, origin, executor_id, token, timeout=25):
        parsed = urllib.parse.urlparse(origin)
        address = parsed.hostname
        import ipaddress
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as error:
            raise ValueError("Native control origin must be a fixed Tailscale IP") from error
        if (parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or not (ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48"))
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", executor_id) or len(token) < 32):
            raise ValueError("Native transport requires fixed tailnet origin, registered executor and scoped node credential")
        self.origin, self.executor_id, self.token, self.timeout = origin.rstrip("/"), executor_id, token, timeout
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                raise ValueError("Native node credentials cannot follow redirects")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, route, body):
        if route not in ("register", "reconcile", "heartbeat", "claim", "receipt", "artifact", "desktop/frame", "desktop/input") and not re.fullmatch(r"(?:credential-grants|browser-files)/[a-f0-9-]{36}/consume",route):
            raise ValueError("Unregistered native protocol route")
        url = self.origin + "/executor/" + self.executor_id + "/" + route
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                         headers={"Content-Type":"application/json", "Authorization":"Bearer " + self.token})
        with self.opener.open(request, timeout=self.timeout) as response:
            raw = response.read(36 * 1024 * 1024 + 1)
            if len(raw) > 36 * 1024 * 1024:
                raise ValueError("Native control response is too large")
            return json.loads(raw)


def control_request(supervisor, peer_uid, payload):
    if peer_uid != 0:
        raise ValueError("Native sleep control requires an authenticated root peer")
    if payload != {"operation":"prepare-sleep"}:
        raise ValueError("Native local control only accepts prepare-sleep")
    return {"contained":supervisor.gate.suspend()}


class PrivateControl:
    """Root-only Unix sleep hook, separate from all node/owner HTTP traffic."""
    def __init__(self, supervisor, path):
        self.supervisor, self.path = supervisor, Path(path)
        self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        parent = self.path.parent.lstat()
        if parent.st_uid != 0 or parent.st_mode & 0o077 or not stat.S_ISDIR(parent.st_mode):
            raise ValueError("Native sleep control directory must be private and root-owned")
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if info.st_uid != 0 or not stat.S_ISSOCK(info.st_mode):
                raise ValueError("Native sleep control path is not a root-owned socket")
            self.path.unlink()
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(str(self.path));self.path.chmod(0o600)
        self.socket.listen(2);self.socket.settimeout(.5)

    def serve(self):
        while not self.supervisor.stop_event.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                try:
                    connection.settimeout(12)
                    _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
                    raw = connection.recv(129)
                    if len(raw) > 128:
                        raise ValueError("Native local control request is too large")
                    response = control_request(self.supervisor, uid, json.loads(raw))
                except Exception:
                    response = {"contained":False}
                connection.sendall(json.dumps(response).encode())

    def close(self):
        self.socket.close()
        self.path.unlink(missing_ok=True)


def prepare_sleep(executor_id, ipc_root=Path("/run/okami-executor")):
    if os.getuid() != 0 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", executor_id):
        raise ValueError("Native sleep hook requires root and a fixed registered executor ID")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(12)
        client.connect(str(ipc_root / (executor_id + ".sock")))
        client.sendall(b'{"operation":"prepare-sleep"}')
        response = json.loads(client.recv(129))
        if response != {"contained":True}:
            raise RuntimeError("Native containment is unconfirmed; suspend is refused")


class Supervisor:
    def __init__(self, config, sessions, runtime, workspace, journal, transport, helper, clock=boottime, resource_snapshot=None, budget=None, desktop=None):
        from .job_runtime import HostBudget, host_snapshot
        self.config, self.sessions, self.runtime = config, sessions, runtime
        self.workspace, self.journal, self.transport, self.helper = workspace, journal, transport, helper
        self.desktop=desktop
        self.desktop_frozen=False
        self.resource_snapshot = resource_snapshot or (lambda host_id:host_snapshot(host_id,accounts=sessions.registry.values()))
        account = sessions.account(config["executorId"])
        self.gate = Gate(journal, self.contain, clock, account["trustMode"])
        self.stop_event = threading.Event()
        self.boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        self.instance_id = str(uuid.uuid4())
        self.threads = {}
        self.pause_ack = None
        self.budget = budget
        if self.budget is None:
            try:
                self.budget = HostBudget(self.resource_snapshot(config["hostId"])["memoryTotalBytes"], config.get("reserveBytes", 4 * 1024**3))
            except (OSError, ValueError):
                pass  # Readiness stays unavailable, and command dispatch fails closed.
        owned_commands=journal.owned_commands(config["executorId"])
        for item in owned_commands:
            receipt = item["receipt"] or {}
            if (item["operation"]["kind"] == "command" and
                    (not receipt or receipt.get("status") == "running" or
                     (receipt.get("status") == "outcome_unknown" and receipt.get("data", {}).get("cleanupConfirmed") is not True))):
                runtime.adopt(item["operation"])
                resource_budget = item["operation"].get("resourceBudget")
                if self.budget and resource_budget:
                    self.budget.restore(item["operation"]["id"], resource_budget["memoryBytes"], resource_budget["heavy"],config["executorId"])
        self.gate.close("startup")
        journal.recover()
        for item in owned_commands:
            receipt=item["receipt"] or {}
            if receipt.get("status") in TERMINAL and receipt.get("data",{}).get("cleanupConfirmed") is True:
                operation=item["operation"];resource_budget=operation.get("resourceBudget")
                if self.budget and resource_budget:
                    self.budget.check_binding(operation["id"],resource_budget["memoryBytes"],resource_budget["heavy"],config["executorId"])
                # Never relaunch. Release only this journal's fixed retained
                # unit, after its cleanup proof was durably committed.
                runtime.adopt(operation)
                self.release(operation["id"])

    def contain(self, reason):
        executor_id = self.config["executorId"]
        def attempt(operation):
            try:return bool(operation())
            except Exception:return False
        graphical = attempt(lambda:self.desktop.close_gate(self.gate.epoch)) if self.desktop and not self.desktop_frozen else True
        network = attempt(lambda:self.helper.gate(executor_id, True))
        # Attempt every managed containment step even if networking fails.
        # Never move/freeze existing personal or RDP session scopes.
        account = attempt(lambda:self.helper.contain_account(executor_id)) if hasattr(self.helper, "contain_account") else True
        jobs = attempt(lambda:self.runtime.contain(executor_id, freeze=True))
        session = attempt(lambda:self.helper.contain_session(executor_id))
        if graphical and account and session:self.desktop_frozen=True
        if self.budget:
            for operation_id in list(self.runtime.active):
                self.budget.freeze(operation_id)
        return graphical and network and account and jobs and session

    def readiness(self):
        account = self.sessions.preflight(self.config["executorId"])
        if account.get("limitation") and account["state"] == "ready":
            account={**account,"reason":account["limitation"]}
        runtime_ready = {"state": "ready", "reason": "Managed native job runtime"}
        try:
            resources = self.resource_snapshot(self.config["hostId"])
            if self.budget:
                resources = {**resources, "heavyOwner":self.budget.heavy_owner}
            reserve = self.config.get("reserveBytes", 4 * 1024**3)
            if (self.budget is None or resources["botsMaxBytes"] is None
                    or resources["botsMaxBytes"] > resources["memoryTotalBytes"] - reserve):
                runtime_ready = {"state": "unavailable", "reason": "Aggregate native RAM budget has not been installed"}
            if hasattr(self.helper, "preflight"):
                self.helper.preflight(self.config["executorId"])
        except Exception:
            resources = None
            runtime_ready = {"state": "unavailable", "reason": "Native cgroup/resource preflight is unavailable"}
        absent = {"state": "unavailable", "reason": "Graphical driver preflight is required (milestone 7)"}
        conflicts=self.workspace.publication_conflicts() if hasattr(self.workspace,"publication_conflicts") else []
        files={"state":"ready"}
        if conflicts:files["reason"]=str(len(conflicts))+" artifact publications conflicted; inspect the current files"
        graphical=(self.desktop.cached_status() if self.desktop_frozen and hasattr(self.desktop,"cached_status") else
                   {"display":absent,"capture":absent,"input":absent,"browser":absent} if self.desktop_frozen else
                   self.desktop.status()) if self.desktop else {"display":absent,"capture":absent,"input":absent,"browser":absent}
        return {"account": account, "runtime": runtime_ready, "files": files,"publicationConflicts":conflicts,
                **graphical,
                "resources": resources, "trustMode": self.gate.trust_mode,
                "containmentGuaranteed": self.gate.trust_mode == "restricted" and not self.gate.quarantined,
                "quarantined": self.gate.quarantined}

    def connect(self):
        self.gate.close("reconnect")
        hello = {"hostId":self.config["hostId"], "executorId":self.config["executorId"],
                 "osAccountId":str(self.sessions.account(self.config["executorId"])["uid"]), "bootId":self.boot_id,
                 "instanceId":self.instance_id,
                 "minProtocolVersion":1, "maxProtocolVersion":1,
                 "capabilities":[{"name":"command", "version":1}, {"name":"files", "version":1}]+(
                    [{"name":name,"version":1} for name in ("desktop","browser.dom","browser.screenshot","browser.pointer","browser.drag")] if self.desktop else []),
                 "readiness":self.readiness()}
        response = self.transport.request("register", hello)
        if response.get("protocolVersion") != 1:
            raise ValueError("Native protocol incompatible; update executor before dispatch")
        self.gate.handshake(response["epoch"], response["pause"], response["watchdogMs"] / 1000, response.get("serverTime"))
        manifest = {"epoch":self.gate.epoch, "bootId":self.boot_id, "operations":self.journal.manifest(),
                    "contained":not self.gate.quarantined}
        ack = self.transport.request("reconcile", manifest)
        if not ack.get("reconciled"):
            raise ValueError("Native operation reconciliation is incomplete")
        for receipt in ack.get("acknowledged", []):
            self.journal.acknowledge(receipt["operationId"], receipt["sequence"])
        with self.gate.lock:
            self.gate.reconciled()
            if self.gate.open:
                # Unknown old jobs remain frozen at their own unit even after
                # the parent slice resumes. No reconnect replays their command.
                for operation_id in list(self.runtime.active):
                    item = self.journal.get(operation_id)
                    if item["receipt"] and item["receipt"]["status"] == "running":
                        self.runtime.thaw(operation_id)
                self.helper.resume_session(self.config["executorId"])
                if hasattr(self.helper, "resume_account"):
                    self.helper.resume_account(self.config["executorId"])
                self.desktop_frozen=False
                if self.desktop:self.desktop.gate(self.gate)
                self.helper.gate(self.config["executorId"], False)
                if self.gate.clock() >= self.gate.deadline:
                    self.gate.close("watchdog")

    def flush(self):
        for value in self.journal.unacknowledged():
            operation = self.journal.get(value["operationId"])["operation"]
            if operation["executorEpoch"] != self.gate.epoch:
                # Old-epoch terminal evidence is reconciled through a manifest,
                # never passed off as a receipt from a new incarnation.
                ack = self.transport.request("reconcile", {"epoch":self.gate.epoch, "bootId":self.boot_id,
                    "contained":not self.gate.quarantined, "operations":self.journal.manifest()})
                for item in ack.get("acknowledged", []):
                    self.journal.acknowledge(item["operationId"], item["sequence"])
                continue
            response = self.transport.request("receipt", {"epoch":self.gate.epoch, **value})
            self.journal.acknowledge(value["operationId"], response["sequence"])
        for artifact in self.workspace.pending_publications():
            try:
                self.workspace.verify_publication(artifact)
            except (OSError,ValueError) as error:
                # A stale/missing file is an individual origin conflict, not a
                # broken node connection. Keep receipts, cleanup and claims live.
                self.workspace.publication_conflict(artifact,error)
                continue
            ack = self.transport.request("artifact", {"epoch":self.gate.epoch, **artifact,
                "versions":self.workspace.versions(artifact["artifactId"])})
            self.workspace.acknowledge(ack["artifactId"], ack["version"], ack["sha256"], ack.get("generation"), ack.get("versionId"))

    def command_receipt(self, operation, status, result):
        args = operation["args"]
        command = {"id":operation["id"], "command":args["command"], "cwd":args.get("cwd", "/workspace"),
                   "kind":"command", "timeoutMs":args.get("timeoutMs",1800000), "background":args.get("background",False),
                   "status":status if status in ("running", "succeeded", "failed", "rejected_not_dispatched") else "interrupted",
                   "stdout":result.get("stdout", ""), "stderr":result.get("stderr",result.get("message", "")),
                   "truncated":result.get("truncated",False), "startedAt":operation.get("createdAt",utc())}
        if status == "outcome_unknown":
            command["outcomeUnknown"] = True
        if "cleanupConfirmed" in result:
            command["cleanupConfirmed"] = result["cleanupConfirmed"]
        if status != "running":
            command["completedAt"] = utc()
        if "exitCode" in result:
            command["exitCode"] = result["exitCode"]
        return command

    def perform(self, operation):
        inspection = (operation["kind"] == "file" and operation["args"].get("operation") in ("list","read","read_binary","stat")
                      or operation["kind"]=="desktop" and operation["args"].get("operation")=="observe"
                      or operation["kind"]=="browser" and operation["args"].get("operation") in ("snapshot","read","inspect","agent-screenshot","screenshot","control","downloads","download"))
        containment=(operation["kind"]=="cancel" or operation["kind"]=="session" and operation["args"].get("operation")=="stop"
                     or operation["kind"]=="desktop" and operation["args"].get("operation")=="reset")
        if not self.journal.receive(operation):
            return  # Same-ID response retransmission is a receipt lookup, never execution.
        started = False
        reserved = False
        try:
            if operation["executorId"]!=self.config["executorId"]:
                raise ValueError("Operation belongs to another registered executor")
            self.gate.check(operation, inspection, containment)
            if operation["kind"] == "command":
                resource_budget = operation.get("resourceBudget")
                if not self.budget or not resource_budget:
                    raise ValueError("Trusted native resource budget is unavailable")
                snapshot = self.resource_snapshot(self.config["hostId"])
                self.budget.admit(operation["id"], resource_budget["memoryBytes"], resource_budget["heavy"], snapshot["memoryAvailableBytes"], snapshot.get("unmanagedAccountBytes",0),snapshot.get("managedSessionBytes",0),self.config["executorId"])
                reserved = True
                launch = {**operation, "args":{**operation["args"], "memoryMaxBytes":resource_budget["memoryBytes"]}}
                self.gate.check(operation)
                started = True
                self.runtime.launch(launch)
                if not self.gate.watchdog():
                    self.contain("dispatch-race")
                    raise ValueError("Native gate closed while service dispatch was being acknowledged")
                receipt = self.command_receipt(operation, "running", {})
                self.journal.receipt(operation["id"], {"status":"running", "data":receipt})
                return
            if operation["kind"] in ("file", "file-version"):
                started = True
                def progress(done, total):
                    self.journal.receipt(operation["id"], {"status":"running", "progress":{"completedBytes":done,"totalBytes":total}})
                data = self.workspace.handle(operation, cancelled=lambda: not self.gate.watchdog() and not inspection, progress=progress,
                                             publication_guard=lambda:self.gate.local_mutation(operation))
            elif operation["kind"] in ("desktop","browser"):
                if not self.desktop:raise ValueError("Registered graphical adapter is unavailable")
                if self.desktop_frozen:raise ValueError("Desktop account is contained; inspect its last frame or resume explicitly")
                self.desktop.gate(self.gate)
                # Resolve one-use values only after journaling the safe envelope.
                # Never write the ephemeral copy back to SQLite or log it.
                ephemeral=operation
                if operation["kind"]=="desktop" and operation["args"].get("action",{}).get("textReference"):
                    import hashlib
                    action=operation["args"]["action"]
                    payload=self.transport.request("desktop/input",{"epoch":self.gate.epoch,"operationId":operation["id"],"textReference":action["textReference"],"sessionId":operation["args"]["sessionId"],"sessionGeneration":operation["args"]["sessionGeneration"]})
                    text=payload.get("text")
                    if not isinstance(text,str) or hashlib.sha256(text.encode()).hexdigest()!=action["textHash"]:raise ValueError("Private desktop input digest changed")
                    ephemeral={**operation,"args":{**operation["args"],"action":{"action":"type","text":text}}}
                if operation["kind"]=="browser" and operation["args"].get("operation")=="credentials":
                    body=operation["args"]["body"]
                    scope={"epoch":self.gate.epoch,"operationId":operation["id"],"sessionId":operation["args"]["browserSessionId"],"desktopSessionId":operation["args"]["sessionId"],"sessionGeneration":operation["args"]["sessionGeneration"],"origin":body["origin"]}
                    if body.get("challengeId"):scope["challengeId"]=body["challengeId"]
                    payload=self.transport.request("credential-grants/"+body["grantId"]+"/consume",scope)
                    ephemeral={**operation,"args":{**operation["args"],"body":payload}}
                if operation["kind"]=="browser" and operation["args"].get("operation")=="upload":
                    import hashlib, base64
                    body=operation["args"]["body"]
                    payload=self.transport.request("browser-files/"+body["fileReference"]+"/consume",{"epoch":self.gate.epoch,"operationId":operation["id"],"sessionId":operation["args"]["browserSessionId"],"sessionGeneration":operation["args"]["sessionGeneration"]})
                    blob=base64.b64decode(payload.get("base64",""),validate=True)
                    if len(blob)!=body["size"] or hashlib.sha256(blob).hexdigest()!=body["sha256"] or any(payload.get(key)!=body[key] for key in ("artifactId","name","mimeType","snapshotId","element")):raise ValueError("Private browser upload binding changed")
                    ephemeral={**operation,"args":{**operation["args"],"body":payload}}
                self.gate.check(operation,inspection,containment)
                started=True
                data=self.desktop.perform(ephemeral)
                self.gate.check(operation,inspection,containment)
                if operation["kind"]=="desktop" and operation["args"].get("operation")=="reset" and data.get("cleanupConfirmed") is True:
                    self.journal.graphical_cleanup(operation)
                if "image" in data:
                    frame={key:data[key] for key in ("image","mimeType","width","height","sequence","frameId","imageHash","observedAt") if key in data}
                    self.transport.request("desktop/frame",{**frame,"epoch":self.gate.epoch,"operationId":operation["id"],
                        "sessionId":operation["args"]["sessionId"],"sessionGeneration":operation["args"]["sessionGeneration"]})
                    data={key:value for key,value in data.items() if key!="image"}
                    data["imagePublished"]=True
            elif operation["kind"] == "session":
                if operation["args"] not in ({"operation":"start"},{"operation":"stop"}):
                    raise ValueError("Session operation must be the registered start or stop")
                started = True
                data = (self.sessions.start if operation["args"]["operation"] == "start" else self.sessions.stop)(self.config["executorId"])
            elif operation["kind"] == "cancel":
                target = self.journal.get(operation["args"]["operationId"])
                if (target["operation"]["executorId"] != self.config["executorId"] or target["operation"]["kind"]!="command"
                        or target["operation"]["taskId"]!=operation["taskId"] or target["operation"]["resourceKey"]!=operation["resourceKey"]):
                    raise ValueError("Job cancellation target is not owned")
                started = True
                self.runtime.cancel(target["operation"]["id"])
                state = self.runtime.inspect(target["operation"]["id"])
                self.journal.receipt(target["operation"]["id"], {"status":"outcome_unknown", "data":self.command_receipt(target["operation"], "outcome_unknown",
                    {"message":"Job cancelled; effects already sent remain uncertain", "cleanupConfirmed":state.get("cleanupConfirmed",False)})})
                if state.get("cleanupConfirmed"):
                    self.release(target["operation"]["id"])
                data = {"cancelled":True, "contained":state.get("cleanupConfirmed",False)}
            else:
                raise ValueError("Unsupported native capability/operation")
            self.journal.receipt(operation["id"], {"status":"succeeded", "data":data})
        except Exception as error:
            if reserved and not started:
                resource_budget=operation["resourceBudget"]
                self.budget.release(operation["id"],self.config["executorId"],resource_budget["memoryBytes"],resource_budget["heavy"])
            if operation["kind"] in ("desktop","browser") and hasattr(error,"dispatched"):started=error.dispatched
            status = "outcome_unknown" if started else "rejected_not_dispatched"
            graphical=operation["kind"] in ("desktop","browser")
            message = "Native graphical operation could not be confirmed; inspect before repeating input" if graphical else type(error).__name__ + ": " + str(error)[:500]
            local_cleanup=not started or operation["kind"] in ("file","file-version") or graphical and getattr(error,"cleanup_confirmed",False)
            data = self.command_receipt(operation, status, {"message":message,"cleanupConfirmed":local_cleanup}) if operation["kind"] == "command" else {"cleanupConfirmed":local_cleanup}
            if graphical:data["code"]=getattr(error,"code","DESKTOP_FAILED")
            self.journal.receipt(operation["id"], {"status":status, "data":data, "message":message})

    def release(self, operation_id):
        operation=self.journal.get(operation_id)["operation"]
        if operation["executorId"]!=self.config["executorId"] or operation["kind"]!="command":
            raise ValueError("Cleanup release belongs to another executor")
        resource_budget=operation.get("resourceBudget")
        if self.budget and resource_budget:
            self.budget.check_binding(operation_id,resource_budget["memoryBytes"],resource_budget["heavy"],self.config["executorId"])
        self.runtime.release(operation_id)
        if self.budget and resource_budget:
            self.budget.release(operation_id,self.config["executorId"],resource_budget["memoryBytes"],resource_budget["heavy"])

    def tick(self):
        self.flush()
        for operation_id in list(self.runtime.active):
            item = self.journal.get(operation_id)
            if item["receipt"] and item["receipt"]["status"] in ("running", "outcome_unknown"):
                state = self.runtime.inspect(operation_id)
                if state["status"] != "running" and (item["receipt"]["status"] == "running" or state.get("cleanupConfirmed")):
                    output = self.runtime.output(operation_id)
                    status = "outcome_unknown" if item["receipt"]["status"] == "outcome_unknown" else state["status"]
                    self.journal.receipt(operation_id, {"status":status,
                        "data":self.command_receipt(item["operation"], status, {**state, **output})})
                    if state.get("cleanupConfirmed"):
                        self.release(operation_id)
                    elif state["status"] == "outcome_unknown":
                        self.gate.close("job-cleanup")
        response = self.transport.request("claim", {"epoch":self.gate.epoch, "waitMs":15000})
        pause = response["pause"]
        self.pause_ack = self.gate.pause(pause)
        if self.gate.needs_reconciliation:
            for operation in response.get("operations",[]):
                if self.journal.receive(operation):
                    data=self.command_receipt(operation,"rejected_not_dispatched",{}) if operation["kind"]=="command" else {}
                    self.journal.receipt(operation["id"],{"status":"rejected_not_dispatched","data":data,
                        "message":"Fresh handshake/reconciliation was required before this claimed operation could start"})
            self.connect()
            return
        for operation in response.get("operations", []):
            if operation["kind"] in ("desktop","browser"):
                thread=threading.Thread(target=self.perform,args=(operation,),daemon=True)
                self.threads[operation["id"]]=thread;thread.start()
            else:self.perform(operation)

    def heartbeat(self):
        while not self.stop_event.wait(15):
            try:
                response = self.transport.request("heartbeat", {"epoch":self.gate.epoch,
                    "readiness":self.readiness(), **({"pauseAck":self.pause_ack} if self.pause_ack else {})})
                self.gate.renew(response["epoch"], response["pause"], response["watchdogMs"] / 1000)
                if hasattr(self.workspace,"acknowledge_publication_conflicts"):
                    self.workspace.acknowledge_publication_conflicts(response.get("publicationConflictAcks",[]))
            except Exception:
                self.gate.close("heartbeat-lost")

    def watchdog(self):
        while not self.stop_event.wait(.5):
            self.gate.watchdog()
            if self.desktop and self.gate.epoch and self.gate.open and not self.desktop_frozen:
                try:self.desktop.gate(self.gate)
                except Exception:self.gate.close("desktop-gate-lost")
            self.threads={key:thread for key,thread in self.threads.items() if thread.is_alive()}

    def run(self):
        for target in (self.heartbeat, self.watchdog):
            threading.Thread(target=target, daemon=True).start()
        while not self.stop_event.is_set():
            try:
                if self.gate.needs_reconciliation:
                    self.connect()
                self.tick()
            except Exception as error:
                self.gate.close("transport-lost")
                # Only handshake/readiness/receipt delivery retries. perform() is
                # always bound to the durable ID and cannot rerun unknown effects.
                print(json.dumps({"executorId":self.config["executorId"], "error":type(error).__name__}), flush=True)
                self.stop_event.wait(2)


def main():
    from .admin_helper import AdminHelper
    from .files import Workspace
    from .job_runtime import HostBudget, JobRuntime, host_snapshot
    from .user_session import UserSession, root_owned_json
    from .filesystem import open_directory
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/okami-executor/supervisor.json")
    parser.add_argument("--prepare-sleep")
    args = parser.parse_args()
    if os.getuid() != 0:
        raise RuntimeError("Native supervisor must run outside bot UIDs via root-owned service")
    if args.prepare_sleep:
        prepare_sleep(args.prepare_sleep)
        return
    config = root_owned_json(args.config)
    registry = root_owned_json("/etc/okami-executor/users.json")
    sessions = UserSession(registry)
    account = sessions.account(config["executorId"])
    account_readiness=sessions.preflight(config["executorId"])
    if account_readiness["state"]!="ready":
        raise RuntimeError("Registered native account/workspace preflight is unavailable: "+account_readiness["reason"])
    state_root = Path("/var/lib/okami-executor") / config["executorId"]
    state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    singleton = open(state_root / "supervisor.lock", "a+b")
    fcntl.flock(singleton.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    helper = AdminHelper(registry, root_owned_json("/etc/okami-executor/apps.json"))
    credential = root_owned_json("/etc/okami-executor/" + config["executorId"] + ".credential.json")["token"]
    workspace = Workspace(account["workspace"], state_root / "files", config.get("retentionDays",30), config.get("maxVersionBytes",2 * 1024**3), account["uid"], account["gid"], config["executorId"])
    home_anchor=open_directory(account["home"])
    budget = HostBudget(host_snapshot(config["hostId"])["memoryTotalBytes"], config.get("reserveBytes",4*1024**3),
        state_path=Path("/var/lib/okami-executor") / ("host-" + config["hostId"] + "-resources.sqlite"))
    from desktop.client import DesktopClient
    desktop=DesktopClient(config["executorId"],account) if account.get("desktop") else None
    supervisor = Supervisor(config, sessions, JobRuntime(sessions, state_root=state_root / "jobs",workspace_fd=workspace.root_fd,home_fd=home_anchor,executor_id=config["executorId"]), workspace,
                            Journal(state_root / "journal.sqlite"),
                            NodeTransport(config["serverOrigin"], config["executorId"], credential), helper, budget=budget,desktop=desktop)
    control = PrivateControl(supervisor, Path("/run/okami-executor") / (config["executorId"] + ".sock"))
    threading.Thread(target=control.serve, daemon=True).start()
    import signal
    for number in (signal.SIGTERM, signal.SIGINT):
        def shutdown(*_):
            supervisor.gate.close("shutdown");supervisor.stop_event.set()
        signal.signal(number,shutdown)
    try:
        supervisor.run()
    finally:
        supervisor.gate.close("shutdown")
        control.close();supervisor.journal.close();workspace.close();budget.close();singleton.close();os.close(home_anchor)


if __name__ == "__main__":
    main()
