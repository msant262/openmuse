#!/usr/bin/env python3
"""MIT. Root operator bootstrap: random file secret, only its digest in API env."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile

PREFIX="DEPLOYMENT_OPERATOR_TOKEN_SHA256"
TOKEN=re.compile(r"odb1\.[A-Za-z0-9_-]{43}")


def protected(path,private=False):
    path=Path(path).absolute()
    for entry in (path,*path.parents):
        if entry.is_symlink():raise ValueError("Operator paths cannot contain symlinks")
        if not entry.exists():continue
        info=entry.stat()
        sticky_root=entry.is_dir() and info.st_uid==0 and bool(info.st_mode&stat.S_ISVTX)
        if info.st_uid not in (0,os.geteuid()) or info.st_mode&0o022 and not sticky_root:
            raise ValueError("Operator input ancestry must exclude writable user directories")
    if private and (path.stat().st_uid!=os.geteuid() or path.stat().st_mode&0o077):
        raise ValueError("Operator file/directory must be private to its owner")
    return path


def sync_env(token_path,env_path):
    token_path=protected(token_path,private=True);env_path=protected(env_path,private=True)
    token=token_path.read_text().strip()
    if not TOKEN.fullmatch(token):raise ValueError("Not a scoped operator token")
    value=hashlib.sha256(token.encode()).hexdigest()
    lines=env_path.read_text().splitlines(keepends=True)
    pattern=re.compile(r"^\s*(?:export\s+)?DEPLOYMENT_OPERATOR_TOKEN_SHA256\s*=")
    matches=[i for i,line in enumerate(lines) if pattern.match(line)]
    if len(matches)>1:raise ValueError("Operator hash env declaration is ambiguous")
    if matches:lines[matches[0]]=PREFIX+"="+value+"\n"
    else:
        if lines and not lines[-1].endswith("\n"):lines[-1]+="\n"
        lines.append(PREFIX+"="+value+"\n")
    with tempfile.NamedTemporaryFile(dir=env_path.parent,delete=False) as stream:
        temporary=Path(stream.name)
        try:
            os.fchmod(stream.fileno(),0o600);stream.write("".join(lines).encode());stream.flush();os.fsync(stream.fileno())
            os.replace(temporary,env_path)
        finally:temporary.unlink(missing_ok=True)
    return value


def create(token_path,env_path):
    token_path=protected(token_path);protected(token_path.parent,private=True);protected(env_path,private=True)
    token="odb1."+base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    fd=os.open(token_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,"w") as stream:stream.write(token+"\n");stream.flush();os.fsync(stream.fileno())
    # On a failed env write preserve the private token. sync-env can safely
    # recover the same bootstrap; never replace a secret after an uncertain ACK.
    return sync_env(token_path,env_path)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation",choices=("create","sync-env"))
    parser.add_argument("--output",type=Path,required=True);parser.add_argument("--env-file",type=Path,required=True)
    args=parser.parse_args();os.umask(0o077)
    try:
        if os.geteuid()!=0:raise ValueError("Operator bootstrap requires root")
        value=(create if args.operation=="create" else sync_env)(args.output,args.env_file)
        print(json.dumps({"configured":True,PREFIX:value,"plaintextPrinted":False,"apiRestartRequired":True}));return 0
    except (OSError,ValueError):
        print(json.dumps({"configured":False,"error":"Protected operator bootstrap failed; inspect file modes and use sync-env for an existing token"}));return 1


if __name__=="__main__":raise SystemExit(main())
