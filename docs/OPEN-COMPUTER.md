# Open computer, files and media

OpenMuse remains MIT. Offline Docker mode stays available for demo/local use. The
open profile uses a static nonroot RPC computer; the API never gets a Docker socket,
host shell fallback, model keys or Google tokens inside that computer.

Build the computer and gateway with the commands in `.env.example`. Choose
`COMPUTER_BACKEND=rpc`, `COMPUTER_PROFILE=open`, `COMPUTER_ENABLED=true`, a private
`COMPUTER_URL=http://computer-egress:8811` and a random `COMPUTER_TOKEN` of 32+ characters.
`COMPUTER_COMMAND_TIMEOUT_MS` is 1,000..1,800,000. The old `docker` backend remains
offline, 512 MB/30 seconds; it rejects long/background commands.

The final VPS Compose/DEPLOY setup is supplied in milestone 7. This milestone establishes
the following required deployment contract; running the raw RPC directly is not an
open-network deployment:

- `computer-egress` owns a dedicated network namespace. Give it `cap_drop: ALL` plus
  `cap_add: NET_ADMIN`, `init: true`, read-only filesystem and at most 128MiB. It has
  no host network/PID namespace/socket/mounts. Set `COMPUTER_SERVER_IP` to the API's
  fixed private control IP and `COMPUTER_HOST_PUBLIC_IPS` to **every VPS public IPv4
  alias**, including a provider NAT public IP. Empty/private/malformed values fail startup.
- `computer` uses `network_mode: service:computer-egress`, its **own** PID namespace,
  `init: true`, UID/GID1000, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem,
  3072 MiB and writable named volumes at `/workspace` and `/home/node`. Provide a writable
  `/tmp` tmpfs, a pid cap and CPU cap. It refuses boot without nonroot Docker init as PID1.
  Raw RPC binds only `127.0.0.1:8810` in that namespace.
- Mount `apps/computer/resolv.conf` read-only at `/etc/resolv.conf` in computer. Public
  DNS uses 1.1.1.1/8.8.8.8. Gateway blocks Docker DNS 127.0.0.11 entirely, including its
  NAT-translated port, so Docker cannot forward the computer's queries to a LAN resolver.
- Gateway installs default-deny INPUT/OUTPUT/FORWARD IPv4 and IPv6 rules before listening.
  It allows inbound authenticated RPC only from the fixed API control IP, established
  replies, local RPC and public IPv4 TCP/public DNS. Private/metadata/CGNAT/Tailscale,
  reserved destinations and the VPS's own public IPs are blocked. IPv6 is denied in full;
  also disable it with gateway sysctls. No private destination is exempted for an agent tool.
- Gateway checks exact active rule lists **and** raw RPC readiness for health and every
  dispatch. It streams fixed-route requests without forwarding credentials. Proxy secret
  lives only in its separate PID namespace, never computer env or persistent volumes.
  Do not publish computer/gateway ports. Recreate the computer whenever recreating gateway
  to keep the shared namespace correct. Gate readiness with the token-free `/health`.
- Memory contract for milestone 7: API 1280 MiB + browser 2048 MiB + computer 3072 MiB +
  gateway 128 MiB = 6,845,104,128 bytes, below 7 GB. The computer image/model needs disk space;
  inference uses two threads and real VPS speed still needs measurement.

`start_computer` enables execution in the already-running sidecar; `stop_computer`
cancels active jobs and disables execution, preserving files/home. It does not pretend
to start/stop the container itself. Commands have durable owner-bound operation IDs,
bounded output and a maximum 30 minute deadline. `run_command` accepts `background:true`;
poll `computer_command_status` or use the phone terminal's automatic polling. One active
job at a time prevents memory oversubscription and lets the isolated supervisor kill
detached processes safely. Normal child groups and detached same-container processes
are stopped at completion/cancel/timeout; unconfirmed cleanup quarantines the computer.
Receipts survive API restart. Sidecar restart marks unfinished work interrupted/unknown;
lost submissions are never automatically repeated. Inspect files before repeating uncertain work.

Upload Office/PDF/images/audio/video or other files through mobile Files (25MB maximum;
PDFs 10 MB/500 pages), select them as chat attachments, and use `import_computer_file`
with their owned file ID. `list_files`, `read_file`, `write_file` and `run_command`
work inside `/workspace`; text tools have 256 KB limits and reject symlinks/special files.
`export_computer_file` returns a downloadable card. Images/PDFs have previews; Office
files can create a PDF preview via isolated LibreOffice. Unsupported types are download-only,
including HTML/SVG. Raster images above 8 MB remain downloadable; resize them in the
computer before using model image input. Saved cards resolve and re-sign by ID on replay. Existing PDF
fill workflows and old stored PDFs remain supported.

`transcribe` accepts `path` or an owned `fileId`, optional `language:auto|pt|en|de`,
`textPath`, optional `srtPath`, `operationId`, `timeoutMs` and `background`. It decodes
audio/video through FFmpeg to mono 16 kHz PCM and runs the predownloaded multilingual
Whisper **small**, CPU/int8, two threads, local-files-only. Decoded audio is capped at
30 minutes. Automatic language detection is probabilistic; explicit language can help.
Completion returns text, language, timing and owned TXT/SRT cards. It never calls the
ChatGPT/audio API or downloads models at runtime. `preview_computer_file` converts
PPTX/DOCX/XLSX/OpenDocument to PDF with macros disabled in a temporary LibreOffice profile.

`generate_image` uses the currently selected model provider and the existing credential
adapter. Enable its documented image capability with `OPENAI_IMAGE_MODEL`,
`GROK_IMAGE_MODEL`, `OPENAI_COMPATIBLE_IMAGE_MODEL` or `LOCAL_IMAGE_MODEL` only when
that endpoint supports it. ChatGPT Sign in and MiMo remain clearly disabled for images.
Returned PNG/JPEG/WebP must be bounded base64 bytes; arbitrary returned URLs are not
fetched. Image requests have durable IDs; uncertain generation is not retried or billed
again automatically. Persisted history contains compact owner-bound image/file references;
only the latest verified image is hydrated at a model dispatch.

The image includes Python/pip, python-pptx/docx/openpyxl/pandas/pypdf, poppler, FFmpeg,
ImageMagick, LibreOffice, git/curl/jq/node, the pinned Whisper model and checksum-verified
`gog` v0.43.0. `gog` is installed without any account. Native Google integration retains
its existing OAuth setup. A separately authorized gog credential in the computer's home
is available to that computer's shell; never copy VPS/API secrets there. Keep third-party
notices in `apps/computer/THIRD-PARTY.md` and the installed license paths.

Security boundary: public-network bash can issue arbitrary HTTP; a command receipt logs
the invocation/result, not a semantic audit of every HTTP side effect. Use native/MCP
actions for policy/audit. Money approval enforcement and append-only action logging are
milestone 5; do not assume the shell can recognize every payment operation.

Validation in this development environment covers Python helpers, real harmless shell
jobs, injected firewall/HTTP contracts and real offline speech fixtures. No Docker engine
is installed: image builds, actual kernel egress isolation, Compose and VPS resource behavior
remain unverified. Office-to-PDF tooling is implemented but needs real LibreOffice acceptance.
