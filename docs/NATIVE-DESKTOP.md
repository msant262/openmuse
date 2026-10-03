# Native desktop and trusted viewer

`apps/computer/desktop/session.py` launches a private Xvnc/Xfce session under a
fixed registered Linux account. Run it inside the account's systemd unit and a
private `dbus-run-session`. Its runtime directory must be owned by that account
and mode 0700. Every launch has a fresh session generation; it does not reuse or
stop the person's GNOME/RDP session. Jobs belong to separate units.

The supervisor connects through a mode-0600 Unix socket. Xvnc TCP, raw viewer keyboard,
pointer, clipboard and resize input are disabled. Input must pass through the
trusted broker and the existing shared GUI/DOM lease. Viewer disconnect does not
terminate the session. The [Xvnc options](https://tigervnc.org/doc/Xvnc.html) bound
the update rate at eight frames per second; this is a ceiling, not a measured
Wi-Fi frame-rate promise.

`DesktopDriver` requires a fresh observation and a caller-provided authorization
check. It checks the session generation, dimensions, expiry and current pixels,
consumes the frame before input, rechecks authority during gestures, and releases
keys/buttons after interruption. Every observation captures current pixels and
receives a fresh frame ID, including when masked image bytes are unchanged and
may be omitted. Trusted masks apply before hashing/PNG encoding. Window titles
and clipboard contents are not included. The generic driver cannot discover all
secrets; the credential flow must supply current masks and revoke observations
when its protection state changes.

The X11 adapter uses distribution `python3-xlib` and `xdotool`. Unicode text is
passed on stdin, never command arguments, clipboard or saved files. The
[xdotool implementation](https://github.com/jordansissel/xdotool/blob/main/cmd_type.c)
supports that input path. Typed values and tool diagnostics are absent from input
receipts. A receipt confirms delivery of input, not a business outcome.

The default native server composition connects `DesktopService`, the executor
registry, `TaskExecutorAuthority`, and the existing task journal/resource leases.
`desktop_observe` and `desktop_act` use the same physical GUI/profile reservation
as Playwright. Models need a declared vision capability to receive visual work.
Images are masked before leaving the account. Model history stores owner-scoped
image references and capture timestamps; a bounded live-frame record stores only
the latest image per executor/channel. Image files currently use the existing
BrowserAssets retention policy and are not automatically expired by this module.

The phone's Computer → Desktop surface renders trusted image bytes and sends
typed operations through authenticated server routes. It executes no bot HTML
with app credentials. One device-bound interactive TaskWorker lifecycle serves
observation/input/handback, separately from the four background work slots. At
most two interactive admissions run at once. Observing does not reserve GUI
input. Take control resets previous input before acknowledging a nonexpiring
GUI/profile reservation; its device grant expires after 30 seconds without a
heartbeat. Expiry keeps the reservation until a confirmed reset, rather than
quietly handing uncertain input back to automation.

Every viewer request is bound to its exact desktop session and generation.
Native input retains GUI/profile/admin handles and its existing work admission
when dispatch has an uncertain result. A confirmed fixed-session reset can prove
physical cleanup without changing the earlier semantic `outcome_unknown` or
repeating it. Global pause closes the live permit before freezing the managed
account. Inspection during pause displays the last masked frame with its actual
capture time and an explicit paused flag; takeover/input requires explicit
resume. Heartbeat and watchdog do not wait on the frozen account's socket.

The native browser worker runs headed Chromium under the registered account,
with an exclusive persistent profile and CDP pipe. It verifies sandbox support
before advertising readiness, and never adds `--no-sandbox`. DISPLAY,
XAUTHORITY, private D-Bus, HOME and runtime paths come from registration, not
model arguments. Native credentials require the M8 trusted fixed-adapter and
one-use grant consumer; this desktop layer fails closed if that injector or
sensitive-region refresh hook is unavailable. No credential bytes enter native
operation envelopes. The session's own UID can access its display and cookies;
broad sudo on the supplied account remains a full-trust limitation. The broker
is not an isolation boundary against that same account.

## Operator packaging

Keep the M6 root-owned user/supervisor registration and add a fixed `desktop`
entry to the account: `sessionId` (UUID), distinct `display` in 60–199,
`profileId`, `width` and `height`. The generated account service starts
`dbus-run-session -- python3 -m desktop.broker` with those registered values.
It does not reuse the person's desktop. Install distribution TigerVNC/Xfce,
python3-xlib, xdotool, D-Bus and sandbox-capable Chrome; configure account homes,
runtime directories and the native M6 cgroup/network policy before enabling it.

Package `apps/worker/src` and its pinned Playwright runtime dependency at
`/opt/okami-computer/browser-worker`, alongside the computer Python package.
The generated broker defaults to `/opt/okami-computer/browser-worker/src/native.ts`
and `/usr/bin/node` with TypeScript transforms (Node 24). This worker uses its
own private Unix socket and memory-only configuration, not a public browser
HTTP/CDP port or server API secrets. VPS headless browsing keeps the existing
browser worker. This change does not install software, create accounts or grant
sudo on a remote machine.

The test suite exercises the real server/journal/authority, native protocol,
SQLite supervisor and broker with synthetic pixels/input. It covers four busy
background tasks plus takeover, private text/frame transport, replay, device and
session binding, uncertain GUI/DOM cleanup, and paused inspection. Python
boundary tests cover stale frames, masks, interruption and session configuration.
The isolated Lenovo preparation probe additionally exercised the actual session,
capture, Unicode entry in a synthetic window, masked output, rejected stale frame
and release of a drag after revocation. It did not use personal applications,
accounts, live task authority, mobile or the production viewer. Its private
session, processes and files were removed after the probe. Full connected
Lenovo/mobile acceptance, five lightweight native sessions, Wi-Fi timing and
AppArmor behavior remain operator hardware validation. Login and challenge handling
are the credential milestone; the complete spreadsheet edit → manual login →
handback → upload → published copy must still be exercised on that connected host.

`search_web` discovers bounded public index entries using the same persistent
browser and resource authority. The DuckDuckGo HTML adapter needs no API key;
blocked/challenge/changed-layout pages produce an explicit error. Sources contain
title, URL, index snippet, optional date, observation time, truncation and index
provenance. They do not imply that the source pages were read. Synthetic Chromium
and conversation → admitted task tests cover that path; live external index
availability is not asserted by those tests.

`browser_upload_from_workspace` reads a controlled `/workspace` file and checks
its expected SHA256 before copying it to an owned attachment and a fresh numbered
file input. The browser receives an authorized artifact ID and bytes, never a host
path. Uploads are limited to 5 MiB. Native delivery stores only metadata/hash and a
one-use reference in its journals; bytes live in bounded process memory for 45s and
are consumed only by the exact authenticated claimed operation and current lease.
Uploads return a fresh snapshot and a chat file reference; the site's business
outcome still requires separate evidence. Lost upload responses require inspection.

Completed downloads support PDF, text/CSV/JSON/SRT, DOCX/XLSX/PPTX and PNG/JPEG/WebP
with bounded content checks. Worker storage is limited to 20 files of at most
10 MiB; native transfers are limited to 8 MiB. Interrupted/unsupported/oversized
transfers and pending counts remain explicit. `browser_downloads` publishes owned
references. `browser_download_to_workspace` verifies size/hash and uses existing
M6 controlled publication/version/ACK before returning a chat copy. The trusted
mobile desktop also imports completed downloads under its existing device-bound
interactive lifecycle, including while the person controls the desktop.

New popup tabs are closed, script dialogs are dismissed, and old numbered refs
are invalidated. Safe interruption counts accompany snapshots; dialog messages and
popup page contents are not copied to receipts. Failed containment blocks further
DOM work. These guards are deliberate limits: selecting arbitrary popup tabs,
automatically accepting prompts, and completing multi-window workflows are not
implemented. Human GUI intervention uses the same trusted desktop authority.

The native viewer polls fresh frames every 1.5s while pixels change and every 6s
after three unchanged captures, within the human permit's 30s renewal period.
Unmount/background stops captures and clears input bindings; inline previews are
removed while the app/section is hidden or a full viewer is active. VPS console
polling likewise stops when hidden and backs off unchanged pixels. This is an
observation policy, not a frame-rate or task-completion guarantee.

TigerVNC, Xfce, python-xlib and xdotool keep their distribution license files;
installing their binaries does not relicense this MIT application. No third-party
source was copied into these modules. Preserve distribution notices when packaging
the native runtime.
