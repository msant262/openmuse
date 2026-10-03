#!/usr/bin/env python3
"""MIT. Root-owned forced SSH command; receives only encrypted immutable archives."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
import tempfile

NAME=re.compile(r"okami-(vps|lenovo)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.tar\.gz\.age")
MAX_BYTES=20*1024**3
FREE_RESERVE=1024**3


def sync_directory(directory):
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def ensure_checksum(destination,digest):
    """Recover archive-only crash states; never acknowledge a missing sidecar."""
    metadata=destination.with_name(destination.name+".sha256")
    with tempfile.NamedTemporaryFile(dir=destination.parent,prefix=".checksum-",delete=False) as output:
        pending=Path(output.name)
        try:
            os.fchmod(output.fileno(),0o600)
            output.write((digest+"\n").encode());output.flush();os.fsync(output.fileno())
            try:os.link(pending,metadata)
            except FileExistsError:pass
            fd=os.open(metadata,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            with os.fdopen(fd,"rb") as existing:
                info=os.fstat(existing.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077:
                    raise ValueError("Invalid checksum sidecar")
                if existing.read(66)!=(digest+"\n").encode():
                    raise ValueError("Existing backup checksum conflicts")
            sync_directory(destination.parent)
        finally:pending.unlink(missing_ok=True)


def receive(directory,name,digest,stream,max_bytes=MAX_BYTES):
    if not NAME.fullmatch(name) or not re.fullmatch(r"[a-f0-9]{64}",digest):raise ValueError("Invalid encrypted archive identity")
    directory=Path(directory).absolute()
    if any(p.is_symlink() for p in (directory,*directory.parents)):raise ValueError("Backup inbox ancestry is a symlink")
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    info=directory.stat()
    if info.st_uid!=os.geteuid() or info.st_mode&0o077:raise ValueError("Backup inbox must be operator-private")
    destination=directory/name
    # Do not overwrite a previous copy, even for a retried SSH delivery.
    if destination.exists():
        measured=hashlib.sha256()
        if destination.is_symlink():raise ValueError("Existing backup identity is a symlink")
        with destination.open("rb") as previous:
            for data in iter(lambda:previous.read(1024*1024),b""):measured.update(data)
        if measured.hexdigest()!=digest:
            raise ValueError("Existing backup identity conflicts")
        # Drain a bounded retry so SSH completes, but still reject a corrupt copy.
        retry_hash=hashlib.sha256();retry_bytes=0
        for data in iter(lambda:stream.read(1024*1024),b""):
            retry_bytes+=len(data)
            if retry_bytes>max_bytes:raise ValueError("Encrypted inbox disk quota exceeded")
            retry_hash.update(data)
        if retry_hash.hexdigest()!=digest:raise ValueError("Encrypted transfer checksum mismatch")
        ensure_checksum(destination,digest)
        return destination
    count=0;checksum=hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=directory,prefix=".receive-",delete=False) as output:
        pending=Path(output.name)
        try:
            os.fchmod(output.fileno(),0o600)
            prefix=stream.read(22)
            if not prefix.startswith(b"age-encryption.org/v1\n"):raise ValueError("Transfer is not a binary age envelope")
            output.write(prefix);checksum.update(prefix);count+=len(prefix)
            while data:=stream.read(1024*1024):
                count+=len(data)
                if count>max_bytes or shutil.disk_usage(directory).free<len(data)+FREE_RESERVE:
                    raise ValueError("Encrypted inbox disk quota exceeded")
                output.write(data);checksum.update(data)
            if checksum.hexdigest()!=digest:raise ValueError("Encrypted transfer checksum mismatch")
            output.flush();os.fsync(output.fileno())
            # link is exclusive and atomic; a concurrent receiver cannot replace a copy.
            try:os.link(pending,destination)
            except FileExistsError:
                # A simultaneous transfer may have won publication of this identity.
                fd=os.open(destination,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,"rb") as previous:
                    if not stat.S_ISREG(os.fstat(previous.fileno()).st_mode):raise ValueError("Invalid backup identity")
                    measured=hashlib.file_digest(previous,"sha256").hexdigest()
                if measured!=digest:raise ValueError("Existing backup identity conflicts")
            ensure_checksum(destination,digest)
        finally:pending.unlink(missing_ok=True)
    return destination


def main():
    os.umask(0o077)
    try:
        if os.geteuid()!=0:raise ValueError("Receiver is a fixed root-owned SSH command")
        config=Path("/etc/okami-backup/receiver.json")
        if any(p.is_symlink() or p.stat().st_uid!=0 or p.stat().st_mode&0o022 for p in (config,*config.parents)):
            raise ValueError("Receiver policy must be root-owned")
        settings=json.loads(config.read_text())
        args=shlex.split(os.environ.get("SSH_ORIGINAL_COMMAND","")) if "SSH_ORIGINAL_COMMAND" in os.environ else ["/usr/local/sbin/okami-backup-receive",*sys.argv[1:]]
        if len(args)!=3 or args[0]!="/usr/local/sbin/okami-backup-receive":raise ValueError("Unauthorized SSH backup command")
        if NAME.fullmatch(args[1]) is None or NAME.fullmatch(args[1])[1]!=settings["peerHost"]:
            raise ValueError("Backup came from the wrong configured host")
        receive(settings["directory"],args[1],args[2],sys.stdin.buffer)
    except (ValueError,OSError,KeyError):
        print("Encrypted backup transfer rejected; no credential details are logged.",file=sys.stderr);return 1
    return 0


if __name__=="__main__":sys.exit(main())
