# Desktop workspace correction after owner feedback

The earlier interface release corrected separate dialogs but left the surrounding desktop composition inconsistent. The owner rejected that result. This revision changes the desktop workspace as a whole while preserving the approved avatar media and current identity.

## Reference-to-implementation decisions

The inspected sources remain the actual product screenshots and video frames recorded in `2026-10-03-muse-interface-reference.md`, especially the light collapsed chat, Claire's desktop at 05:30, document reader at 06:50, library at 21:50, task dialog at 24:15, and split browser at 30:40. Light and dark references establish structure; this implementation remains the light appearance. Pixel identity is not claimed.

- Removed the empty horizontal toolbar above content destinations. Feed, Ideas, Goals and Apps now share one content canvas and top spacing.
- Removed the duplicate rail avatar and permanent utility shortcuts. The six primary destinations form a compact central rail; computer and the app menu remain at its foot. Notifications and connections are real actions inside that menu.
- Chat uses floating conversation controls over a fading header. The reading column expands with the available workspace. Inspector width adapts to the viewport and the collapsed companion remains centered.
- Browser and computer details become an actual split workspace beside the existing conversation, with expand/restore controls. Opening or closing that workspace preserves the mounted conversation and unsent draft. Rail navigation can leave the workspace normally.
- Documents use the workspace reader with the rail preserved, a compact filename toolbar, document canvas, separate PDF form fields and a download/share footer. Other task/settings/approval dialogs retain the modal composition observed in the corresponding references.
- Added real previews for saved HTML, Markdown/plain text, video and audio. HTML loads as isolated content, without inheriting the application's origin; passive library thumbnails cannot execute scripts. Image and video cards show the actual uploaded media. The default All artifacts category contains documents and web artifacts; avatar images and clips remain in Media rather than overwhelming the default document grid. Desktop library columns adapt at 1440, 1280 and 1024 instead of relying on fixed card widths.
- Mobile keeps its existing bottom navigation, full agent panel and file sheets. This revision does not replace the approved avatar assets, generation pipeline or selection.

## Verification

`artifacts/muse-interface/desktop-correction/checks.json` records an actual browser run with local sample data. It covers all main content destinations at 1440/1280/1024, split/expanded computer, preserved draft, real HTML/Markdown/video/PDF readers, task and settings dialogs, and a 390px mobile file sheet. No horizontal overflow or page errors were found. The split workspace at 1440 is x=498, width=942, with a 430px conversation next to the 68px rail.

The local preview includes imported sample documents and copies of the approved bundled companion media solely to exercise preview behavior. No production identity or avatar selection was changed. Saved native desktop input and real browser viewer tests passed, including stale-frame rejection and takeover recovery. The sample preview has no connected browser executor, so a live external browser task was not simulated in the screenshots.

The integrated UI/mobile/viewer suite passed 145 tests. Additional meaningful preview tests verify HTML sandbox isolation, disabled thumbnail scripts, and user-controlled media playback. Mobile TypeScript and the edited-file lint checks passed. Screenshot review and the structural comparison are evidence for this implementation, not a substitute for the owner's visual acceptance.
