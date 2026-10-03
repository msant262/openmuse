"""Review native account setup; existing sessions/groups/sudo stay untouched.

Default is a JSON plan. Applying it is an operator deployment action, never a
node RPC. Existing private home permissions require the explicit tighten flag.
"""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from executor.user_session import UserSession,root_owned_json,run
from executor.filesystem import open_directory


def account_plan(account,users=pwd,groups=grp):
    actions=[]
    try:
        current=users.getpwnam(account["user"])
    except KeyError:
        current=None
    if current:
        if (current.pw_uid,current.pw_gid,current.pw_dir)!=(account["uid"],account["gid"],account["home"]):
            raise ValueError("Existing native account does not match registered UID/GID/home")
    else:
        try:
            users.getpwuid(account["uid"])
        except KeyError:
            pass
        else:
            raise ValueError("Registered UID is already owned by another account")
        try:
            groups.getgrgid(account["gid"])
        except KeyError:
            actions.append(["/usr/sbin/groupadd","--gid",str(account["gid"]),account["user"]])
        actions.append(["/usr/sbin/useradd","--uid",str(account["uid"]),"--gid",str(account["gid"]),
            "--home-dir",account["home"],"--create-home","--no-user-group","--shell","/usr/bin/bash",account["user"]])
    return {"existing":bool(current),"commands":actions,"workspace":account["workspace"],
        "home":account["home"],"permissions":"0700","trustMode":account["trustMode"],
        "preserveExistingGroupsAndSudo":True,"preserveExistingSessions":True}


def apply_workspace(account,new_account=False,tighten_home=False):
    home=Path(account["home"])
    workspace=Path(account["workspace"])
    fd=open_directory(home)
    try:
        if os.fstat(fd).st_uid!=account["uid"]:raise ValueError("Registered home must be owned by its native UID")
        if new_account or tighten_home:os.fchmod(fd,0o700)
        for part in workspace.relative_to(home).parts:
            try:child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part,mode=0o700,dir_fd=fd)
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                os.fchown(child,account["uid"],account["gid"])
            if os.fstat(child).st_uid!=account["uid"]:
                os.close(child);raise ValueError("Existing workspace ancestry is not a private native directory")
            os.close(fd);fd=child
        os.fchmod(fd,0o700)
    finally:os.close(fd)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--registry",default="/etc/okami-executor/users.json")
    parser.add_argument("--apply",action="store_true")
    parser.add_argument("--tighten-home",action="store_true",help="Explicitly permit 0700 on an existing bot home")
    args=parser.parse_args()
    registry=root_owned_json(args.registry);UserSession(registry)
    plans={key:account_plan(account) for key,account in registry.items()}
    if args.apply:
        if os.getuid()!=0:raise RuntimeError("Native account setup requires operator root execution")
        for key,account in registry.items():
            for argv in plans[key]["commands"]:run(argv)
            apply_workspace(account,new_account=not plans[key]["existing"],tighten_home=args.tighten_home)
    print(json.dumps({"applied":args.apply,"plans":plans},indent=2))


if __name__=="__main__":main()
