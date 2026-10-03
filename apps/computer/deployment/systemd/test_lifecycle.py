"""Actual owned transient-unit proof; never mutate an existing service/account.

Runs fixed proof unit names, under nobody, with temporary files. The caller must
explicitly allow systemd tests as root. It refuses any pre-existing proof unit.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from executor.filesystem import open_directory
from executor.job_runtime import JobRuntime
from executor.supervisor import Journal
from executor.user_session import run

EXECUTOR="okami-m6-lifecycle-proof"
CONTROLLER="okami-executor@"+EXECUTOR+".service"
CASES={"success":"printf 'owned proof output\\n'; exit 0","failure":"exit 7",
       "cancel":"sleep 20","timeout":"sleep 20"}


def loaded(unit):
    return "LoadState=not-found" not in run(["systemctl","show",unit,"--property=LoadState"])


def until(predicate):
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
        result=predicate()
        if result:return result
        time.sleep(.025)
    raise AssertionError("Owned transient unit did not reach its proof state")


def main():
    if os.getuid()!=0 or sys.argv[1:]!=["--owned-units"]:
        raise RuntimeError("Pass --owned-units under explicitly authorized local sudo")
    native=pwd.getpwnam("nobody")
    if native.pw_uid!=65534:raise RuntimeError("Fixed proof UID is unavailable")
    unit=lambda name:"okami-job-"+hashlib.sha256((EXECUTOR+"-"+name).encode()).hexdigest()+".service"
    owned=[CONTROLLER,*[unit(name) for name in CASES]]
    if any(loaded(name) for name in owned):raise RuntimeError("A proof unit already exists; refusing to touch it")
    slice_unit="okami-bots-u65534.slice"
    # Valid slice names can be synthesized by systemctl show even before use.
    # LoadState=loaded is not proof of a pre-existing active workload slice.
    if "ActiveState=inactive" not in run(["systemctl","show",slice_unit,"--property=ActiveState"]):
        raise RuntimeError("The proof account slice is already active; refusing to share it")
    results=[]
    try:
        run(["systemd-run","--quiet","--unit="+CONTROLLER,"--property=Type=exec",
             "/usr/bin/sleep","60"])
        with tempfile.TemporaryDirectory(prefix="okami-m6-systemd-") as temporary:
            root=Path(temporary);root.chmod(0o755)
            home=root/"home";workspace=home/"workspace";workspace.mkdir(parents=True)
            for path in (home,workspace):path.chmod(0o700);os.chown(path,native.pw_uid,native.pw_gid)
            account={"user":"nobody","uid":native.pw_uid,"gid":native.pw_gid,"home":str(home),"workspace":str(workspace)}
            sessions=SimpleNamespace(account=lambda executor:account if executor==EXECUTOR else None,
                                     slice=lambda executor:slice_unit)
            workspace_fd=open_directory(workspace);home_fd=open_directory(home)
            try:
                runtime=JobRuntime(sessions,workspace_fd=workspace_fd,home_fd=home_fd,executor_id=EXECUTOR)
                with contextlib.closing(Journal(root/"journal.sqlite")) as journal:
                    for name,command in CASES.items():
                        operation={"id":EXECUTOR+"-"+name,"executorId":EXECUTOR,"kind":"command",
                                   "bindingHash":hashlib.sha256(name.encode()).hexdigest(),"executorEpoch":1,
                                   "args":{"command":command,"timeoutMs":1000 if name=="timeout" else 10000}}
                        journal.receive(operation);runtime.launch(operation)
                        if name=="cancel":
                            until(lambda:runtime.inspect(operation["id"])["status"]=="running")
                            runtime.cancel(operation["id"])
                        state=until(lambda:(value if value["status"]!="running" else None)
                                    if (value:=runtime.inspect(operation["id"])) else None)
                        expected={"success":"succeeded","failure":"failed","cancel":"outcome_unknown","timeout":"outcome_unknown"}[name]
                        if state["status"]!=expected or not state["cleanupConfirmed"]:
                            raise AssertionError({"case":name,"state":state,"expected":expected})
                        if name=="success":
                            if state["exitCode"]!=0:raise AssertionError(state)
                            fields=run(["systemctl","show",unit(name),"--property=ActiveState,SubState,ExecMainStatus"])
                            if "ActiveState=active" not in fields or "SubState=exited" not in fields:
                                raise AssertionError("Short success was not retained: "+fields)
                            restarted=JobRuntime(sessions);restarted.adopt(operation)
                            if restarted.inspect(operation["id"])!=state:raise AssertionError("Restart lost retained exit proof")
                        if name=="failure" and state["exitCode"]!=7:raise AssertionError(state)
                        journal.receipt(operation["id"],{"status":state["status"],"data":state})
                        if journal.get(operation["id"])["receipt"]["data"]!=state:raise AssertionError("Receipt was not durable before release")
                        runtime.release(operation["id"])
                        until(lambda:not loaded(unit(name)))
                        results.append({"case":name,**state,"releasedAfterJournalCommit":True})
            finally:os.close(workspace_fd);os.close(home_fd)
    finally:
        for name in reversed(owned):
            if loaded(name):
                run(["systemctl","stop",name])
                subprocess.run(["systemctl","reset-failed",name],capture_output=True)
        run(["systemctl","stop",slice_unit])
    remaining=[name for name in owned if loaded(name)]
    if remaining:raise AssertionError({"remainingOwnedUnits":remaining})
    if "ActiveState=inactive" not in run(["systemctl","show",slice_unit,"--property=ActiveState"]):
        raise AssertionError("Owned proof slice remains active")
    print(json.dumps({"systemd":run(["systemctl","--version"]).splitlines()[0],"kernel":platform.release(),
                      "uid":native.pw_uid,"controller":CONTROLLER,"cases":results,"remainingOwnedUnits":remaining,
                      "proofSliceInactive":True}))


if __name__=="__main__":main()
