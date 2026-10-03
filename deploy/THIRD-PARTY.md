# Installed dependency notices

OkamiBot preserves the upstream OpenMuse MIT license and technical package/layout
identifiers. The native installer copies the full project `LICENSE` with the code,
keeps the scoped `apps/computer` and browser/domain source layout, and installs
the separately digest-verified gog tag's upstream license at
`/usr/local/share/licenses/gogcli/LICENSE` (the binary archive has no license file).

OS packages keep their distribution-provided license/copyright files under
`/usr/share/doc`. Node dependencies keep their licenses under the frozen worker's
`node_modules`; Python distributions keep their metadata/license files in the
isolated media venv. Do not remove those files when packaging installed code.

The separate [OpenBao 2.7.1 distribution](https://github.com/openbao/openbao/releases/tag/v2.7.1)
has its own license. LibreOffice, ffmpeg, Chromium/Playwright, age, gogcli,
faster-whisper/CTranslate2 and the small model retain their respective upstream
licenses. This list records installation locations, and does not relicense them
as MIT or replace their full upstream notices.
