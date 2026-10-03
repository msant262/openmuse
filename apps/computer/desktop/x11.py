"""X11 adapter for one registered session process, never the operator's DISPLAY.

Requires distribution python3-xlib and xdotool. Text uses stdin, not a command
line, clipboard, environment variable, log or saved file. The caller must run
inside the managed session with the exact trusted DISPLAY/XAUTHORITY pair.
"""
import os
import subprocess

from .driver import KEYS


class X11Device:
    def preflight(self):
        from Xlib import X
        from Xlib.ext import xtest
        if not self.display.has_extension("XTEST"):
            raise ValueError("Native XTest input extension is unavailable")
        window=self.root.create_window(0,0,64,48,0,self.display.screen().root_depth,
            event_mask=X.ButtonPressMask|X.ButtonReleaseMask|X.KeyPressMask|X.KeyReleaseMask)
        try:
            window.map();window.set_input_focus(X.RevertToParent,X.CurrentTime);self.display.sync()
            self.event("move",20,20);self.event("button",1,True);self.event("button",1,False)
            xtest.fake_input(self.display,X.KeyPress,self.display.keysym_to_keycode(ord("q")))
            xtest.fake_input(self.display,X.KeyRelease,self.display.keysym_to_keycode(ord("q")))
            self.display.sync()
            kinds=[]
            while self.display.pending_events():kinds.append(self.display.next_event().type)
            if X.ButtonPress not in kinds or X.KeyPress not in kinds:
                raise ValueError("Native input test window did not receive XTest events")
            self.capture()
        finally:
            self.reset();window.destroy();self.display.sync()
    def __init__(self, display_name, authority):
        if os.environ.get("DISPLAY") != display_name or os.environ.get("XAUTHORITY") != authority:
            raise ValueError("X11 driver environment does not match the registered session")
        from Xlib import X, display
        from Xlib.ext import xtest
        self.X, self.xtest = X, xtest
        self.display = display.Display(display_name)
        self.root = self.display.screen().root
        self.env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DISPLAY": display_name,
                    "XAUTHORITY": authority}
        self.buttons = set()

    def close(self):
        try:
            self.reset()
        finally:
            self.display.close()

    def capture(self):
        screen = self.display.screen()
        geometry = self.root.get_geometry()
        width, height = geometry.width, geometry.height
        if not 1 <= width <= 3840 or not 1 <= height <= 2160:
            raise ValueError("Desktop dimensions exceed the capture budget")
        visual = next((visual for depth in screen.allowed_depths for visual in depth.visuals
                       if visual.visual_id == screen.root_visual), None)
        formats = self.display.display.info.pixmap_formats
        format_info = next((value for value in formats if value.depth == screen.root_depth), None)
        if (not visual or not format_info or format_info.bits_per_pixel != 32
                or screen.root_depth != 24
                or (visual.red_mask, visual.green_mask, visual.blue_mask) != (0xFF0000, 0xFF00, 0xFF)):
            raise ValueError("Managed desktop requires a supported RGB888 depth-24 visual")
        pixels = self.root.get_image(0, 0, width, height, self.X.ZPixmap, 0xFFFFFFFF).data
        if len(pixels) != width * height * 4:
            raise ValueError("Unexpected desktop image stride")
        rgb = bytearray(width * height * 3)
        if self.display.display.info.image_byte_order == 0:
            rgb[0::3], rgb[1::3], rgb[2::3] = pixels[2::4], pixels[1::4], pixels[0::4]
        else:
            rgb[0::3], rgb[1::3], rgb[2::3] = pixels[1::4], pixels[2::4], pixels[3::4]
        return width, height, bytes(rgb)

    def event(self, kind, *args):
        if kind == "move":
            self.xtest.fake_input(self.display, self.X.MotionNotify, x=args[0], y=args[1])
        elif kind == "button":
            button, down = args
            if down:
                self.buttons.add(button)
            self.xtest.fake_input(self.display, self.X.ButtonPress if down else self.X.ButtonRelease, button)
            if not down:
                self.buttons.discard(button)
        elif kind == "text":
            self._xdotool(["type", "--clearmodifiers", "--delay", "1", "--file", "-"], args[0])
        elif kind == "key":
            key = args[0]
            if key not in KEYS:
                raise ValueError("Unsupported desktop key")
            aliases = {"Enter": "Return", "Space": "space", "ArrowUp": "Up", "ArrowDown": "Down",
                       "ArrowLeft": "Left", "ArrowRight": "Right", "PageUp": "Prior", "PageDown": "Next"}
            key = "+".join(aliases.get(part, part) for part in key.split("+"))
            self._xdotool(["key", "--clearmodifiers", "--", key])
        else:
            raise ValueError("Unsupported X11 event")
        self.display.sync()

    def _xdotool(self, arguments, text=None):
        try:
            completed = subprocess.run(["/usr/bin/xdotool", *arguments], input=text,
                                       env=self.env, text=True, capture_output=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError("Desktop keyboard input was interrupted") from None
        if completed.returncode:
            # Tool diagnostics may include typed content: never propagate them.
            raise RuntimeError("Desktop keyboard input could not be confirmed")

    def reset(self):
        # Dedicated session and shared input lease: there is no other permitted
        # input owner when cleanup runs. Also repairs modifiers held by a lost
        # previous connection, not only this instance's bookkeeping.
        pressed = self.display.query_keymap()
        for code in range(8, 256):
            if pressed[code // 8] & (1 << (code % 8)):
                self.xtest.fake_input(self.display, self.X.KeyRelease, code)
        for button in range(1, 6):
            self.xtest.fake_input(self.display, self.X.ButtonRelease, button)
        self.buttons.clear()
        self.display.sync()
