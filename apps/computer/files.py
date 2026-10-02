"""OpenMuse MIT. Fixed workspace filesystem API; opened components reject symlinks."""
import base64
import json
import os
import stat
import sys
import uuid

LIMIT = 256 * 1024
BINARY_LIMIT = 25 * 1024 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Workspace:
    def __init__(self, root="/workspace"):
        # Only the trusted test harness may supply another root; never RPC input.
        self.root = root

    def parts(self, path):
        if not isinstance(path, str) or len(path) > 2048 or "\x00" in path or ".." in path.split("/"):
            raise ValueError("Invalid workspace path")
        parts = path.split("/")
        if parts[:2] != ["", "workspace"]:
            raise ValueError("Path must be inside /workspace")
        return [part for part in parts[2:] if part and part != "."]

    def directory(self, parts, create=False):
        directory = os.open(self.root, DIRECTORY_FLAGS)
        try:
            for part in parts:
                if create:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=directory)
                    except FileExistsError:
                        pass
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
                os.close(directory)
                directory = child
            return directory
        except BaseException:
            os.close(directory)
            raise

    def open_read(self, path, limit=BINARY_LIMIT):
        parts = self.parts(path)
        if not parts:
            raise ValueError("Choose a file")
        directory = self.directory(parts[:-1])
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        finally:
            os.close(directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            os.close(fd)
            raise ValueError("Choose a regular file within the size limit")
        return fd

    def write_bytes(self, path, content, limit=BINARY_LIMIT):
        parts = self.parts(path)
        if not parts or len(content) > limit:
            raise ValueError("Choose a file within the size limit")
        directory = self.directory(parts[:-1])
        temporary = ".openmuse-" + uuid.uuid4().hex
        try:
            try:
                info = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("Only regular files can be replaced")
            except FileNotFoundError:
                pass
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, "wb") as target:
                target.write(content)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.close(directory)

    def handle(self, request):
        path = request["path"]
        parts = self.parts(path)
        operation = request["operation"]
        result = {"path": "/workspace" + ("/" + "/".join(parts) if parts else "")}
        if operation in ("list", "mkdir"):
            directory = self.directory(parts, create=operation == "mkdir")
            try:
                if operation == "list":
                    entries = []
                    with os.scandir(directory) as iterator:
                        for entry in iterator:
                            if len(entries) >= 1000:
                                raise ValueError("Directory exceeds 1000 entries")
                            info = entry.stat(follow_symlinks=False)
                            kind = "symlink" if stat.S_ISLNK(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "file"
                            entries.append({"name": entry.name, "path": result["path"] + "/" + entry.name, "type": kind, "size": info.st_size})
                    result["entries"] = sorted(entries, key=lambda e: (e["type"] != "directory", e["name"]))
            finally:
                os.close(directory)
        elif operation in ("read", "read_pdf", "read_binary"):
            limit = LIMIT if operation == "read" else 10 * 1024 * 1024 if operation == "read_pdf" else BINARY_LIMIT
            with os.fdopen(self.open_read(path, limit), "rb") as source:
                content = source.read(limit + 1)
            if len(content) > limit:
                raise ValueError("File exceeds size limit")
            if operation == "read_pdf" and not content.startswith(b"%PDF-"):
                raise ValueError("Choose a PDF file")
            if operation == "read":
                result["text"] = content.decode("utf-8", errors="strict")
            else:
                result["base64"] = base64.b64encode(content).decode("ascii")
        elif operation in ("write", "write_pdf", "write_binary"):
            content = request["text"].encode("utf-8") if operation == "write" else base64.b64decode(request["base64"], validate=True)
            limit = LIMIT if operation == "write" else 10 * 1024 * 1024 if operation == "write_pdf" else BINARY_LIMIT
            if operation == "write_pdf" and not content.startswith(b"%PDF-"):
                raise ValueError("Choose a PDF file")
            self.write_bytes(path, content, limit)
        else:
            raise ValueError("Unsupported file operation")
        return result


def main():
    raw = sys.stdin.buffer.read(36 * 1024 * 1024 + 1)
    if len(raw) > 36 * 1024 * 1024:
        raise ValueError("Request exceeds size limit")
    print(json.dumps(Workspace().handle(json.loads(raw))))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
