"""OpenMuse MIT. Offline CPU transcription and sandboxed Office-to-PDF previews."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

spec = importlib.util.spec_from_file_location("openmuse_files", os.path.join(os.path.dirname(__file__), "files.py"))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)

MODEL_PATH = "/opt/openmuse/models/whisper-small"
MAX_SECONDS = 1800


def timestamp(seconds):
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def transcribe(args, workspace=None, model_path=None, model_factory=None, ffmpeg="ffmpeg"):
    workspace = workspace or files.Workspace()
    path = args["path"]
    language = args.get("language", "auto")
    if language not in ("auto", "pt", "en", "de"):
        raise ValueError("Language must be auto, pt, en or de")
    model_path = model_path or os.environ.get("WHISPER_MODEL_PATH", MODEL_PATH)
    if not os.path.isfile(os.path.join(model_path, "model.bin")):
        raise ValueError("The offline Whisper small model is missing; rebuild the open computer image")
    text_path = args.get("textPath", path + ".txt")
    srt_path = args.get("srtPath")
    workspace.parts(text_path)
    if srt_path:
        workspace.parts(srt_path)
    source_fd = workspace.open_read(path)
    try:
        with tempfile.TemporaryDirectory(prefix="openmuse-transcribe-") as temporary:
            audio = os.path.join(temporary, "audio.wav")
            # Source is an already opened regular file. No URL inputs, shell or network
            # protocols; -t plus a decoded-duration check bounds pathological media.
            subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
                            "-i", f"/proc/self/fd/{source_fd}", "-vn", "-ac", "1", "-ar", "16000", "-t", str(MAX_SECONDS + 1),
                            "-c:a", "pcm_s16le", "-y", audio], pass_fds=(source_fd,), check=True, timeout=120,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            with wave.open(audio, "rb") as decoded:
                duration = decoded.getnframes() / decoded.getframerate()
            if duration > MAX_SECONDS:
                raise ValueError("Media must contain 30 minutes of audio or less")
            if model_factory is None:
                from faster_whisper import WhisperModel
                model_factory = WhisperModel
            model = model_factory(model_path, device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)
            segments, info = model.transcribe(audio, language=None if language == "auto" else language, beam_size=5, vad_filter=True)
            text, subtitles = [], []
            for index, segment in enumerate(segments, 1):
                line = segment.text.strip()
                text.append(line)
                subtitles.append(f"{index}\n{timestamp(segment.start)} --> {timestamp(segment.end)}\n{line}\n")
                if index > 10000 or sum(len(t) for t in text) > files.LIMIT - 10000:
                    raise ValueError("Transcript exceeds the text size limit")
            content = "\n".join(text)
            workspace.write_bytes(text_path, content.encode(), files.LIMIT)
            if srt_path:
                workspace.write_bytes(srt_path, "\n".join(subtitles).encode(), files.LIMIT)
            return {"text": content[:32000], "truncated": len(content) > 32000, "textPath": text_path,
                    "language": info.language, "languageProbability": info.language_probability,
                    "duration": duration, **({"srtPath": srt_path} if srt_path else {})}
    finally:
        os.close(source_fd)


def preview(args, workspace=None):
    workspace = workspace or files.Workspace()
    path = args["path"]
    extension = path.rsplit(".", 1)[-1].lower()
    if extension not in ("pptx", "docx", "xlsx", "odt", "odp", "ods"):
        raise ValueError("Preview supports PPTX, DOCX, XLSX and OpenDocument files")
    output_path = args.get("outputPath", path + ".pdf")
    workspace.parts(output_path)
    with tempfile.TemporaryDirectory(prefix="openmuse-office-") as temporary:
        source = os.path.join(temporary, "document." + extension)
        with os.fdopen(workspace.open_read(path), "rb") as opened, open(source, "wb") as target:
            shutil.copyfileobj(opened, target)
        profile = os.path.join(temporary, "profile")
        os.makedirs(os.path.join(profile, "user"))
        # Highest macro security: conversions never need macros or external links.
        with open(os.path.join(profile, "user", "registrymodifications.xcu"), "w") as settings:
            settings.write('<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>')
        subprocess.run(["libreoffice", "-env:UserInstallation=file://" + profile, "--headless", "--nologo", "--nodefault", "--norestore",
                        "--convert-to", "pdf", "--outdir", temporary, source], check=True, timeout=120,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        with open(os.path.join(temporary, "document.pdf"), "rb") as result:
            pdf = result.read(10 * 1024 * 1024 + 1)
        if not pdf.startswith(b"%PDF-") or len(pdf) > 10 * 1024 * 1024:
            raise ValueError("Office preview did not produce a PDF within 10 MB")
        workspace.write_bytes(output_path, pdf, 10 * 1024 * 1024)
        return {"previewPath": output_path}


def main():
    request = json.loads(sys.stdin.buffer.read(8193))
    if request["kind"] == "transcribe":
        result = transcribe(request["parameters"])
    elif request["kind"] == "preview":
        result = preview(request["parameters"])
    else:
        raise ValueError("Unsupported media operation")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Provider/library paths can include credentials or source contents. Keep the
        # public failure bounded; the receipt honestly records the failed execution.
        print("Media processing failed. Check the input type/size, offline model and installed tools.", file=sys.stderr)
        sys.exit(1)
