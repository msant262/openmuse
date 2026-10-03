#!/usr/bin/env python3
"""MIT. Fixed forced SSH entrypoint for the existing Lenovo's encrypted snapshot."""
import os
import shlex
import sys
import uuid


def main():
    if os.geteuid()!=0:return 1
    try:
        args=shlex.split(os.environ.get("SSH_ORIGINAL_COMMAND",""))
        if len(args)!=2 or args[0]!="/usr/local/sbin/okami-backup-native":raise ValueError("Invalid fixed backup command")
        batch=str(uuid.UUID(args[1]))
    except ValueError:return 1
    # This peer never initiates pause, kills work, selects paths or starts a job.
    # It requires the coordinator's already-paused, idle API status.
    os.execv("/usr/bin/python3",["/usr/bin/python3","/opt/okami-computer/repository/scripts/deployment_backup.py",
        "backup","--mode","native","--config","/etc/okami-backup/native.json","--batch-id",batch,"--transfer"])


if __name__=="__main__":sys.exit(main())
