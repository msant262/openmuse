#!/usr/bin/env python3
"""Install on an explicit local emulator; prove sample UI and restored draft/pairing."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET

from build_android_local import ROOT, PACKAGE, android_tools, verify


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts/android/smoke")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        raise ValueError("Smoke supports an explicit disposable emulator serial only")
    if not shutil.which("adb"):
        raise ValueError("adb is required")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    data = args.output_dir / "sample-data"
    if data.exists():
        raise ValueError("Use a new smoke output directory; existing sample data is preserved")
    data.mkdir()
    api = f"http://127.0.0.1:{args.port}"
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", args.port))
        except OSError as error:
            raise ValueError("Smoke port is occupied; existing service is preserved") from error

    def adb(*command, binary=False):
        result = subprocess.run(["adb", "-s", args.serial, *command], check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=not binary)
        return result.stdout

    def tree():
        adb("shell", "uiautomator", "dump", "/sdcard/okamibot-smoke.xml")
        source = adb("shell", "cat", "/sdcard/okamibot-smoke.xml")
        return ET.fromstring(source), source

    def wait_for(predicate, timeout=35):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current, source = tree()
            if predicate(current):
                return current, source
            time.sleep(0.5)
        raise ValueError("Expected native UI did not appear before the smoke deadline")

    def tap(node):
        values = [int(value) for value in re.findall(r"\d+", node.attrib["bounds"])]
        adb("shell", "input", "tap", str((values[0] + values[2]) // 2),
            str((values[1] + values[3]) // 2))

    def editor(current):
        return next((node for node in current.iter("node")
                     if node.get("content-desc") == "Message OkamiBot"), None)

    _, tools = android_tools()
    verify(args.apk.resolve(), tools, argparse.Namespace(
        abi=adb("shell", "getprop", "ro.product.cpu.abi").strip(), mode="release",
        api_url=f"http://10.0.2.2:{args.port}"))

    env = {**os.environ, "ANDROID_SMOKE_DATA": str(data.resolve()),
           "ANDROID_SMOKE_PORT": str(args.port)}
    with (args.output_dir / "server.log").open("w") as log:
        server = subprocess.Popen(["node", str(ROOT / "node_modules/tsx/dist/cli.mjs"),
                                   str(ROOT / "scripts/android_demo_server.ts")],
                                  cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        result = {"package": PACKAGE, "serial": args.serial, "physicalDevice": False,
                  "liveAccounts": False}
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    urllib.request.urlopen(f"{api}/api/health", timeout=1).close()
                    break
                except OSError:
                    if server.poll() is not None or time.monotonic() > deadline:
                        raise ValueError("Isolated sample API failed to start")
                    time.sleep(0.25)
            adb("install", "-r", str(args.apk.resolve()))
            adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")
            current, source = wait_for(lambda root: editor(root) is not None)
            (args.output_dir / "initial.xml").write_text(source)
            (args.output_dir / "initial.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
            draft = "Android smoke draft"
            tap(editor(current))
            adb("shell", "input", "text", draft.replace(" ", "%s"))
            wait_for(lambda root: any(node.get("text") == draft for node in root.iter("node")))
            time.sleep(1)
            adb("shell", "input", "keyevent", "KEYCODE_BACK")
            adb("shell", "am", "force-stop", PACKAGE)
            adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")
            current, source = wait_for(lambda root: any(node.get("text") == draft for node in root.iter("node")))
            (args.output_dir / "restored.xml").write_text(source)
            (args.output_dir / "restored.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
            result.update({"launcherAndChat": True, "keyboardDraftEntry": True, "draftRestored": True})
            apps = next((node for node in current.iter("node") if node.get("text") == "Apps" or node.get("content-desc") == "Apps"), None)
            if apps is None:
                raise ValueError("Apps navigation is missing")
            tap(apps)
            _, source = wait_for(lambda root: any(node.get("text") == "Your connections" for node in root.iter("node")))
            (args.output_dir / "apps.xml").write_text(source)
            result["appsNavigation"] = True
            pid = adb("shell", "pidof", PACKAGE).strip().split()[0]
            logcat = adb("logcat", "-d", "-t", "300", "--pid", pid,
                         "AndroidRuntime:E", "ReactNativeJS:E", "*:S")
            (args.output_dir / "runtime.log").write_text(logcat)
            if "FATAL EXCEPTION" in logcat:
                raise ValueError("Native runtime crash appeared in logcat")
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        summary = json.loads((data / "server-summary.json").read_text())
        result.update(summary)
        if summary["pairRequests"] != 1 or summary["workspaceReads"] < 2:
            raise ValueError("Reopen did not reuse a single saved pairing")
        (args.output_dir / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
