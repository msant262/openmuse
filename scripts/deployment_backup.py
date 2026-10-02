#!/usr/bin/env python3
"""OpenMuse MIT. Host-only stopped-writer backup and staged, non-destructive restore."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import uuid

WRITERS = ("server", "browser", "computer")
MOUNTS = {"server": ("server", "/data/openmuse"), "browser": ("browser", "/data"),
          "workspace": ("computer", "/workspace"), "home": ("computer", "/home/node")}
VOLUME_ENV = {"server": "OPENMUSE_SERVER_VOLUME", "browser": "OPENMUSE_BROWSER_VOLUME",
              "workspace": "OPENMUSE_WORKSPACE_VOLUME", "home": "OPENMUSE_HOME_VOLUME"}
ARCHIVE_NAME = re.compile(r"openmuse-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz")
ROOTS = set(MOUNTS) | {"deployment-secrets", "deployment.env", "manifest.json"}


def private_path(value, directory=False, create=False, owners=None):
    path = Path(value).absolute()
    # Do not normalize away an attacker-controlled symlink before checking it.
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Protected paths must not contain symlinks")
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid not in (owners or (os.geteuid(),)) or info.st_mode & 0o077:
        raise ValueError("Protected path must belong to the operator and exclude group/other access")
    if directory != path.is_dir():
        raise ValueError("Protected path has the wrong type")
    return path.resolve()


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_archive(path):
    seen, links, roots = set(), set(), set()
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            p = PurePosixPath(member.name)
            if p.is_absolute() or ".." in p.parts or not p.parts or p.parts[0] not in ROOTS:
                raise ValueError("Archive contains an unsafe path")
            if member.name in seen or len(seen) >= 500000:
                raise ValueError("Archive contains duplicate or excessive entries")
            seen.add(member.name)
            roots.add(p.parts[0])
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("Archive contains a special file")
            if member.issym() or member.islnk():
                if p.parts[0] not in MOUNTS:
                    raise ValueError("Configuration entries must not be links")
                links.add(p)
            if member.islnk():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or ".." in target.parts or not target.parts or target.parts[0] not in MOUNTS:
                    raise ValueError("Archive contains an unsafe hard link")
    for name in seen:
        if any(parent in links for parent in PurePosixPath(name).parents):
            raise ValueError("Archive writes through a link")
    if roots != ROOTS:
        raise ValueError("Archive is missing required state/configuration")


class Deployment:
    def __init__(self, project_dir, env_file, backup_dir, timeout=1800):
        self.project = Path(project_dir).resolve(strict=True)
        self.env = private_path(env_file)
        self.directory = private_path(backup_dir, directory=True, create=True)
        self.secrets = private_path(self.project / "deployment-secrets", directory=True,
                                    owners=(0, 1000) if os.geteuid() == 0 else None)
        self.timeout = timeout
        self.compose = ["docker", "compose", "--project-directory", str(self.project),
                        "--env-file", str(self.env), "-f", str(self.project / "docker-compose.yml")]

    def run(self, argv, **kwargs):
        # Never copy Docker stderr into logs: it can contain expanded configuration.
        return subprocess.run(argv, check=True, timeout=self.timeout,
                              stderr=subprocess.PIPE, **kwargs)

    def output(self, argv):
        return self.run(argv, stdout=subprocess.PIPE).stdout.decode().strip()

    @contextlib.contextmanager
    def lock(self):
        path = self.directory / ".deployment.lock"
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as file:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def containers(self):
        values = {}
        for service in WRITERS:
            container_id = self.output(self.compose + ["ps", "--all", "--quiet", service])
            if not container_id or "\n" in container_id:
                raise ValueError("Backup requires exactly one existing container per writer")
            values[service] = json.loads(self.output(["docker", "inspect", container_id]))[0]
        env = values["server"]["Config"].get("Env", [])
        if any(value.startswith("DATABASE_URL=") and value != "DATABASE_URL=" for value in env):
            raise ValueError("External Postgres requires its own pg_dump backup")
        return values

    @staticmethod
    def stopped(values, clean=False):
        for service, value in values.items():
            state = value["State"]
            if state.get("Running") or state.get("Restarting") or state.get("Paused"):
                raise ValueError(f"{service} is still a writer")
            if clean and (state.get("ExitCode") != 0 or state.get("OOMKilled") or state.get("Error")
                          or state.get("Status") not in ("exited", "created")):
                raise ValueError(f"{service} did not confirm a clean shutdown; no archive copied")

    @staticmethod
    def volumes(values):
        volumes = {}
        for key, (service, destination) in MOUNTS.items():
            matches = [mount for mount in values[service]["Mounts"] if mount["Destination"] == destination]
            if len(matches) != 1 or matches[0]["Type"] != "volume":
                raise ValueError("Required persistent state must be an inspected named volume")
            name = matches[0].get("Name", "")
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", name):
                raise ValueError("Invalid persistent volume identity")
            volumes[key] = name
        if len(set(volumes.values())) != 4:
            raise ValueError("Persistent state volumes must be distinct")
        return volumes

    def helper(self, image, volumes, readonly=True):
        command = ["docker", "run", "--rm", "--init", "--network", "none", "--read-only",
                   "--memory", "128m", "--memory-swap", "128m", "--pids-limit", "64",
                   "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE",
                   "--security-opt", "no-new-privileges:true"]
        if not readonly:
            command += ["--cap-add", "CHOWN", "--cap-add", "FOWNER", "--interactive"]
        for key, name in volumes.items():
            mount = f"type=volume,src={name},dst=/state/{key}"
            command += ["--mount", mount + (",readonly" if readonly else "")]
        return command

    def resume(self, running):
        # Gateway stays in its original namespace; start attached computer before API.
        failures = []
        for service in ("computer", "browser", "server"):
            if service in running:
                try:
                    self.run(self.compose + ["start", service], stdout=subprocess.DEVNULL)
                except (OSError, subprocess.SubprocessError) as error:
                    failures.append(error)
        if failures:
            raise RuntimeError("One or more previous writers could not resume") from failures[0]

    def backup(self, retention_days):
        with self.lock():
            before = self.containers()
            volumes = self.volumes(before)
            running = {key for key, value in before.items() if value["State"].get("Running")}
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            name = f"openmuse-{stamp}-{uuid.uuid4().hex[:8]}.tar.gz"
            destination = self.directory / name
            success = False
            try:
                for service in WRITERS:
                    if service in running:
                        self.run(self.compose + ["stop", service], stdout=subprocess.DEVNULL)
                stopped = self.containers()
                self.stopped(stopped, clean=True)
                if self.volumes(stopped) != volumes:
                    raise ValueError("Deployment volume identity changed during shutdown")
                with tempfile.TemporaryDirectory(prefix=".pending-", dir=self.directory) as staging:
                    pending = Path(staging) / name
                    manifest = Path(staging) / "manifest.json"
                    manifest.write_text(json.dumps({"format": 1, "createdAt": stamp, "volumes": volumes,
                                                   "image": before["server"]["Config"]["Image"]}))
                    manifest.chmod(0o600)
                    command = self.helper(before["server"]["Config"]["Image"], volumes)
                    for source, target in ((self.env, "deployment.env"), (self.secrets, "deployment-secrets"), (manifest, "manifest.json")):
                        command += ["--mount", f"type=bind,src={source},dst=/state/{target},readonly"]
                    command += ["--entrypoint", "tar", before["server"]["Config"]["Image"],
                                "--numeric-owner", "-czf", "-", "-C", "/state", *sorted(ROOTS)]
                    with pending.open("xb") as output:
                        pending.chmod(0o600)
                        self.run(command, stdout=output)
                        output.flush()
                        os.fsync(output.fileno())
                    validate_archive(pending)
                    digest = checksum(pending)
                    metadata = Path(staging) / (name + ".sha256")
                    metadata.write_text(digest + "\n")
                    metadata.chmod(0o600)
                    # Commit checksum first; only a final archive represents a completed backup.
                    os.replace(metadata, self.directory / metadata.name)
                    os.replace(pending, destination)
                success = True
            finally:
                self.resume(running)
            if success:
                cutoff = datetime.datetime.now().timestamp() - retention_days * 86400
                for old in self.directory.iterdir():
                    if ARCHIVE_NAME.fullmatch(old.name) and not old.is_symlink() and old != destination and old.stat().st_mtime < cutoff:
                        old.unlink()
                        digest = old.with_name(old.name + ".sha256")
                        if digest.is_file() and not digest.is_symlink():
                            digest.unlink()
                print(f"Backup complete: {destination.name}; previous writers resumed")
            return destination

    def restore(self, archive_path):
        with self.lock():
            values = self.containers()
            self.stopped(values)
            archive = private_path(archive_path)
            digest = private_path(str(archive) + ".sha256").read_text().strip()
            if not re.fullmatch(r"[a-f0-9]{64}", digest) or checksum(archive) != digest:
                raise ValueError("Backup checksum failed")
            validate_archive(archive)
            suffix = uuid.uuid4().hex[:12]
            restored = self.directory / f"restored-{suffix}"
            restored.mkdir(mode=0o700)
            volumes = {key: f"openmuse-restored-{suffix}-{key}" for key in MOUNTS}
            for name in volumes.values():
                self.run(["docker", "volume", "create", "--label", "openmuse.restore=" + suffix, name], stdout=subprocess.DEVNULL)
            command = self.helper(values["server"]["Config"]["Image"], volumes, readonly=False)
            command += ["--mount", f"type=bind,src={restored},dst=/state/recovery"]
            # Configuration goes into a private staging directory, never over active files.
            command += ["--entrypoint", "tar", values["server"]["Config"]["Image"],
                        "--numeric-owner", "--same-owner", "-xzf", "-", "-C", "/state",
                        "--transform=s,^deployment-secrets,recovery/deployment-secrets,",
                        "--transform=s,^deployment.env$,recovery/deployment.env,",
                        "--transform=s,^manifest.json$,recovery/manifest.json,"]
            with archive.open("rb") as input_file:
                self.run(command, stdin=input_file, stdout=subprocess.DEVNULL)
            # Mounted state is never existing production state, including on a partial failure.
            override = restored / "volumes.env"
            override.write_text("".join(f"{VOLUME_ENV[key]}={name}\n" for key, name in volumes.items()))
            override.chmod(0o600)
            print(f"Restore staged in new volumes. Recovery configuration: {override}")
            print("Writers remain stopped. Review recovery files, select volumes and recreate computer+gateway together.")
            return override


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "restore"))
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--retention-days", type=int, default=14)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--archive")
    args = parser.parse_args()
    if not 1 <= args.retention_days <= 365 or not 30 <= args.timeout_seconds <= 3600:
        parser.error("Retention must be 1..365 days; timeout 30..3600 seconds")
    try:
        deployment = Deployment(args.project_dir, args.env_file, args.backup_dir, args.timeout_seconds)
        if args.operation == "backup":
            deployment.backup(args.retention_days)
        elif args.archive:
            deployment.restore(args.archive)
        else:
            parser.error("restore requires --archive")
    except (ValueError, OSError, RuntimeError, tarfile.TarError, subprocess.SubprocessError):
        # Error category only; never expose secret config or command stderr.
        print("Deployment backup/restore failed. No completed copy is authorized; inspect container states and protected paths.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
