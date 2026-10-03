"""Fresh-frame input boundary; the caller supplies existing task/lease authority.

This module owns no permission, task or replay database. In production the native
supervisor must bind authorize to its current epoch, gate and shared GUI/DOM
resource lease. A successful input receipt confirms input delivery, never that a
purchase, document or other business outcome succeeded.
"""
import base64
import datetime
import hashlib
import math
import struct
import threading
import time
import uuid
import zlib


KEYS = {
    "Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "Home", "End",
    "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Control+a", "Control+c", "Control+v", "Control+x", "Control+z", "Control+s",
    "Control+l", "Control+f", "Control+Shift+z", "Shift+Tab", "Alt+F4",
}


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid desktop coordinate or input limit")
    return value


def validate_action(action, width, height):
    if not isinstance(action, dict):
        raise ValueError("Desktop action must be an object")
    kind = action.get("action")
    fields = {
        "click": {"action", "x", "y"}, "doubleClick": {"action", "x", "y"},
        "drag": {"action", "x", "y", "toX", "toY"},
        "type": {"action", "text"}, "press": {"action", "key"},
        "scroll": {"action", "deltaY"}, "focus": {"action", "x", "y"},
    }
    if not isinstance(kind, str) or kind not in fields or set(action) != fields[kind]:
        raise ValueError("Unsupported desktop action fields")
    if "x" in action:
        integer(action["x"], 0, width - 1)
        integer(action["y"], 0, height - 1)
    if kind == "drag":
        integer(action["toX"], 0, width - 1)
        integer(action["toY"], 0, height - 1)
    if kind == "type":
        text = action["text"]
        if (not isinstance(text, str) or not 1 <= len(text) <= 2000
                or any(ord(char) == 0 or 0xD800 <= ord(char) <= 0xDFFF for char in text)):
            raise ValueError("Invalid desktop text")
    if kind == "press" and (not isinstance(action["key"], str) or action["key"] not in KEYS):
        raise ValueError("Unsupported desktop key")
    if kind == "scroll":
        integer(action["deltaY"], -1200, 1200)
    return kind


def png(width, height, pixels):
    def chunk(kind, data):
        return (struct.pack("!I", len(data)) + kind + data
                + struct.pack("!I", zlib.crc32(kind + data)))
    rows = b"".join(b"\x00" + pixels[y * width * 3:(y + 1) * width * 3]
                    for y in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 3)) + chunk(b"IEND", b""))


def crosses_mask(action, rectangle):
    x, y, width, height = rectangle
    lower, upper = 0.0, 1.0
    for start, end, minimum, maximum in (
        (action["x"], action["toX"], x, x + width),
        (action["y"], action["toY"], y, y + height),
    ):
        delta = end - start
        if not delta:
            if start < minimum or start > maximum:
                return False
            continue
        enter, leave = sorted(((minimum - start) / delta, (maximum - start) / delta))
        lower, upper = max(lower, enter), min(upper, leave)
        if lower > upper:
            return False
    return True


class DesktopDriver:
    def __init__(self, device, generation, *, clock=time.monotonic, max_frame_age=30):
        if not isinstance(generation, str) or not 1 <= len(generation) <= 128:
            raise ValueError("A trusted desktop session generation is required")
        if not math.isfinite(max_frame_age) or not 0 < max_frame_age <= 30:
            raise ValueError("Desktop frame age must be bounded")
        self.device, self.generation, self.clock = device, generation, clock
        self.max_frame_age = max_frame_age
        self.lock = threading.RLock()
        self.frame = None

    def capture(self):
        width, height, pixels = self.device.capture()
        integer(width, 1, 3840)
        integer(height, 1, 2160)
        if not isinstance(pixels, bytes) or len(pixels) != width * height * 3:
            raise ValueError("Invalid desktop pixel buffer")
        return width, height, pixels

    def observe(self, *, authorize, masks=(), previous_image=None):
        with self.lock:
            self.frame = None
            authorize()
            width, height, pixels = self.capture()
            captured_at = self.clock()
            raw_hash = hashlib.sha256(pixels).hexdigest()
            masked = bytearray(pixels)
            if len(masks) > 100:
                raise ValueError("Too many private desktop regions")
            rectangles = []
            for x, y, w, h in masks:
                integer(x, 0, width - 1)
                integer(y, 0, height - 1)
                integer(w, 1, width - x)
                integer(h, 1, height - y)
                rectangles.append((x, y, w, h))
                for row in range(y, y + h):
                    start = (row * width + x) * 3
                    masked[start:start + w * 3] = b"\x00" * (w * 3)
            image_hash = hashlib.sha256(masked).hexdigest()
            frame = {"sessionGeneration": self.generation, "frameId": str(uuid.uuid4()),
                     "width": width, "height": height, "imageHash": image_hash,
                     "observedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}
            if image_hash == previous_image:
                result = {**frame, "imageUnchanged": True}
            else:
                result = {**frame, "imageUnchanged": False, "mimeType": "image/png",
                          "image": base64.b64encode(png(width, height, bytes(masked))).decode("ascii")}
            authorize()  # Encoding can outlive a control grant too.
            self.frame = (frame, captured_at, raw_hash, rectangles)
            return result

    def invalidate(self):
        with self.lock:
            self.frame = None
            self.device.reset()

    def act(self, binding, action, *, authorize, allow_sensitive=False, before_event=lambda:None, after_reset=lambda:None):
        with self.lock:
            if not self.frame or not isinstance(binding, dict):
                raise ValueError("Observe a fresh desktop frame first")
            frame, captured_at, expected_pixels, masks = self.frame
            if any(binding.get(key) != frame[key]
                   for key in ("frameId", "sessionGeneration", "width", "height")):
                raise ValueError("Desktop frame or session generation is stale")
            if self.clock() - captured_at >= self.max_frame_age:
                raise ValueError("Desktop observation expired")
            kind = validate_action(action, frame["width"], frame["height"])
            if not allow_sensitive and kind == "drag" and any(crosses_mask(action, rectangle) for rectangle in masks):
                raise ValueError("Agent drag cannot cross a masked credential region")
            for xkey, ykey in (("x", "y"), ("toX", "toY")):
                if not allow_sensitive and xkey in action and any(x <= action[xkey] < x + w and y <= action[ykey] < y + h
                                         for x, y, w, h in masks):
                    raise ValueError("Agent input cannot target a masked credential region")
            authorize()
            width, height, pixels = self.capture()
            if ((width, height) != (frame["width"], frame["height"])
                    or hashlib.sha256(pixels).hexdigest() != expected_pixels):
                self.frame = None
                raise ValueError("Desktop changed; observe before acting")
            authorize()
            # One observation permits at most one action. An interrupted action
            # needs journal reconciliation and a new observation, never replay.
            self.frame = None

            def event(*args):
                authorize()
                before_event()
                self.device.event(*args)

            try:
                if kind in ("click", "doubleClick", "focus", "drag"):
                    event("move", action["x"], action["y"])
                    event("button", 1, True)
                    if kind == "drag":
                        for step in range(1, 11):
                            event("move", round(action["x"] + (action["toX"] - action["x"]) * step / 10),
                                  round(action["y"] + (action["toY"] - action["y"]) * step / 10))
                    event("button", 1, False)
                    if kind == "doubleClick":
                        event("button", 1, True)
                        event("button", 1, False)
                elif kind == "type":
                    for offset in range(0, len(action["text"]), 16):
                        event("text", action["text"][offset:offset + 16])
                elif kind == "press":
                    event("key", action["key"])
                elif kind == "scroll":
                    button = 5 if action["deltaY"] > 0 else 4
                    for _ in range(math.ceil(abs(action["deltaY"]) / 120)):
                        event("button", button, True)
                        event("button", button, False)
            finally:
                # Release-only cleanup is permitted after a revoked input grant.
                self.device.reset()
                after_reset()
            return {"inputDelivered": True, "sessionGeneration": self.generation,
                    "observedFrameId": frame["frameId"], "action": kind}
