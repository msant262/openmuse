"""Descriptor-relative controlled file effects, version WAL, staging and hash ACKs.

This protects these tools only; a user's arbitrary shell/GUI edits need real backups.
Content and SQLite remain on this executor. VPS receives metadata, never a DB volume.
"""
import base64
import contextlib
import ctypes
import fcntl
import fnmatch
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import threading
import time
import uuid
from .filesystem import open_directory

LIMIT = 25 * 1024 * 1024
TEXT_LIMIT = 256 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Workspace:
    def __init__(self, root, state_root, retention_days=30, max_version_bytes=2 * 1024**3, owner_uid=None, owner_gid=None, artifact_namespace=""):
        self.root, self.state_root = Path(root), Path(state_root)
        self.retention_days, self.max_version_bytes = retention_days, max_version_bytes
        self.owner_uid,self.owner_gid=owner_uid,owner_gid
        self.artifact_namespace=artifact_namespace
        self.root_fd=open_directory(self.root,create=True)
        try:
            for directory in (self.state_root, self.state_root / "versions"):
                os.close(open_directory(directory,create=True))
            if owner_uid is not None:
                os.fchown(self.root_fd,owner_uid,owner_gid)
                os.fchmod(self.root_fd,0o700)
        except Exception:
            os.close(self.root_fd);raise
        self.db = sqlite3.connect(self.state_root / "files.sqlite", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,metadata TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL,path TEXT NOT NULL,
                sha256 TEXT NOT NULL,size INTEGER NOT NULL,created REAL NOT NULL,metadata TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,binding TEXT NOT NULL,status TEXT NOT NULL,result TEXT);
            CREATE TABLE IF NOT EXISTS publication_conflicts(id TEXT PRIMARY KEY,metadata TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS publication_conflict_acks(id TEXT PRIMARY KEY);
        """)
        self.lock = threading.RLock()
        self.transaction_depth = threading.local()

    def close(self):
        self.db.close()
        os.close(self.root_fd)

    def anchored_root(self):
        current=open_directory(self.root)
        try:
            expected,actual=os.fstat(self.root_fd),os.fstat(current)
            if (expected.st_dev,expected.st_ino)!=(actual.st_dev,actual.st_ino):
                raise ValueError("Registered workspace root changed")
        finally:os.close(current)
        return os.dup(self.root_fd)

    def parts(self, path):
        if not isinstance(path, str) or len(path) > 2048 or "\x00" in path or "\\" in path:
            raise ValueError("Invalid workspace path")
        parts = path.split("/")
        if parts[:2] != ["", "workspace"] or any(part in (".", "..") for part in parts):
            raise ValueError("Path must be inside /workspace")
        if any(part.startswith(".okami-") for part in parts[2:]):
            raise ValueError("Reserved workspace path")
        return [part for part in parts[2:] if part]

    @contextlib.contextmanager
    def parent(self, path):
        parts = self.parts(path)
        if not parts:
            raise ValueError("File operation requires a file path")
        root = self.anchored_root()
        parent = os.dup(root)
        try:
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = next_fd
            yield parent, parts[-1], root
        finally:
            os.close(parent)
            os.close(root)

    def verify_parent(self, path, parent, root):
        # Reopen every ancestor just before publication; a renamed directory cannot
        # redirect a held fd, but also must not become the advertised logical path.
        verify = self.anchored_root()
        try:
            for part in self.parts(path)[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=verify)
                os.close(verify)
                verify = next_fd
            a, b = os.fstat(parent), os.fstat(verify)
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise ValueError("Workspace parent changed during transfer")
        except OSError as error:
            raise ValueError("Workspace parent changed or became symlink") from error
        finally:
            os.close(verify)

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            if getattr(self.transaction_depth, "active", False):
                yield
                return
            lock = open(self.state_root / "files.lock", "a+b")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            self.transaction_depth.active = True
            try:
                yield
            finally:
                self.transaction_depth.active = False
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                lock.close()

    def read_at(self, parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=parent)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > LIMIT:
                raise ValueError("File must be a private regular file of 25 MB or smaller")
            data = stream.read(LIMIT + 1)
            after = os.fstat(stream.fileno())
            fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
            if len(data) > LIMIT or any(getattr(before, key) != getattr(after, key) for key in fields):
                raise ValueError("Source file changed during transfer")
            entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (entry.st_dev, entry.st_ino) != (before.st_dev, before.st_ino):
                raise ValueError("Source file changed during transfer")
            return data

    def read(self, path):
        with self.parent(path) as (parent, name, root):
            data = self.read_at(parent, name)
            self.verify_parent(path, parent, root)
            return data

    def current(self, parent, name):
        try:
            return self.read_at(parent, name)
        except FileNotFoundError:
            return None

    def metadata(self, path, data, restored_as_copy=False):
        artifact_id = self.artifact_id(path)
        sha = digest(data)
        prior=self.db.execute("SELECT metadata FROM artifacts WHERE id=?",(artifact_id,)).fetchone()
        generation=(json.loads(prior[0]).get("generation",0) if prior else 0)+1
        return {"artifactId": artifact_id, "path": path, "version": sha, "sha256": sha,
                "size": len(data), "mimeType": mimetypes.guess_type(path)[0] or "application/octet-stream",
                "executorLocal": True, "published": False, "restoredAsCopy": restored_as_copy,
                "generation":generation,"versionId":str(uuid.uuid4())}

    def artifact_id(self,path):
        # Preserve existing v1 IDs when upgrading a local journal. New workspaces
        # scope opaque IDs to the executor so one owner can use several accounts.
        row=self.db.execute("SELECT id FROM artifacts WHERE path=?",(path,)).fetchone()
        return row[0] if row else digest(((self.artifact_namespace+":") if self.artifact_namespace else "").encode()+path.encode())

    def effect(self, operation_id, binding):
        if operation_id is None:
            return None
        if not SAFE_ID.fullmatch(operation_id):
            raise ValueError("Invalid operation ID")
        row = self.db.execute("SELECT binding,status,result FROM effects WHERE id=?", (operation_id,)).fetchone()
        if row:
            if row[0] != binding:
                raise ValueError("Operation ID binding conflict")
            if row[1] != "completed":
                raise ValueError("File operation outcome unknown; inspect versions before repeating")
            return json.loads(row[2])
        self.db.execute("INSERT INTO effects VALUES(?,?,?,NULL)", (operation_id, binding, "dispatching"))
        self.db.commit()

    def save_artifact(self, result, operation_id=None):
        self.db.execute("INSERT INTO artifacts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
                        (result["artifactId"], result["path"], json.dumps(result)))
        if operation_id:
            self.db.execute("UPDATE effects SET status='completed',result=? WHERE id=?", (json.dumps(result), operation_id))
        self.db.commit()

    def capture_at(self, path, data, task_id=None, trashed=False):
        used = self.db.execute("SELECT COALESCE(SUM(size),0) FROM versions").fetchone()[0]
        if used + len(data) > self.max_version_bytes or shutil.disk_usage(self.state_root).free < len(data) + 1024 * 1024:
            raise ValueError("File version space budget exhausted; retain originals and free space explicitly")
        version_id = str(uuid.uuid4())
        target = self.state_root / "versions" / version_id
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        metadata = {"id": version_id, "artifactId": self.artifact_id(path), "path": path,
                    "sha256": digest(data), "size": len(data), "createdAt": time.time(),
                    "taskId": task_id, "trashed": trashed, "retentionDays": self.retention_days}
        # WAL commit precedes mutation; a crash may leave an extra recovery version,
        # never a destructive mutation without one.
        self.db.execute("INSERT INTO versions VALUES(?,?,?,?,?,?,?)", (version_id, metadata["artifactId"],
                        path, metadata["sha256"], len(data), time.time(), json.dumps(metadata)))
        self.db.commit()
        directory = os.open(self.state_root / "versions", os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return metadata

    def write(self, path, data, expected_version=None, operation_id=None, exclusive=False,
              cancelled=lambda: False, progress=lambda done, total: None, task_id=None, restored_as_copy=False,
              publication_guard=contextlib.nullcontext):
        if not isinstance(data, bytes) or len(data) > LIMIT:
            raise ValueError("Attachment must be 25 MB or smaller")
        binding = digest(json.dumps([path, digest(data), expected_version, exclusive], separators=(",", ":")).encode())
        with self.transaction(), self.parent(path) as (parent, name, root):
            cached = self.effect(operation_id, binding)
            if cached is not None:
                return cached
            old = self.current(parent, name)
            if (digest(old) if old is not None else None) != expected_version or (exclusive and old is not None):
                raise ValueError("Current file version conflict; no silent overwrite")
            previous = self.capture_at(path, old, task_id) if old is not None else None
            if shutil.disk_usage(self.root).free < len(data) + 1024 * 1024:
                raise ValueError("Insufficient staging space")
            stage = ".okami-stage-" + uuid.uuid4().hex
            fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent)
            if self.owner_uid is not None:
                os.fchown(fd,self.owner_uid,self.owner_gid)
            preserve_stage=False
            try:
                with os.fdopen(fd, "wb") as stream:
                    for offset in range(0, max(1, len(data)), 65536):
                        if cancelled():
                            raise ValueError("Transfer cancelled before publication")
                        stream.write(data[offset:offset + 65536])
                        progress(min(offset + 65536, len(data)), len(data))
                    stream.flush()
                    os.fsync(stream.fileno())
                    staged=os.fstat(stream.fileno())
                if cancelled():
                    raise ValueError("Transfer cancelled before publication")
                self.verify_parent(path, parent, root)
                entry=os.stat(stage,dir_fd=parent,follow_symlinks=False)
                if (entry.st_dev,entry.st_ino)!=(staged.st_dev,staged.st_ino) or self.read_at(parent,stage)!=data:
                    raise ValueError("Staged file changed before publication; no verified artifact")
                if self.current(parent, name) != old:
                    raise ValueError("Current file changed during transfer")
                with publication_guard():
                    if cancelled():raise ValueError("Transfer cancelled before publication")
                    if old is None:
                        # link() gives exclusive publication; rename() would silently
                        # overwrite a file created by a human between check and publish.
                        os.link(stage, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                        os.unlink(stage, dir_fd=parent)
                    else:
                        # Linux RENAME_EXCHANGE lets us inspect the exact displaced
                        # inode. A human changing the destination between the check
                        # and rename cannot be silently overwritten by this tool.
                        self.exchange(parent,stage,name)
                        try:
                            displaced=self.read_at(parent,stage)
                        except Exception:
                            preserve_stage=True
                            published=os.stat(name,dir_fd=parent,follow_symlinks=False)
                            if (published.st_dev,published.st_ino)==(staged.st_dev,staged.st_ino) and self.read_at(parent,name)==data:
                                self.exchange(parent,stage,name)
                                preserve_stage=False
                            else:
                                # A later human edit owns the destination now. Keep
                                # the displaced inode for operator recovery, even if
                                # it became a symlink that we must never dereference.
                                preserve_stage=True
                            raise
                        if displaced!=old:
                            preserve_stage=True
                            if self.read_at(parent,name)==data:
                                self.exchange(parent,stage,name)
                            else:
                                self.capture_at(path,displaced,task_id)
                            preserve_stage=False
                            raise ValueError("Human file changed at publication; recover instead of silent overwrite")
                    os.fsync(parent)
                    self.verify_parent(path,parent,root)
                    published=os.stat(name,dir_fd=parent,follow_symlinks=False)
                    if (published.st_dev,published.st_ino)!=(staged.st_dev,staged.st_ino) or self.read_at(parent,name)!=data:
                        preserve_stage=old is not None
                        raise ValueError("Published file changed; outcome unknown and original recovery preserved")
                    result = self.metadata(path, data, restored_as_copy)
                    if previous:
                        result["previousVersionId"] = previous["id"]
                    self.save_artifact(result, operation_id)
                    return result
            finally:
                try:
                    if not preserve_stage:os.unlink(stage, dir_fd=parent)
                except FileNotFoundError:
                    pass

    @staticmethod
    def exchange(parent,left,right):
        Workspace.rename_flags(parent,left,right,2)

    @staticmethod
    def rename_flags(parent,left,right,flags):
        libc=ctypes.CDLL(None,use_errno=True)
        rename=getattr(libc,"renameat2",None)
        if rename is None:
            raise ValueError("Atomic version publication requires Linux renameat2")
        result=rename(ctypes.c_int(parent),ctypes.c_char_p(left.encode()),ctypes.c_int(parent),ctypes.c_char_p(right.encode()),ctypes.c_uint(flags))
        if result!=0:
            error=ctypes.get_errno()
            raise OSError(error,os.strerror(error))

    def artifact(self, artifact_id):
        if not isinstance(artifact_id, str) or not SAFE_ID.fullmatch(artifact_id):
            raise ValueError("Invalid artifact ID")
        row = self.db.execute("SELECT metadata FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row:
            raise ValueError("Artifact is not registered to this workspace")
        return json.loads(row[0])

    def capture(self, artifact_id, expected_version, task_id=None, cancelled=lambda:False):
        with self.transaction():
            artifact = self.artifact(artifact_id)
            data = self.read(artifact["path"])
            if digest(data) != expected_version:
                raise ValueError("Current file version conflict")
            if cancelled():raise ValueError("Recovery cancelled before capture")
            version=self.capture_at(artifact["path"], data, task_id)
            if cancelled():raise ValueError("Recovery cancelled after capture; original preserved")
            return version

    def trash(self, artifact_id, expected_version, task_id=None, cancelled=lambda:False,publication_guard=contextlib.nullcontext):
        with self.transaction():
            artifact = self.artifact(artifact_id)
            with self.parent(artifact["path"]) as (parent, name, root):
                data = self.read_at(parent, name)
                if digest(data) != expected_version:
                    raise ValueError("Current file version conflict")
                version = self.capture_at(artifact["path"], data, task_id, trashed=True)
                self.verify_parent(artifact["path"], parent, root)
                if cancelled():raise ValueError("Recovery cancelled before deletion")
                with publication_guard():
                    if cancelled():raise ValueError("Recovery cancelled before deletion")
                    stage=".okami-trash-"+uuid.uuid4().hex
                    os.rename(name,stage,src_dir_fd=parent,dst_dir_fd=parent)
                    try:
                        moved=self.read_at(parent,stage)
                        if moved!=data:
                            raise ValueError("Human file changed at trash; no silent deletion")
                        if cancelled():raise ValueError("Recovery cancelled before deletion")
                    except Exception as error:
                        # Even reading the displaced inode may fail (oversize,
                        # directory, symlink, I/O). Never unlink it on that path or
                        # depend on additional backup quota. Restore only if the
                        # original name is still absent, otherwise retain the inode.
                        try:
                            self.rename_flags(parent,stage,name,1)  # RENAME_NOREPLACE
                        except OSError:
                            retained=artifact["path"].rsplit("/",1)[0]+"/"+stage
                            raise ValueError("Trash verification failed; displaced entry retained for operator recovery at "+retained) from error
                        os.fsync(parent)
                        raise
                    os.unlink(stage,dir_fd=parent)
                    os.fsync(parent)
                    self.save_artifact({**artifact, "trashed": True, "published": False, "version": None})
                    return version

    def versions(self, artifact_id):
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT metadata FROM versions WHERE artifact_id=? ORDER BY created", (artifact_id,))]

    def restore(self, version_id, expected_current_version, task_id=None,cancelled=lambda:False,publication_guard=contextlib.nullcontext):
        if not isinstance(version_id, str) or not SAFE_ID.fullmatch(version_id):
            raise ValueError("Invalid version ID")
        with self.transaction():
            row = self.db.execute("SELECT metadata FROM versions WHERE id=?", (version_id,)).fetchone()
            if not row:
                raise ValueError("Version is not registered to this workspace")
            version = json.loads(row[0])
            target = self.state_root / "versions" / version_id
            fd = os.open(target, os.O_RDONLY | NOFOLLOW)
            with os.fdopen(fd, "rb") as stream:
                data = stream.read(LIMIT + 1)
            if digest(data) != version["sha256"]:
                raise ValueError("Recovery version hash mismatch")
            path = version["path"]
            try:
                current = digest(self.read(path))
            except FileNotFoundError:
                current = None
            conflict = current != expected_current_version
            if conflict:
                base, extension = os.path.splitext(path)
                path = base + "-recovered-" + uuid.uuid4().hex[:8] + extension
                current = None
            return self.write(path, data, expected_version=current, task_id=task_id,
                              exclusive=conflict, restored_as_copy=conflict,cancelled=cancelled,publication_guard=publication_guard)

    def mkdir(self, path,cancelled=lambda:False,publication_guard=contextlib.nullcontext):
        with self.transaction(), self.parent(path) as (parent, name, root):
            self.verify_parent(path, parent, root)
            with publication_guard():
                if cancelled():raise ValueError("File operation cancelled before directory mutation")
                try:
                    os.mkdir(name, mode=0o700, dir_fd=parent)
                    if self.owner_uid is not None:
                        os.chown(name,self.owner_uid,self.owner_gid,dir_fd=parent,follow_symlinks=False)
                except FileExistsError:
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
                    os.close(fd)
                os.fsync(parent)
        return {"path": path}

    def list(self, path="/workspace"):
        parts = self.parts(path)
        fd = self.anchored_root()
        try:
            for part in parts:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            entries = []
            for name in sorted(os.listdir(fd))[:1000]:
                if name.startswith(".okami-"):
                    continue
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file"
                entries.append({"name": name, "path": path.rstrip("/") + "/" + name, "type": kind, "size": info.st_size})
            return {"path": path, "entries": entries}
        finally:
            os.close(fd)

    def search(self, path, parameters, cancelled=lambda: False):
        """Hermes-style glob/rg search over descriptor-checked owned files.

        No shell, symlink following, native DB writes or whole-tree content cache.
        Limits describe partial coverage instead of turning it into absence.
        """
        self.parts(path)
        target = parameters.get("target", "content")
        pattern = parameters.get("pattern")
        file_glob = parameters.get("file_glob")
        output = parameters.get("output_mode", "content")
        order = parameters.get("order", "discovery")
        limit, offset, context = parameters.get("limit", 50), parameters.get("offset", 0), parameters.get("context", 0)
        if (target not in ("files", "content") or output not in ("content", "files_only", "count")
                or order not in ("discovery", "modified") or not isinstance(pattern, str)
                or not pattern or len(pattern) > 1024 or "\x00" in pattern
                or file_glob is not None and (not isinstance(file_glob, str) or len(file_glob) > 256)
                or any(type(n) is not int for n in (limit, offset, context))
                or not 1 <= limit <= 500 or not 0 <= offset <= 100000 or not 0 <= context <= 5):
            raise ValueError("Invalid file search parameters")
        filename_pattern = pattern if any(c in pattern for c in "*?[") else "*" + pattern + "*"
        deadline = time.monotonic() + 8
        results, skipped, reasons = [], 0, set()
        matched = 0
        sort_all = target == "files" and order == "modified"

        def remember(item):
            nonlocal matched
            matched += 1
            if sort_all or offset < matched <= offset + limit:
                results.append(item)
        scanned, read_bytes = 0, 0
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"}
        binary = shutil.which("rg")
        if target == "content" and not binary:
            raise ValueError("Native regex search is unavailable")
        rg = [binary or "rg", "--no-config", "--regex-size-limit", "2M", "--dfa-size-limit", "2M"]
        if target == "content":
            try:
                check = subprocess.run(rg + ["--", pattern, "-"], input=b"", capture_output=True, timeout=1, env=env)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ValueError("Native regex search is unavailable") from error
            if check.returncode not in (0, 1):
                raise ValueError("Invalid content regex: " + check.stderr.decode("utf8", "replace")[:300])

        def stopped():
            if cancelled():
                raise ValueError("File search cancelled")
            if time.monotonic() >= deadline:
                reasons.add("search_time_limit")
                return True
            return False

        def files_at(logical):
            nonlocal scanned, skipped
            fd = self.anchored_root()
            try:
                for part in self.parts(logical):
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = child
                names = []
                with os.scandir(fd) as iterator:
                    for item in iterator:
                        if stopped():
                            break
                        if item.name.startswith(".okami-"):
                            continue
                        scanned += 1
                        if scanned > 20000:
                            reasons.add("entry_scan_limit")
                            break
                        names.append(item.name)
                for name in sorted(names):
                    if stopped():
                        return
                    child_path = logical.rstrip("/") + "/" + name
                    try:
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            if scanned < 20000:
                                yield from files_at(child_path)
                            else:
                                reasons.add("entry_scan_limit")
                        elif stat.S_ISREG(info.st_mode):
                            yield child_path, info
                    except (OSError, ValueError):
                        skipped += 1
                        reasons.add("unreadable_entry")
            finally:
                os.close(fd)

        if path.rstrip("/") == "/workspace":
            candidates = files_at("/workspace")
        else:
            with self.parent(path) as (parent, name, root):
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    raise ValueError("File search cannot follow symlinks")
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                    raise ValueError("Choose a regular file or owned directory")
            candidates = files_at(path) if stat.S_ISDIR(info.st_mode) else iter([(path, info)])
        page_full = False
        try:
            for logical, info in candidates:
                if stopped():
                    break
                relative = logical.removeprefix(path.rstrip("/") + "/")
                name = logical.rsplit("/", 1)[-1]
                if file_glob and not (fnmatch.fnmatchcase(relative, file_glob) or fnmatch.fnmatchcase(name, file_glob)):
                    continue
                if target == "files":
                    if not (fnmatch.fnmatchcase(relative.casefold(), filename_pattern.casefold()) or fnmatch.fnmatchcase(name.casefold(), filename_pattern.casefold())):
                        continue
                    remember({"path": logical, "size": info.st_size, "modifiedAt": info.st_mtime})
                else:
                    if info.st_size > TEXT_LIMIT or read_bytes + info.st_size > 20 * 1024 * 1024:
                        skipped += 1
                        reasons.add("content_byte_limit")
                        continue
                    try:
                        data = self.read(logical)
                        read_bytes += len(data)
                        if len(data) > TEXT_LIMIT or read_bytes > 20 * 1024 * 1024:
                            skipped += 1
                            reasons.add("content_byte_limit")
                            continue
                        if b"\x00" in data:
                            continue
                        text = data.decode("utf8")
                    except UnicodeDecodeError:
                        continue  # binary files are outside the declared UTF-8 scope
                    except (OSError, ValueError):
                        skipped += 1
                        reasons.add("unreadable_file")
                        continue
                    mode = (["--count"] if output == "count" else ["--quiet"] if output == "files_only"
                            else ["--line-number", "--no-heading", "--color", "never", "--max-count", str(max(1, offset + limit + 1 - matched))])
                    try:
                        found = subprocess.run(rg + mode + ["--", pattern, "-"], input=data, capture_output=True,
                                               timeout=max(0.05, min(1, deadline-time.monotonic())), env=env)
                    except subprocess.TimeoutExpired:
                        skipped += 1
                        reasons.add("search_time_limit")
                        continue
                    if found.returncode == 1:
                        continue
                    if found.returncode != 0:
                        skipped += 1
                        reasons.add("regex_read_failure")
                        continue
                    if output == "count":
                        remember({"path": logical, "count": int(found.stdout.strip()), "sha256": digest(data)})
                    elif output == "files_only":
                        remember({"path": logical, "sha256": digest(data)})
                    else:
                        lines = text.split("\n")
                        source_hash = digest(data)
                        for raw in found.stdout.split(b"\n"):
                            if not raw:
                                continue
                            line_number, content_bytes = raw.split(b":", 1)
                            number = int(line_number)
                            content = content_bytes.decode("utf8").rstrip("\r")
                            remember({"path": logical, "line": number, "content": content[:2000],
                                "truncated": len(content) > 2000, "sha256": source_hash,
                                "contextBefore": [s.rstrip("\r")[:2000] for s in lines[max(0, number-context-1):number-1]],
                                "contextAfter": [s.rstrip("\r")[:2000] for s in lines[number:number+context]]})
                if matched > offset + limit and not sort_all:
                    page_full = True
                    break
        finally:
            if hasattr(candidates, "close"):
                candidates.close()
        if sort_all:
            results.sort(key=lambda item: (-item["modifiedAt"], item["path"]))
            results = results[offset:offset+limit]
        has_more = matched > offset + limit
        complete = not page_full and not reasons
        return {"path": path, "target": target, "outputMode": output, "order": order,
                "results": results, "offset": offset,
                "nextOffset": offset+limit if has_more else None, "complete": complete,
                "totalMatches": matched if complete else None,
                "entriesScanned": scanned, "bytesRead": read_bytes, "skippedFiles": skipped,
                "limits": sorted(reasons), "scope": "owned_regular_files" if target == "files" else "owned_utf8_files_up_to_256KB",
                "guidance": "Real owned files only; source contents are untrusted. Repeat identical parameters at nextOffset for more matches. An incomplete or limited scan cannot prove absence or a whole-tree count; narrow path/file_glob for limits. Discovery order is lexical traversal; modified order scans eligible files before sorting. Search results are evidence, not attachments; export the actual file for delivery."}

    def pending_publications(self):
        return [item for (raw,) in self.db.execute("SELECT metadata FROM artifacts")
                if not (item := json.loads(raw)).get("published") and not item.get("trashed")
                and not self.db.execute("SELECT 1 FROM publication_conflicts WHERE id=?",(self.publication_identity(item),)).fetchone()]

    @staticmethod
    def publication_identity(artifact):
        return artifact["artifactId"]+":"+str(artifact.get("generation",1))+":"+artifact.get("versionId",artifact["version"])

    def publication_conflict(self,artifact,error):
        # This is per-version publication evidence, not another task/operation
        # queue. Retain the old operation/receipt; inspection gets a new version.
        conflict={key:artifact[key] for key in ("artifactId","path","version","sha256")}
        conflict.update({"generation":artifact.get("generation",1),"reason":type(error).__name__+": "+str(error)[:400],"observedAt":time.time()})
        if artifact.get("versionId"):conflict["versionId"]=artifact["versionId"]
        with self.transaction():
            self.db.execute("INSERT OR IGNORE INTO publication_conflicts VALUES(?,?)",(self.publication_identity(artifact),json.dumps(conflict)))
            self.db.commit()
        return conflict

    def publication_conflicts(self):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute("""
                SELECT c.metadata FROM publication_conflicts c
                LEFT JOIN publication_conflict_acks a ON a.id=c.id
                WHERE a.id IS NULL ORDER BY c.rowid ASC LIMIT 100
            """)]

    def acknowledge_publication_conflicts(self, conflicts):
        # Delivery ACK never erases the conflict: stale origin bytes must remain
        # blocked after restart. Only the persisted VPS response drains this outbox.
        if not isinstance(conflicts,list) or len(conflicts)>100:
            raise ValueError("Invalid publication conflict acknowledgement")
        with self.transaction():
            for conflict in conflicts:
                if not isinstance(conflict,dict):
                    raise ValueError("Invalid publication conflict acknowledgement")
                identity=self.publication_identity(conflict)
                row=self.db.execute("SELECT metadata FROM publication_conflicts WHERE id=?",(identity,)).fetchone()
                if not row:
                    continue
                saved=json.loads(row[0])
                if any(saved.get(key)!=conflict.get(key) for key in
                       ("artifactId","path","version","sha256","generation","versionId")):
                    continue
                self.db.execute("INSERT OR IGNORE INTO publication_conflict_acks VALUES(?)",(identity,))
            self.db.commit()

    def verify_publication(self,artifact):
        actual=self.read(artifact["path"])
        if len(actual)!=artifact["size"] or digest(actual)!=artifact["sha256"] or artifact["version"]!=artifact["sha256"]:
            raise ValueError("Origin artifact changed before publication ACK; inspect the current file")
        return artifact

    def acknowledge(self, artifact_id, version, sha256, generation=None, version_id=None):
        with self.transaction():
            artifact = self.artifact(artifact_id)
            if (artifact["version"], artifact["sha256"]) != (version, sha256):
                raise ValueError("Artifact ACK does not match published version/hash")
            if ((generation is not None and artifact.get("generation")!=generation)
                    or (version_id is not None and artifact.get("versionId")!=version_id)):
                raise ValueError("Artifact ACK does not match published generation/version ID")
            self.save_artifact({**artifact, "published": True})

    def prune(self):
        # Retention is explicit, never a replacement for backup. No automatic prune
        # during writes: operators must first publish/backup metadata they need.
        cutoff = time.time() - self.retention_days * 86400
        with self.transaction():
            for version_id, in self.db.execute("SELECT id FROM versions WHERE created<?", (cutoff,)).fetchall():
                os.unlink(self.state_root / "versions" / version_id)
                self.db.execute("DELETE FROM versions WHERE id=?", (version_id,))
            self.db.commit()

    def handle(self, envelope, cancelled=lambda: False, progress=lambda done, total: None,publication_guard=contextlib.nullcontext):
        args, kind = envelope["args"], envelope["kind"]
        operation, path = args.get("operation"), args.get("path", "/workspace")
        if kind == "file-version":
            if operation == "capture":
                return self.capture(args["artifactId"], args["expectedVersion"], envelope["taskId"],cancelled=cancelled)
            if operation == "trash":
                return self.trash(args["artifactId"], args["expectedVersion"], envelope["taskId"],cancelled=cancelled,publication_guard=publication_guard)
            if operation == "restore":
                return self.restore(args["versionId"], args.get("expectedCurrentVersion"), envelope["taskId"],cancelled=cancelled,publication_guard=publication_guard)
        if operation == "list":
            return self.list(path)
        if operation == "search":
            return self.search(path, args.get("parameters", {}), cancelled=cancelled)
        if operation in ("read", "read_binary", "stat"):
            data = self.read(path)
            metadata = self.metadata(path, data)
            if operation == "read":
                if len(data) > TEXT_LIMIT:
                    raise ValueError("Text must be 256 KB or smaller")
                return {**metadata, "text": data.decode("utf8")}
            if operation == "read_binary":
                return {**metadata, "base64": base64.b64encode(data).decode("ascii")}
            self.save_artifact(metadata)
            return metadata
        if operation == "mkdir":
            return self.mkdir(path,cancelled=cancelled,publication_guard=publication_guard)
        if operation in ("write", "write_binary"):
            data = args["text"].encode("utf8") if operation == "write" else base64.b64decode(args["base64"], validate=True)
            if operation == "write" and len(data) > TEXT_LIMIT:
                raise ValueError("Text must be 256 KB or smaller")
            expected=args.get("expectedVersion")
            if args.get("captureCurrent") is True:
                if "expectedVersion" in args:
                    raise ValueError("Choose a bound expected version or first controlled capture")
                try:
                    expected=digest(self.read(path))
                except FileNotFoundError:
                    expected=None
            return self.write(path, data, expected_version=expected, operation_id=envelope["id"],
                              cancelled=cancelled, progress=progress, task_id=envelope["taskId"], exclusive=args.get("exclusive", False),publication_guard=publication_guard)
        raise ValueError("Unsupported controlled file operation")
