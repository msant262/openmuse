"""Fixed registered native UIDs and units. Never accept a model-selected account."""
import json
import grp
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import uuid
from .filesystem import open_directory

SAFE_ACCOUNT = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
SAFE_EXECUTOR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def run(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True,
                          env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}, timeout=30).stdout


def root_owned_json(path):
    path = Path(path)
    for parent in path.parents:
        info = parent.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
            raise ValueError("Native configuration ancestry must be root-owned and not writable by bots")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISREG(info.st_mode):
            raise ValueError("Native registry/catalog must be root-owned and not writable by bots")
        return json.load(stream)


class UserSession:
    def __init__(self, registry, runner=run):
        self.registry, self.runner = registry, runner
        if len({account["uid"] for account in registry.values()}) != len(registry):
            raise ValueError("Native accounts require unique UIDs")
        for executor_id, account in registry.items():
            if (not SAFE_EXECUTOR.fullmatch(executor_id) or not SAFE_ACCOUNT.fullmatch(account["user"])
                    or not isinstance(account["uid"], int) or account["uid"] < 1000
                    or not isinstance(account["gid"], int) or account["gid"] < 1000
                    or account.get("trustMode") not in ("restricted", "full-trust")):
                raise ValueError("Invalid native account registry")
            if account["user"] in ("marcos", "astrid", "astride", "root"):
                raise ValueError("Personal/operator accounts cannot be native bot registrations")
            desktop=account.get("desktop")
            if desktop:
                if not SAFE_EXECUTOR.fullmatch(account.get("hostId","lenovo")):
                    raise ValueError("Invalid trusted desktop host identity")
                if set(desktop)-{"sessionId","display","profileId","width","height"}:
                    raise ValueError("Unexpected trusted desktop registration fields")
                uuid.UUID(desktop["sessionId"])
                if type(desktop.get("display")) is not int or not 60<=desktop["display"]<=199 or not SAFE_EXECUTOR.fullmatch(desktop.get("profileId","personal")):
                    raise ValueError("Invalid trusted desktop display/profile")
                if any(type(desktop.get(key,default)) is not int or not minimum<=desktop.get(key,default)<=maximum for key,default,minimum,maximum in (("width",1280,320,3840),("height",720,240,2160))):
                    raise ValueError("Invalid trusted desktop dimensions")
        displays=[account["desktop"]["display"] for account in registry.values() if account.get("desktop")]
        if len(set(displays))!=len(displays):raise ValueError("Registered native desktops need distinct X displays")
        for executor_id,account in registry.items():
            home, workspace = Path(account["home"]), Path(account["workspace"])
            if (not home.is_absolute() or home == Path("/") or home not in workspace.parents
                    or any(not re.fullmatch(r"/[A-Za-z0-9._/-]+", path) or ".." in path.split("/") for path in (account["home"], account["workspace"]))):
                raise ValueError("Workspace must be inside registered private home")

    def account(self, executor_id):
        if executor_id not in self.registry:
            raise ValueError("Executor has no registered native account")
        return self.registry[executor_id]

    def slice(self, executor_id):
        return "okami-bots-u" + str(self.account(executor_id)["uid"]) + ".slice"

    def unit(self, executor_id):
        self.account(executor_id)
        return "okami-session@" + executor_id + ".service"

    def start(self, executor_id):
        self.runner(["systemctl", "start", self.unit(executor_id)])
        return {"started": True}

    def stop(self, executor_id):
        self.runner(["systemctl", "stop", self.unit(executor_id)])
        return {"stopped": True}

    def preflight(self, executor_id, proc_root=Path("/proc")):
        account = self.account(executor_id)
        failures = []
        try:
            native = pwd.getpwnam(account["user"])
            if (native.pw_uid, native.pw_gid, native.pw_dir) != (account["uid"], account["gid"], account["home"]):
                failures.append("Registered UID/GID/home does not match the native account")
            groups = {grp.getgrgid(group).gr_name for group in os.getgrouplist(account["user"], account["gid"])}
            if account["trustMode"] == "restricted" and groups.intersection({"sudo", "docker", "lxd", "input"}):
                failures.append("Restricted mode is incompatible with privileged native group membership")
            if account["trustMode"] == "restricted":
                grants = self.runner(["sudo", "-n", "-l", "-U", account["user"]])
                if "NOPASSWD:" in grants or re.search(r"\(\s*ALL\b", grants):
                    failures.append("Restricted mode is incompatible with native sudo privileges")
        except (OSError, KeyError, subprocess.SubprocessError):
            failures.append("Native account identity/privilege preflight is unavailable")
        home=Path(account["home"]);paths=[home]
        current=home
        for part in Path(account["workspace"]).relative_to(home).parts:
            current=current/part;paths.append(current)
        for path in paths:
            try:
                fd=open_directory(path)
                try:info=os.fstat(fd)
                finally:os.close(fd)
                private_group=True
                if info.st_mode&0o070:
                    group=grp.getgrgid(info.st_gid)
                    members=set(group.gr_mem)|{user.pw_name for user in pwd.getpwall() if user.pw_gid==info.st_gid}
                    private_group=info.st_gid==account["gid"] and not (members-{account["user"]})
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != account["uid"] or info.st_mode & 0o007 or not private_group:
                    failures.append("Private account/workspace permissions are unavailable")
            except (OSError,KeyError):
                failures.append("Private account/workspace is unavailable")
        expected = "/okami.slice/okami-bots.slice/"
        escapes = []
        for pid in proc_root.iterdir():
            if not pid.name.isdecimal():
                continue
            try:
                uid_line = next(line for line in (pid / "status").read_text().splitlines() if line.startswith("Uid:"))
                if int(uid_line.split()[1]) == account["uid"] and expected not in (pid / "cgroup").read_text():
                    escapes.append(int(pid.name))
            except (OSError, ValueError, StopIteration):
                continue
        if escapes and account["trustMode"] == "restricted":
            failures.append("Native account has processes outside aggregate slice (SSH/login/cron/user manager)")
        limitation = "Full-trust account has existing processes outside managed workloads; their memory is measured and account-wide containment is unavailable" if escapes and account["trustMode"] == "full-trust" else ""
        return {"state": "unavailable" if failures else "ready", "reason": "; ".join(failures),
                "escapePids": escapes, "trustMode": account["trustMode"],
                "containmentGuaranteed": account["trustMode"] == "restricted" and not failures,
                "limitation":limitation}
