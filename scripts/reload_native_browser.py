"""Reload the native browser and supervisor inside an existing drained publication.

No source, credentials, workspace files, pause state or journal receipts are replaced.
The coordinator owns maintenance; both writers use the existing closed-gate handoff.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

from hybrid_backup import HybridBackup

PHYSICAL = ("activeTasks", "activeConversations", "activeHttpRequests",
            "nativeDeliveries", "workAdmissions", "heldResources")


def drained(status, identity):
    if not status.get("maintenance") or status["maintenance"]["id"] != identity:
        raise ValueError("The publication no longer owns maintenance")
    if any(status[key] != 0 for key in PHYSICAL):
        raise ValueError("Active work must drain before reloading the browser")


def browser_processes(worker, unit, uid):
    result = {}
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if directory.joinpath("comm").read_text().strip() != "node":
                continue
            if unit not in directory.joinpath("cgroup").read_text():
                continue
            if directory.stat().st_uid != uid:
                continue
            if str(worker).encode() not in directory.joinpath("cmdline").read_bytes().split(b"\0"):
                continue
            result[directory.name] = directory.joinpath("stat").read_text().split()[21]
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def reload_browser(client, maintenance_id, worker, expected_sha, *, processes=browser_processes):
    worker = Path(worker)
    if hashlib.sha256(worker.read_bytes()).hexdigest() != expected_sha:
        raise ValueError("Published native browser bytes do not match the selected build")
    before = client.api()
    drained(before, maintenance_id)
    old_processes = processes(worker, client.units[1], client.account["uid"])
    context = client.quiesce()
    if set(context["running"]) != set(client.units):
        raise ValueError("Both native writers must be healthy before publication")
    try:
        # Stopping only the executor leaves the old Node module loaded in the
        # separate graphical session. The shared handoff closes the gate, stops
        # both writers and preserves their prior containment on restart.
        client.stop(context)
    finally:
        client.resume(context)
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        current = processes(worker, client.units[1], client.account["uid"])
        if current:
            break
        time.sleep(0.25)
    else:
        raise ValueError("The native browser did not start under the published build")
    if set(old_processes.items()) & set(current.items()):
        raise ValueError("A browser process from the previous build is still running")
    after = client.api()
    drained(after, maintenance_id)
    if after["pause"] != before["pause"] or after["activeOperations"] != before["activeOperations"]:
        raise ValueError("Runtime pause or historical operation state changed during publication")
    if hashlib.sha256(worker.read_bytes()).hexdigest() != expected_sha:
        raise ValueError("Published browser bytes changed during restart")
    return dict(reloaded=True, workerSha256=expected_sha, previousProcesses=old_processes,
                currentProcesses=current, before=before, after=after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--maintenance-id", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--worker-sha256", required=True)
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Native publication requires the existing root coordinator")
    path = Path(args.receipt)
    if path.exists() or path.is_symlink():
        raise ValueError("Inspect the existing publication receipt before retrying")
    client = HybridBackup(args.config, "native", timeout=45)
    with client.lock():
        config_root = Path(client.config.get("nativeConfig", "/etc/okami-executor"))
        config_paths = [config_root / "users.json", config_root / (client.config["executorId"] + ".json")]
        config_hashes = [hashlib.sha256(value.read_bytes()).hexdigest() for value in config_paths]
        journal = Path(client.config.get("nativeState", "/var/lib/okami-executor")) / client.config["executorId"] / "journal.sqlite"
        def receipts():
            with sqlite3.connect("file:" + str(journal) + "?mode=ro", uri=True) as db:
                rows = dict(db.execute("SELECT id,receipt FROM operations"))
                if any(not value or json.loads(value).get("status") == "running" for value in rows.values()):
                    raise ValueError("Native operations have not drained")
                return rows
        original = receipts()
        result = reload_browser(client, args.maintenance_id, args.worker, args.worker_sha256)
        current = receipts()
        if any(current.get(identity) != value for identity, value in original.items()):
            raise ValueError("A prior native receipt changed during restart")
        if [hashlib.sha256(value.read_bytes()).hexdigest() for value in config_paths] != config_hashes:
            raise ValueError("Native configuration changed during restart")
        result.update(beforeOperationCount=len(original), afterOperationCount=len(current), journalReplaced=False, configsReplaced=False)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "w") as out:
            json.dump(result, out, indent=2)
        print(json.dumps({key: result[key] for key in ("reloaded", "workerSha256", "previousProcesses", "currentProcesses", "beforeOperationCount", "afterOperationCount", "journalReplaced")}))


if __name__ == "__main__":
    main()
