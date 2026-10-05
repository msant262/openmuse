#!/usr/bin/env python3
"""Build and inspect a local Android APK without EAS or cloud signing."""
import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MOBILE = ROOT / "apps/mobile"
PACKAGE = "app.openmuse.mobile"
SCHEME = "openmuse"
LABEL = "OkamiBot"


@dataclass(frozen=True)
class SigningConfig:
    source: Path
    keystore: Path
    alias: str
    keystore_password: Path
    key_password: Path
    expected_sha256: str


def protected_file(path, label):
    path = path.expanduser().absolute()
    try:
        details = path.lstat()
    except OSError:
        raise ValueError(f"{label} cannot be opened") from None
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"{label} must be a regular file, without symlinks")
    if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) not in {0o400, 0o600}:
        raise ValueError(f"{label} must be private (0600/0400) and owned by the current user")
    return path.resolve()


def load_signing_config(path):
    source = protected_file(path, "Signing configuration")
    if source.stat().st_size > 16384:
        raise ValueError("Signing configuration is too large")
    value = json.loads(source.read_text())
    fields = {"keystoreFile", "alias", "keystorePasswordFile", "keyPasswordFile",
              "expectedCertificateSha256"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("Signing configuration requires only keystore/password-file references, alias and expected fingerprint")
    if any(not isinstance(value[field], str) or not value[field] or
           any(ord(character) < 32 for character in value[field]) for field in fields):
        raise ValueError("Signing configuration fields must be nonempty text without control characters")
    expected = value["expectedCertificateSha256"].replace(":", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Signing certificate fingerprint must be a SHA-256 digest")
    def file(field, label):
        candidate = Path(value[field]).expanduser()
        return protected_file(candidate if candidate.is_absolute() else source.parent / candidate, label)
    return SigningConfig(source, file("keystoreFile", "Signing keystore"), value["alias"],
                         file("keystorePasswordFile", "Keystore password file"),
                         file("keyPasswordFile", "Key password file"), expected)


def public_api_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or
            parsed.username or parsed.password or parsed.query or parsed.fragment or
            any(character.isspace() for character in value)):
        raise ValueError("API URL must be an HTTP(S) endpoint without credentials/query/fragment")
    return value.rstrip("/")


def load_google_services(path):
    """Validate the Android client configuration without printing its contents."""
    try:
        value = json.loads(path.expanduser().read_text())
        project = value["project_info"]
        client = next(client for client in value["client"]
                      if client["client_info"]["android_client_info"]["package_name"] == PACKAGE)
        result = {"project_id": project["project_id"],
                  "gcm_defaultSenderId": project["project_number"],
                  "google_app_id": client["client_info"]["mobilesdk_app_id"],
                  "google_api_key": client["api_key"][0]["current_key"]}
        if (any(not isinstance(v, str) or not v.strip() for v in result.values()) or
                not result["gcm_defaultSenderId"].isdigit() or
                not result["google_app_id"].startswith(f'1:{result["gcm_defaultSenderId"]}:android:')):
            raise ValueError()
        return result
    except (KeyError, TypeError, IndexError, StopIteration, ValueError):
        raise ValueError("Firebase configuration must contain the matching Android package and complete project/client identifiers") from None


def firebase_resources(resources):
    names = ["google_app_id", "gcm_defaultSenderId", "google_api_key", "project_id"]
    result = {}
    for name in names:
        match = re.search(rf'^\s*resource [^\n]*:string/{name}:[^\n]*\n\s*\(string(?:8|16)\) "([^"\n]+)"',
                          resources, re.MULTILINE)
        if match:
            result[name] = match[1]
    return result


def inspect_apk(apk, badging, manifest, signer, abi, mode, api_url, expected_signer_sha256=None,
                *, resources="", require_push=False, google_services=None):
    package = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging)
    if not package or package[1] != PACKAGE:
        raise ValueError("APK package does not preserve the paired app identity")
    if f"application-label:'{LABEL}'" not in badging:
        raise ValueError("APK launcher label is not OkamiBot")
    if not re.search(r'android:scheme[^\n]*["\']openmuse["\']', manifest):
        raise ValueError("APK scheme does not preserve existing deep links")
    debuggable = "application-debuggable" in badging
    if mode == "release" and debuggable:
        raise ValueError("Release APK is debuggable")
    with zipfile.ZipFile(apk) as archive:
        names = set(archive.namelist())
        abis = sorted({name.split("/")[1] for name in names if name.startswith("lib/")})
        if abis != [abi]:
            raise ValueError(f"APK ABI differs from requested {abi}: {abis}")
        if f"lib/{abi}/libhermes.so" not in names:
            raise ValueError("APK has no Hermes native library")
        if f"lib/{abi}/libreactnative.so" not in names:
            raise ValueError("APK has no React Native native library")
        if "AndroidManifest.xml" not in names or not any(re.fullmatch(r"classes\d*\.dex", name) for name in names):
            raise ValueError("APK is missing Android manifest or DEX")
        if "assets/index.android.bundle" not in names:
            raise ValueError("APK is missing its standalone JavaScript/Hermes bundle")
        if ("assets/openmuse-LICENSE.txt" not in names or
                archive.read("assets/openmuse-LICENSE.txt") != (ROOT / "LICENSE").read_bytes() or
                "assets/openmuse-ASSET-NOTICE.txt" not in names):
            raise ValueError("APK is missing preserved upstream MIT/artwork notices")
        bundle = archive.read("assets/index.android.bundle")
        if api_url.encode() not in bundle:
            raise ValueError("APK does not contain the requested embedded API endpoint")
    fingerprints = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$",
                              signer, re.MULTILINE)
    if len(fingerprints) != 1:
        raise ValueError("APK must have a single verified signer fingerprint")
    fingerprint = fingerprints[0].lower()
    debug_signature = "CN=Android Debug" in signer or "CN=AndroidDebug" in signer
    if expected_signer_sha256:
        if debug_signature:
            raise ValueError("Project signing refuses an Android debug certificate")
        if fingerprint != expected_signer_sha256:
            raise ValueError("APK signer fingerprint differs from the expected project certificate")
    firebase = firebase_resources(resources)
    if require_push and (len(firebase) != 4 or
                         not firebase["gcm_defaultSenderId"].isdigit() or
                         not firebase["google_app_id"].startswith(f'1:{firebase["gcm_defaultSenderId"]}:android:')):
        raise ValueError("Notification release is missing compiled Firebase Android resources")
    if google_services and firebase != google_services:
        raise ValueError("APK Firebase resources differ from the requested Android configuration")
    return {
        "package": package[1], "versionCode": package[2], "versionName": package[3],
        "label": LABEL, "scheme": SCHEME, "mode": mode, "nativeAbis": abis,
        "debuggable": debuggable, "embeddedApiUrlVerified": True, "apiUrl": api_url,
        "upstreamNoticesIncluded": True,
        "signing": ("project-private-verified" if expected_signer_sha256 else
                    "android-debug-local-only" if debug_signature else "non-debug-owner-verification-required"),
        "productionSigned": bool(expected_signer_sha256), "signatureVerified": True,
        "nativePushConfigured": len(firebase) == 4,
        **({"firebaseProjectId": firebase["project_id"]} if len(firebase) == 4 else {}),
        "signerSha256": fingerprint,
        **({"expectedSignerSha256": expected_signer_sha256} if expected_signer_sha256 else {}),
        "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(), "bytes": apk.stat().st_size,
    }


def run(command, cwd=ROOT, env=None, capture=False):
    result = subprocess.run(command, cwd=cwd, env=env, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None, text=capture)
    return result.stdout if capture else None


def android_tools():
    sdk = Path(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or
               Path.home() / "Android/Sdk").expanduser().resolve()
    versions = sorted((sdk / "build-tools").glob("*"),
                      key=lambda item: [int(piece) for piece in re.findall(r"\d+", item.name)])
    if not versions:
        raise ValueError("Android SDK build-tools are missing")
    tools = {name: versions[-1] / name for name in ["aapt", "apksigner"]}
    for name, path in tools.items():
        if not path.is_file():
            raise ValueError(f"Android SDK {name} is missing")
    for name in ["node", "java"]:
        if not shutil.which(name):
            raise ValueError(f"{name} is required")
    return sdk, tools


def verify(apk, tools, args, signing=None):
    badging = run([str(tools["aapt"]), "dump", "badging", str(apk)], capture=True)
    manifest = run([str(tools["aapt"]), "dump", "xmltree", str(apk), "AndroidManifest.xml"], capture=True)
    signer = run([str(tools["apksigner"]), "verify", "--print-certs", str(apk)], capture=True)
    resources = run([str(tools["aapt"]), "dump", "--values", "resources", str(apk)], capture=True)
    return inspect_apk(apk, badging, manifest, signer, args.abi, args.mode, args.api_url,
                       signing.expected_sha256 if signing else None,
                       resources=resources,
                       require_push=getattr(args, "require_push", False),
                       google_services=getattr(args, "google_services", None))


def publish_apk(built, output, tools, args, signing=None):
    # Keep an existing deliverable until the new signature and bundle are verified.
    with tempfile.TemporaryDirectory(prefix=".okami-sign-", dir=output.parent) as directory:
        staged = Path(directory) / "release.apk"
        if signing:
            if load_signing_config(signing.source) != signing:
                raise ValueError("Signing configuration changed during the build")
            try:
                run([str(tools["apksigner"]), "sign", "--ks", str(signing.keystore),
                     "--ks-key-alias", signing.alias,
                     "--ks-pass", "file:" + str(signing.keystore_password),
                     "--key-pass", "file:" + str(signing.key_password),
                     "--debuggable-apk-permitted", "false", "--v4-signing-enabled", "false",
                     "--out", str(staged), "--in", str(built)], capture=True)
            except subprocess.CalledProcessError as error:
                raise ValueError(f"Private Android signing failed (exit {error.returncode}); check the key alias and protected password files locally") from None
        else:
            shutil.copyfile(built, staged)
        receipt = verify(staged, tools, args, signing)
        os.replace(staged, output)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check local prerequisites without building")
    parser.add_argument("--verify-apk", type=Path, help="verify an already built APK")
    parser.add_argument("--signing-config", type=Path,
                        help="private JSON referencing an existing project keystore and password files")
    parser.add_argument("--google-services-file", type=Path, default=os.environ.get("GOOGLE_SERVICES_FILE"),
                        help="Firebase Android client JSON; required for a signed public release")
    parser.add_argument("--api-url", default="http://10.0.2.2:8787")
    parser.add_argument("--abi", choices=["arm64-v8a", "x86_64"], default="arm64-v8a")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts/android")
    parser.add_argument("--max-workers", type=int, default=2)
    args = parser.parse_args()
    args.mode = "release"
    args.api_url = public_api_url(args.api_url)
    if not 1 <= args.max_workers <= 8:
        raise ValueError("max-workers must be between 1 and 8")
    signing = load_signing_config(args.signing_config) if args.signing_config else None
    args.require_push = bool(signing and urlsplit(args.api_url).scheme == "https")
    args.google_services = load_google_services(args.google_services_file) if args.google_services_file else None
    if args.require_push and not args.google_services and not args.verify_apk:
        raise ValueError("Signed public Android releases require --google-services-file for notifications")
    sdk, tools = android_tools()
    cli = MOBILE / "node_modules/expo/bin/cli"
    if not args.verify_apk and not cli.is_file():
        raise ValueError("Run one frozen workspace install before building")
    if args.check:
        print(json.dumps({"sdk": str(sdk), "buildTools": tools["aapt"].parent.name,
                          "apiUrl": args.api_url, "abi": args.abi, "mode": args.mode,
                          "cloudBuild": False,
                          "nativePushConfigured": bool(args.google_services),
                          "signing": "project-private-configured" if signing else "local Android debug key by default"}, indent=2))
        return
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.verify_apk:
        apk = args.verify_apk.resolve()
        source = {}
        receipt = verify(apk, tools, args, signing)
    else:
        source = {"sourceCommit": run(["git", "rev-parse", "HEAD"], capture=True).strip(),
                  "sourceDirty": bool(run(["git", "status", "--porcelain"], capture=True).strip())}
        # Expo 54 disables Metro resetCache under CI. Give each build a private
        # cache so a previous API endpoint cannot survive in the Hermes bundle.
        with tempfile.TemporaryDirectory(prefix="okami-metro-") as metro_cache:
            env = {**os.environ, "ANDROID_HOME": str(sdk), "ANDROID_SDK_ROOT": str(sdk),
                   "EXPO_PUBLIC_API_URL": args.api_url, "EXPO_NO_TELEMETRY": "1", "CI": "1",
                   "NODE_ENV": "production", "TMPDIR": metro_cache,
                   "CMAKE_BUILD_PARALLEL_LEVEL": str(args.max_workers)}
            if args.google_services_file:
                env["GOOGLE_SERVICES_FILE"] = str(args.google_services_file.expanduser().resolve())
            unchanged = {path: path.read_bytes() for path in [MOBILE / "package.json", ROOT / "pnpm-lock.yaml"]}
            run(["node", str(cli), "prebuild", "--platform", "android", "--no-install",
                 "--skip-dependency-update", "react,react-native"], cwd=MOBILE, env=env)
            if any(path.read_bytes() != content for path, content in unchanged.items()):
                raise ValueError("Prebuild changed tracked dependency manifests; reconcile the frozen lock before building")
            android = MOBILE / "android"
            # The public endpoint is a build-time env input that Gradle cannot fingerprint.
            # Remove only this generated task output so every build embeds its requested URL.
            bundle_output = android / "app/build/generated/assets/createBundleReleaseJsAndAssets"
            if bundle_output.exists():
                shutil.rmtree(bundle_output)
            run([str(android / "gradlew"), "assembleRelease", "--no-daemon", f"--max-workers={args.max_workers}",
                 f"-PreactNativeArchitectures={args.abi}", "--no-build-cache", "-Dorg.gradle.parallel=false",
                 "-Dorg.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g"], cwd=android, env=env)
            built = android / f"app/build/outputs/apk/{args.mode}/app-{args.mode}.apk"
            apk = args.output_dir / f"okamibot-{args.mode}-{args.abi}.apk"
            receipt = publish_apk(built, apk, tools, args, signing)
    target = args.output_dir / f"{apk.stem}.json"
    if args.verify_apk and target.exists():
        previous = json.loads(target.read_text())
        if previous.get("sha256") == receipt["sha256"]:
            source = {key: previous[key] for key in ["sourceCommit", "sourceDirty"] if key in previous}
    receipt.update({**source, "apk": str(apk),
                    "verificationSourceCommit": run(["git", "rev-parse", "HEAD"], capture=True).strip(),
                    "cloudBuild": False, "physicalAcceptance": False})
    target.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"Android local build failed: {error}", file=sys.stderr)
        sys.exit(1)
