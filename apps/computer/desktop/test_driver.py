"""Driver boundary tests; no access to the operator's graphical session."""
import importlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class Device:
    def __init__(self):
        self.events = []
        self.pixels = bytes([240, 240, 240]) * 12

    def capture(self):
        return 4, 3, self.pixels

    def event(self, *event):
        self.events.append(event)

    def reset(self):
        self.events.append(("reset",))


class DriverContracts(unittest.TestCase):
    def setUp(self):
        self.mod = importlib.import_module("desktop.driver")
        self.device = Device()
        self.now = 0.0
        self.authorized = True
        self.calls = 0

        def guard():
            self.calls += 1
            if not self.authorized:
                raise PermissionError("lease revoked")

        self.driver = self.mod.DesktopDriver(
            self.device, "session-generation-one", clock=lambda: self.now)
        self.guard = guard

    def input(self, frame, action):
        return self.driver.act(frame, action, authorize=self.guard)

    def test_fresh_observations_have_new_identity_but_deduplicate_only_image(self):
        first = self.driver.observe(authorize=self.guard)
        second = self.driver.observe(authorize=self.guard, previous_image=first["imageHash"])
        self.assertNotEqual(first["frameId"], second["frameId"])
        self.assertEqual(first["imageHash"], second["imageHash"])
        self.assertNotIn("image", second)
        self.assertTrue(second["imageUnchanged"])
        with self.assertRaisesRegex(ValueError, "frame"):
            self.input(first, {"action": "click", "x": 1, "y": 1})
        self.assertEqual(self.device.events, [])

    def test_human_can_act_on_displayed_frame_after_an_identical_background_capture(self):
        shown = self.driver.observe(authorize=self.guard)
        self.driver.observe(authorize=self.guard, previous_image=shown["imageHash"])
        result = self.driver.act(shown, {"action": "click", "x": 1, "y": 1},
                                 authorize=self.guard, human=True)
        self.assertTrue(result["inputDelivered"])
        self.assertEqual(result["observedFrameId"], shown["frameId"])
        before = list(self.device.events)
        with self.assertRaises(ValueError):
            self.driver.act(shown, {"action": "click", "x": 1, "y": 1},
                            authorize=self.guard, human=True)
        self.assertEqual(self.device.events, before)

    def test_human_control_tolerates_live_pixels_but_still_binds_session_age_and_authority(self):
        shown = self.driver.observe(authorize=self.guard)
        self.device.pixels = bytes([0, 1, 2]) * 12
        with self.assertRaisesRegex(ValueError, "changed"):
            self.input(shown, {"action": "click", "x": 1, "y": 1})
        # A human is controlling a live display, which may blink or repaint.
        shown = self.driver.observe(authorize=self.guard)
        self.device.pixels = bytes([3, 4, 5]) * 12
        self.driver.act(shown, {"action": "click", "x": 1, "y": 1},
                        authorize=self.guard, human=True)
        self.device.events.clear()
        for change in ("session", "expiry", "revoked", "reset"):
            shown = self.driver.observe(authorize=self.guard)
            if change == "session": shown = {**shown, "sessionGeneration": "another-session"}
            if change == "expiry": self.now += 31
            if change == "revoked": self.authorized = False
            if change == "reset": self.driver.invalidate(); self.device.events.clear()
            with self.assertRaises((ValueError, PermissionError)):
                self.driver.act(shown, {"action": "click", "x": 1, "y": 1},
                                authorize=self.guard, human=True)
            self.assertEqual(self.device.events, [])
            self.authorized = True

    def test_human_observation_history_is_bounded_and_unknown_frames_never_dispatch(self):
        first = self.driver.observe(authorize=self.guard)
        for _ in range(40): self.driver.observe(authorize=self.guard)
        with self.assertRaises(ValueError):
            self.driver.act(first, {"action": "click", "x": 1, "y": 1},
                            authorize=self.guard, human=True)
        last = self.driver.observe(authorize=self.guard)
        with self.assertRaises(ValueError):
            self.driver.act({**last, "frameId": "unknown"}, {"action": "click", "x": 1, "y": 1},
                            authorize=self.guard, human=True)
        self.assertEqual(self.device.events, [])

    def test_changed_pixels_expiry_generation_and_coordinates_block_input(self):
        frame = self.driver.observe(authorize=self.guard)
        self.device.pixels = bytes([0, 1, 2]) * 12
        with self.assertRaisesRegex(ValueError, "changed"):
            self.input(frame, {"action": "click", "x": 1, "y": 1})
        frame = self.driver.observe(authorize=self.guard)
        self.now = 31
        with self.assertRaisesRegex(ValueError, "expired"):
            self.input(frame, {"action": "click", "x": 1, "y": 1})
        frame = self.driver.observe(authorize=self.guard)
        for binding in ({**frame, "sessionGeneration": "other"}, {**frame, "width": 40}):
            with self.assertRaises(ValueError):
                self.input(binding, {"action": "click", "x": 1, "y": 1})
        for x in (-1, 4, float("nan"), True):
            with self.assertRaises(ValueError):
                self.input(frame, {"action": "click", "x": x, "y": 1})
        self.assertEqual(self.device.events, [])

    def test_revoke_mid_drag_releases_buttons_and_consumes_frame(self):
        frame = self.driver.observe(authorize=self.guard)
        original = self.device.event

        def event(*args):
            original(*args)
            if args == ("button", 1, True):
                self.authorized = False

        self.device.event = event
        with self.assertRaises(PermissionError):
            self.input(frame, {"action": "drag", "x": 0, "y": 0, "toX": 3, "toY": 2})
        self.assertEqual(self.device.events[-1], ("reset",))
        self.assertNotIn(("move", 3, 2), self.device.events)
        self.authorized = True
        with self.assertRaisesRegex(ValueError, "frame"):
            self.input(frame, {"action": "click", "x": 1, "y": 1})

    def test_masks_apply_before_image_hash_and_png_encoding(self):
        first = self.driver.observe(authorize=self.guard, masks=[(0, 0, 2, 3)])
        hidden_changed = bytearray(self.device.pixels)
        for y in range(3):
            hidden_changed[y * 12:y * 12 + 6] = bytes([99]) * 6
        self.device.pixels = bytes(hidden_changed)
        second = self.driver.observe(authorize=self.guard, masks=[(0, 0, 2, 3)])
        self.assertEqual(first["imageHash"], second["imageHash"])
        self.assertNotIn("windows", first)
        # A hidden mutation still invalidates the action observation.
        with self.assertRaisesRegex(ValueError, "frame"):
            self.input(first, {"action": "click", "x": 3, "y": 2})

    def test_authority_rechecked_after_capture_and_never_logged_in_receipt(self):
        frame = self.driver.observe(authorize=self.guard)
        original = self.device.capture

        def capture():
            self.authorized = False
            return original()

        self.device.capture = capture
        with self.assertRaises(PermissionError):
            self.input(frame, {"action": "type", "text": "private typed data"})
        self.assertEqual(self.device.events, [])
        self.device.capture = original
        self.authorized = True
        frame = self.driver.observe(authorize=self.guard)
        receipt = self.input(frame, {"action": "type", "text": "Olá — Größe"})
        self.assertEqual(self.device.events[0], ("text", "Olá — Größe"))
        self.assertNotIn("Olá", str(receipt))
        self.assertEqual(receipt["sessionGeneration"], frame["sessionGeneration"])

    def test_strict_action_shape_and_key_allowlist(self):
        frame = self.driver.observe(authorize=self.guard)
        invalid = [
            {"action": "click", "x": 1, "y": 1, "display": ":0"},
            {"action": "press", "key": "Return exec bash"},
            {"action": "type", "text": "bad\x00input"},
            {"action": "scroll", "deltaY": 10001},
        ]
        for action in invalid:
            with self.assertRaises(ValueError):
                self.input(frame, action)
        self.assertEqual(self.device.events, [])

    def test_drag_cannot_cross_a_mask_between_visible_endpoints(self):
        frame = self.driver.observe(authorize=self.guard, masks=[(1, 1, 1, 1)])
        with self.assertRaisesRegex(ValueError, "masked"):
            self.input(frame, {"action": "drag", "x": 0, "y": 0, "toX": 3, "toY": 2})
        self.assertEqual(self.device.events, [])

    def test_revocation_during_png_encoding_discards_observation(self):
        original = self.mod.png
        def encode(*args):
            self.authorized = False
            return original(*args)
        with patch.object(self.mod, "png", side_effect=encode), self.assertRaises(PermissionError):
            self.driver.observe(authorize=self.guard)
        self.assertIsNone(self.driver.frame)


if __name__ == "__main__":
    unittest.main()
