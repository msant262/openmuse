import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from build_android_local import ROOT, inspect_apk, load_google_services, load_signing_config, public_api_url, publish_apk


class AndroidReleaseTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.apk = Path(self.directory.name) / "local.apk"
        with zipfile.ZipFile(self.apk, "w") as archive:
            for name in ["AndroidManifest.xml", "classes.dex", "assets/index.android.bundle",
                         "lib/arm64-v8a/libhermes.so", "lib/arm64-v8a/libreactnative.so"]:
                archive.writestr(name, b"compiled fixture http://10.0.2.2:8787")
            archive.writestr("assets/openmuse-LICENSE.txt", (ROOT / "LICENSE").read_bytes())
            archive.writestr("assets/openmuse-ASSET-NOTICE.txt", b"upstream artwork notice")
        self.badging = """package: name='app.openmuse.mobile' versionCode='1' versionName='0.1.0'
application-label:'OkamiBot'
launchable-activity: name='app.openmuse.mobile.MainActivity'
native-code: 'arm64-v8a'
"""
        self.manifest = 'A: android:scheme(0x01010027)="openmuse" (Raw: "openmuse")'
        self.signer = """Signer #1 certificate DN: CN=Android Debug, O=Android, C=US
Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
"""

    def inspect(self, **kwargs):
        return inspect_apk(self.apk, kwargs.get("badging", self.badging),
                           kwargs.get("manifest", self.manifest), kwargs.get("signer", self.signer),
                           "arm64-v8a", "release", "http://10.0.2.2:8787",
                           kwargs.get("expected_signer_sha256"),
                           resources=kwargs.get("resources", ""),
                           require_push=kwargs.get("require_push", False))

    def test_notification_release_requires_compiled_firebase_resources(self):
        with self.assertRaisesRegex(ValueError, "Firebase"):
            self.inspect(require_push=True)
        resources = "\n".join(
            f'        resource 0x7f120001 app.openmuse.mobile:string/{name}: t=0x03\n'
            f'          (string8) "{value}"'
            for name, value in [("google_app_id", "1:123456:android:abc"),
                                ("gcm_defaultSenderId", "123456"),
                                ("google_api_key", "synthetic-public-api-key"),
                                ("project_id", "okamibot")])
        self.assertTrue(self.inspect(require_push=True, resources=resources)["nativePushConfigured"])
        with self.assertRaisesRegex(ValueError, "Firebase"):
            self.inspect(require_push=True, resources=resources.replace('"123456"', '""'))

    def test_google_services_matches_the_existing_android_identity(self):
        config = Path(self.directory.name) / "google-services.json"
        value = {"project_info": {"project_number": "123456", "project_id": "okamibot"},
                 "client": [{"client_info": {"mobilesdk_app_id": "1:123456:android:abc",
                    "android_client_info": {"package_name": "app.openmuse.mobile"}},
                    "api_key": [{"current_key": "synthetic-public-api-key"}]}]}
        config.write_text(json.dumps(value))
        self.assertEqual(load_google_services(config)["project_id"], "okamibot")
        value["client"][0]["client_info"]["android_client_info"]["package_name"] = "wrong.package"
        config.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "package"):
            load_google_services(config)
        config.write_text('{"private_key":"synthetic-secret-canary"}')
        with self.assertRaises(ValueError) as raised:
            load_google_services(config)
        self.assertNotIn("synthetic-secret-canary", str(raised.exception))

    def signing_config(self):
        directory = Path(self.directory.name)
        for name, value in [("release.jks", "synthetic keystore"),
                            ("store.password", "synthetic-store-secret"),
                            ("key.password", "synthetic-key-secret")]:
            file = directory / name
            file.write_text(value)
            file.chmod(0o600)
        config = directory / "signing.json"
        config.write_text(json.dumps({
            "keystoreFile": "release.jks", "alias": "okamibot",
            "keystorePasswordFile": "store.password", "keyPasswordFile": "key.password",
            "expectedCertificateSha256": "0123456789abcdef" * 4,
        }))
        config.chmod(0o600)
        return config

    def test_installable_local_release_is_not_called_a_production_signature(self):
        result = self.inspect()
        self.assertEqual(result["package"], "app.openmuse.mobile")
        self.assertEqual(result["nativeAbis"], ["arm64-v8a"])
        self.assertFalse(result["debuggable"])
        self.assertEqual(result["signing"], "android-debug-local-only")
        self.assertFalse(result["productionSigned"])
        self.assertTrue(result["embeddedApiUrlVerified"])
        self.assertEqual(len(result["sha256"]), 64)
        json.dumps(result)

    def test_release_refuses_a_changed_paired_package_or_scheme(self):
        with self.assertRaisesRegex(ValueError, "package"):
            self.inspect(badging=self.badging.replace("app.openmuse.mobile", "app.okami.mobile"))
        with self.assertRaisesRegex(ValueError, "scheme"):
            self.inspect(manifest=self.manifest.replace("openmuse", "okami"))

    def test_release_refuses_debuggable_or_unrequested_native_abi(self):
        with self.assertRaisesRegex(ValueError, "debuggable"):
            self.inspect(badging=self.badging + "application-debuggable\n")
        with zipfile.ZipFile(self.apk, "a") as archive:
            archive.writestr("lib/x86_64/libhermes.so", b"unexpected native ABI")
        with self.assertRaisesRegex(ValueError, "ABI"):
            self.inspect()

    def test_release_refuses_missing_hermes_or_embedded_endpoint(self):
        with zipfile.ZipFile(self.apk, "w") as archive:
            archive.writestr("AndroidManifest.xml", b"fixture")
            archive.writestr("classes.dex", b"fixture")
            archive.writestr("assets/index.android.bundle", b"fixture")
            archive.writestr("lib/arm64-v8a/libreactnative.so", b"fixture")
            archive.writestr("assets/openmuse-LICENSE.txt", (ROOT / "LICENSE").read_bytes())
            archive.writestr("assets/openmuse-ASSET-NOTICE.txt", b"upstream artwork notice")
        with self.assertRaisesRegex(ValueError, "Hermes"):
            self.inspect()
        with zipfile.ZipFile(self.apk, "a") as archive:
            archive.writestr("lib/arm64-v8a/libhermes.so", b"fixture")
        with self.assertRaisesRegex(ValueError, "endpoint"):
            self.inspect()

    def test_only_public_endpoint_configuration_can_be_baked_in(self):
        self.assertEqual(public_api_url("https://agent.example.org/"), "https://agent.example.org")
        self.assertEqual(public_api_url("http://10.0.2.2:8787"), "http://10.0.2.2:8787")
        for value in ["https://user:password@example.org", "https://example.org?key=secret",
                      "https://example.org#secret", "file:///private/key", "not a URL"]:
            with self.assertRaises(ValueError, msg=value):
                public_api_url(value)

    def test_private_signing_config_requires_protected_files_and_no_inline_passwords(self):
        config = self.signing_config()
        result = load_signing_config(config)
        self.assertEqual(result.alias, "okamibot")
        self.assertEqual(result.keystore, config.parent / "release.jks")
        self.assertEqual(result.expected_sha256, "0123456789abcdef" * 4)
        config.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            load_signing_config(config)
        config.chmod(0o600)
        password = config.parent / "key.password"
        password.chmod(0o640)
        with self.assertRaisesRegex(ValueError, "private"):
            load_signing_config(config)
        password.chmod(0o600)
        content = json.loads(config.read_text())
        content["password"] = "inline-secret-canary"
        config.write_text(json.dumps(content))
        with self.assertRaises(ValueError) as raised:
            load_signing_config(config)
        self.assertNotIn("inline-secret-canary", str(raised.exception))

    def test_private_signing_config_refuses_symlinks_and_invalid_fingerprint(self):
        config = self.signing_config()
        keystore = config.parent / "release.jks"
        linked = config.parent / "linked.jks"
        linked.symlink_to(keystore)
        content = json.loads(config.read_text())
        content["keystoreFile"] = "linked.jks"
        config.write_text(json.dumps(content))
        with self.assertRaisesRegex(ValueError, "regular"):
            load_signing_config(config)
        content["keystoreFile"] = "release.jks"
        content["expectedCertificateSha256"] = "not-a-fingerprint"
        config.write_text(json.dumps(content))
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            load_signing_config(config)

    def test_project_signing_requires_one_expected_non_debug_certificate(self):
        expected = "0123456789abcdef" * 4
        private_signer = self.signer.replace("CN=Android Debug, O=Android", "CN=OkamiBot Project")
        result = self.inspect(signer=private_signer, expected_signer_sha256=expected)
        self.assertEqual(result["signing"], "project-private-verified")
        self.assertTrue(result["productionSigned"])
        self.assertTrue(result["signatureVerified"])
        self.assertEqual(result["expectedSignerSha256"], expected)
        with self.assertRaisesRegex(ValueError, "debug"):
            self.inspect(expected_signer_sha256=expected)
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.inspect(signer=private_signer, expected_signer_sha256="f" * 64)
        multiple = private_signer + "Signer #2 certificate SHA-256 digest: " + "f" * 64 + "\n"
        with self.assertRaisesRegex(ValueError, "single"):
            self.inspect(signer=multiple, expected_signer_sha256=expected)

    def test_signing_passes_only_password_file_references_and_verifies_before_publish(self):
        signing = load_signing_config(self.signing_config())
        output = Path(self.directory.name) / "published.apk"
        output.write_bytes(b"previous verified APK")
        commands = []
        args = type("Args", (), {"abi": "arm64-v8a", "mode": "release",
                                  "api_url": "http://10.0.2.2:8787"})()

        def fake_run(command, **options):
            commands.append(command)
            self.assertTrue(options["capture"])
            if command[1] == "sign":
                self.assertEqual(command[command.index("--ks-pass") + 1],
                                 "file:" + str(signing.keystore_password))
                self.assertEqual(command[command.index("--key-pass") + 1],
                                 "file:" + str(signing.key_password))
                self.assertEqual(output.read_bytes(), b"previous verified APK")
                shutil.copyfile(command[command.index("--in") + 1],
                                command[command.index("--out") + 1])
                return ""
            if command[1:3] == ["dump", "badging"]:
                return self.badging
            if command[1:3] == ["dump", "xmltree"]:
                return self.manifest
            if command[1:4] == ["dump", "--values", "resources"]:
                return ""
            if command[1] == "verify":
                self.assertEqual(output.read_bytes(), b"previous verified APK")
                return self.signer.replace("CN=Android Debug, O=Android", "CN=OkamiBot Project")
            self.fail("unexpected tool command")

        with patch("build_android_local.run", side_effect=fake_run):
            receipt = publish_apk(self.apk, output, {"aapt": Path("aapt"),
                                  "apksigner": Path("apksigner")}, args, signing)
        self.assertEqual(output.read_bytes(), self.apk.read_bytes())
        self.assertTrue(receipt["signatureVerified"])
        self.assertEqual(receipt["signing"], "project-private-verified")
        for secret in ["synthetic-store-secret", "synthetic-key-secret"]:
            self.assertNotIn(secret, json.dumps(commands))
            self.assertNotIn(secret, json.dumps(receipt))

    def test_wrong_signer_or_sign_failure_preserves_previous_apk(self):
        signing = load_signing_config(self.signing_config())
        output = Path(self.directory.name) / "published.apk"
        output.write_bytes(b"previous verified APK")
        args = type("Args", (), {})()
        def fake_run(command, **options):
            shutil.copyfile(command[command.index("--in") + 1],
                            command[command.index("--out") + 1])
        with patch("build_android_local.run", side_effect=fake_run), \
                patch("build_android_local.verify", side_effect=ValueError("signer fingerprint mismatch")):
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                publish_apk(self.apk, output, {"apksigner": Path("apksigner")}, args, signing)
        self.assertEqual(output.read_bytes(), b"previous verified APK")
        with patch("build_android_local.run", side_effect=OSError("signing unavailable")):
            with self.assertRaises(OSError):
                publish_apk(self.apk, output, {"apksigner": Path("apksigner")}, args, signing)
        self.assertEqual(output.read_bytes(), b"previous verified APK")
        error = subprocess.CalledProcessError(1, ["apksigner"], stderr="synthetic-key-secret")
        with patch("build_android_local.run", side_effect=error):
            with self.assertRaisesRegex(ValueError, "Private Android signing failed") as raised:
                publish_apk(self.apk, output, {"apksigner": Path("apksigner")}, args, signing)
        self.assertNotIn("synthetic-key-secret", str(raised.exception))
        self.assertEqual(output.read_bytes(), b"previous verified APK")
        self.assertFalse(list(output.parent.glob(".okami-sign-*")))


if __name__ == "__main__":
    unittest.main()
