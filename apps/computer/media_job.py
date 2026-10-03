"""OpenMuse MIT. Fixed native media entrypoint; publishes new outputs exclusively."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid

spec=importlib.util.spec_from_file_location("okami_media", Path(__file__).with_name("media.py"))
media=importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)

class NewOutputWorkspace(media.files.Workspace):
    def write_bytes(self,path,content,limit=media.files.BINARY_LIMIT):
        parts=self.parts(path)
        if not parts or len(content)>limit:raise ValueError("Invalid media output")
        directory=self.directory(parts[:-1])
        temporary=".okami-media-"+uuid.uuid4().hex
        try:
            fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
            with os.fdopen(fd,"wb") as stream:
                stream.write(content);stream.flush();os.fsync(stream.fileno())
            # No overwrite, even if a human creates the destination during conversion.
            os.link(temporary,parts[-1],src_dir_fd=directory,dst_dir_fd=directory,follow_symlinks=False)
            os.fsync(directory)
        finally:
            try:os.unlink(temporary,dir_fd=directory)
            except FileNotFoundError:pass
            os.close(directory)

def main(encoded):
    if len(encoded)>24000:raise ValueError("Media request exceeds limit")
    request=json.loads(base64.b64decode(encoded,validate=True))
    operation={"transcribe":media.transcribe,"preview":media.preview}.get(request.get("kind"))
    if operation is None:raise ValueError("Unsupported media operation")
    result=operation(request["parameters"],workspace=NewOutputWorkspace())
    print("OKAMI_MEDIA_RESULT:"+json.dumps(result,ensure_ascii=False))

if __name__=="__main__":
    try:main(sys.argv[1])
    except Exception:
        print("Media processing failed. Check input, output availability and installed offline tools.",file=sys.stderr)
        sys.exit(1)
