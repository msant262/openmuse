# Local OkamiBot Android release

The app display/launcher name, new-device label, visible copy and notification channel name are OkamiBot. The original MIT capybara is bundled as the launcher/adaptive icon and favicon. Existing package/bundle ID `app.openmuse.mobile`, slug/scheme `openmuse`, `@openmuse` packages, SecureStore service, storage paths, protocol markers and notification channel ID are unchanged. Custom assistant names come from the saved profile and are not replaced by branding. Upstream notices and historical demo recordings remain attributed to OpenMuse.

## Build without a paid service

Use Node 22+, Java 17, the Android SDK and the project's pinned dependencies. Expo SDK 54/React Native 0.81.5 prebuild selects the SDK/NDK/build-tools versions; install missing versions and accept their SDK licenses locally through the normal Android SDK setup. No EAS account, cloud build or paid license is required. Run one frozen workspace install before the direct build command:

```sh
pnpm install --frozen-lockfile
python3 scripts/build_android_local.py --check
python3 scripts/build_android_local.py --abi arm64-v8a --api-url https://your-agent.example.org
```

The script generates ignored `apps/mobile/android`, refuses dependency changes by prebuild, calls local Gradle `assembleRelease` with a single ABI and two workers, then verifies the APK. It refreshes the generated bundle on each build so an API URL change cannot silently reuse a stale bundle. APK and JSON receipt are written to ignored `artifacts/android/`. The receipt records source commit/dirty state, SHA256/size, signer fingerprint, package/label/scheme, ABI, release debuggability, preserved upstream notices and the embedded public API URL. API URLs cannot contain credentials, query tokens or fragments. No access key or account credential should be compiled into the app. The Android manifest allows HTTP only when that explicit embedded endpoint uses HTTP; use HTTPS for a live release. The APK includes the unchanged root MIT license and original artwork attribution as Android assets.

`release` is the optimized build variant. Expo's generated native template uses its local Android debug key by default; the receipt marks it `android-debug-local-only` and `productionSigned:false`. This default supports local smoke only. Use the project's persistent private certificate for an installable pilot release as described below. Distribution and physical upgrade acceptance remain operator work.

## Persistent project signing

The operator creates and keeps the project's keystore outside version control, for example under ignored `deployment-secrets/android-signing/`. The build script does not generate a key. A private JSON config refers to that existing keystore, its alias, two password files and its expected certificate SHA256:

```json
{
  "keystoreFile": "release.p12",
  "alias": "okamibot",
  "keystorePasswordFile": "store.password",
  "keyPasswordFile": "key.password",
  "expectedCertificateSha256": "REPLACE_WITH_THE_64_HEX_CHARACTER_PUBLIC_CERTIFICATE_DIGEST"
}
```

Paths are relative to the config directory or absolute. Config, keystore and password files must be regular files owned by the current build user with mode `0600` or `0400`; symlink files are refused. Store each password as a single line in its protected file, without including the password in the JSON, shell arguments, environment, source or logs. Use separate password files, including when PKCS12 uses the same password for the store and key. If both paths refer to one file, `apksigner` reads two lines from it, store password first. The expected digest is public certificate metadata; a colon-separated digest is also accepted.

```sh
python3 scripts/build_android_local.py --check \
  --signing-config deployment-secrets/android-signing/signing.json
python3 scripts/build_android_local.py --abi arm64-v8a --api-url https://your-agent.example.org \
  --signing-config deployment-secrets/android-signing/signing.json
python3 scripts/build_android_local.py --verify-apk artifacts/android/okamibot-release-arm64-v8a.apk \
  --abi arm64-v8a --api-url https://your-agent.example.org \
  --signing-config deployment-secrets/android-signing/signing.json
```

After Gradle, the script replaces the template signature using SDK `apksigner sign --ks-pass file:... --key-pass file:...`. It captures signer output, runs `apksigner verify --print-certs`, rejects an Android Debug certificate or multiple signers, and requires the exact expected project fingerprint before publishing the APK. The existing deliverable is preserved if signing or verification fails. `--verify-apk` checks an existing artifact without re-signing it. Successful project verification records `signing:project-private-verified`, `signatureVerified:true`, `productionSigned:true` and the public fingerprint; it records no signing config, key path, alias or password-file path. Physical acceptance remains false until separately tested.

Keep encrypted offline backups of the keystore, alias, passwords and public fingerprint outside the repository, with access limited to the operator. Preserve the same key between releases and verify the fingerprint before distribution. Losing the key blocks normal upgrades. Android refuses an upgrade signed by a different certificate even when `app.openmuse.mobile` is unchanged; a paired installation using the old template debug key cannot be upgraded directly to the project key. Do not uninstall or clear a paired device to bypass this mismatch. Any migration must preserve its saved pairing through an explicit operator procedure, or use a separately authorized fresh installation.

For a local x86_64 AVD, build a separate standalone release with:

```sh
python3 scripts/build_android_local.py --abi x86_64 --api-url http://10.0.2.2:8787
python3 scripts/build_android_local.py --verify-apk artifacts/android/okamibot-release-arm64-v8a.apk --abi arm64-v8a --api-url https://your-agent.example.org
```

Verify with the same API URL used when building. Android/iOS/web `expo export` commands validate JavaScript/Hermes/assets and do not create an installable native release. The SDK's `apksigner` must confirm the APK signature; the verifier separately rejects a wrong package/scheme/label, extra native ABI, debuggable release, missing DEX/Hermes/bundle or missing requested endpoint.

## Local demo and acceptance

Use an isolated sample API, local storage and an explicit emulator serial. `WORKSPACE_MODE=sample`, `AGENT_BACKEND=sample`, `HOST=127.0.0.1` and `PROACTIVITY_ENABLED=false` keep that smoke journey fictional. The Android emulator reaches the local host at `10.0.2.2`. Install only on the disposable AVD; launcher/chat/navigation, keyboard entry, draft restoration and reopening can then be checked without a live account. An emulator pass is not phone, live Google/login/push, desktop, Wi-Fi or capacity acceptance.

```sh
python3 scripts/smoke_android_demo.py --serial emulator-5556 --apk artifacts/android/okamibot-release-x86_64.apk
```

The smoke refuses physical-device serials or an occupied API port, verifies the APK's sample endpoint and ABI, starts the actual sample API in isolated storage, and records UI XML/screenshots plus a safe receipt. It checks that force-stop/reopen restores the keyboard draft and reuses one saved pairing, then opens Apps. It closes its sample server afterwards. Use a fresh output directory for another run; existing artifacts and sample data are preserved.

The final composed mobile source is `ef147e3`. Project-signed ARM64 and x86_64 APKs,
build receipts and emulator evidence are retained under
`artifacts/android/pin-ef147e3-project-signed/` and `artifacts/android/`.
The automatic emulator smoke passed with one pairing, three workspace reads,
chat/Apps navigation and a draft preserved through force-stop/reopen.
The ARM64 endpoint is `https://srv1667308.tail107988.ts.net`; the x86_64 APK uses
only the isolated `http://10.0.2.2:8793` fixture. The ARM64 application requires
Tailscale Serve to be enabled before its configured HTTPS endpoint works.
See [the deployment acceptance record](DEPLOYMENT-ACCEPTANCE.md) for exact hashes,
installation guidance and remaining account/physical-phone acceptance.
