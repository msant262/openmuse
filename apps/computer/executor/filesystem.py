"""Open registered native directories without following any path-component link."""
import os
from pathlib import Path


def open_directory(path,create=False):
    path=Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Native directory must be an absolute registered path")
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
    fd=os.open("/",flags)
    try:
        for part in path.parts[1:]:
            try:child=os.open(part,flags,dir_fd=fd)
            except FileNotFoundError:
                if not create:raise
                try:os.mkdir(part,mode=0o700,dir_fd=fd)
                except FileExistsError:pass
                child=os.open(part,flags,dir_fd=fd)
            os.close(fd);fd=child
        return fd
    except Exception:
        os.close(fd);raise
