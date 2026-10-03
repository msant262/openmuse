# Muse interface reference audit — 3 October 2026

The owner approved the current avatar artwork and rejected interface fidelity. Preserve all avatar assets, generation, selection and motion behavior. This audit concerns screen composition, navigation, menus and dialogs only.

## Evidence and confidence

- **Observed official footage:** [Meta product tour](https://www.youtube.com/watch?v=wHn0hTjvFoo), local `artifacts/muse-research/official-tour.mp4`, 1920×1080, 156.99 seconds. Light mobile interface. Source transcript is adjacent.
- **Observed independent footage:** [Claire Vo walkthrough](https://www.youtube.com/watch?v=2UwemqPkJSQ), local `artifacts/muse-research/claire-tour.mp4`, 1920×1080, 2231.63 seconds. Dark desktop, red theme changing to green after creation. Presenter overlays and purple video border are not product UI.
- **Observed independent screenshots:** [Whoops firsthand walkthrough](https://seo.whoops.com.tw/meta-muse/) identifies web screenshots as September 27–28. Only actual product screenshots are used; its illustrated concept diagrams are excluded. Files `meta-muse-*.webp` under `artifacts/muse-interface/reference/`. The white footer with the WHOOPS logo is publication artwork, not product UI.
- **Independent corroboration:** [Yahoo/Business Insider settings article](https://tech.yahoo.com/ai/meta-ai/articles/stop-meta-training-muse-data-163434020.html) and [Yahoo/Engadget setup article](https://tech.yahoo.com/ai/meta-ai/articles/started-metas-ai-agent-muse-140000310.html). Raw pages and image URLs are saved in the reference folder. Web text reader returned 403 for Yahoo; direct public page/image requests succeeded. No authentication was used.
- **Current implementation evidence:** `artifacts/muse-fidelity/shell/desktop-media.png`, `studio-idle.png`, `mobile-media.png`, `mobile-agent-panel.png`, `mobile-library.png` and adjacent receipts.

Every screenshot below is in `artifacts/muse-interface/reference/`. Film measurements are approximate screen pixels, **not CSS measurements**: the footage is scaled and occasionally zoomed. Do not blindly implement the raw values. Suggested normalized dimensions are explicitly estimates.

## Immediate corrections with strongest evidence

1. Settings belongs in a centered dialog reached from the bottom rail menu. Fixed navigation column on the left, one scrolling pane on the right. The current full-page stack of Avatar Studio, profile and preferences is incompatible with this observed composition.
2. Desktop rail order is Chat, Search, Feed, Ideas, Goals, Library. Search is a primary icon, while connectors are inside Settings. Menu and optional download utilities sit at the bottom. The current shell omits Search and places utility controls differently.
3. The compact avatar/name/status floats over a top fade in collapsed desktop chat as well as mobile. It is not a full-width page header. Chat passes behind it.
4. Avatar creation in Claire's footage is conversational: prompt, four square images in a compact 2×2 grid in chat, selection, then “Generating video” under the avatar. No settings/creation form modal is shown in this film.
5. Mobile agent activity is a full-screen panel with a close control and four icon tabs, without the five-tab primary navigation or composer. Mobile feed/ideas/goals/library preserve the floating avatar and bottom navigation.
6. Content screens have plain rows with thin separators and a generous empty canvas. Repeated large rounded card containers around every block are not the reference pattern.

## Settings, menu and confirmation dialogs

**Direct screenshots:** `meta-muse-general.webp`, `meta-muse-connectors.webp`, `meta-muse-permissions.webp`, `meta-muse-wallet.webp`, `meta-muse-secure-store.webp`, `meta-muse-whatsapp.webp`, `meta-muse-data-controls.webp`. Independent matching light setting: `yahoo-data-3.webp`; dark confirmation: `yahoo-settings-2.webp`; bottom menu: `yahoo-data-2.webp`.

The settings screenshot is 787×663, including a 65-pixel publisher footer. Visible dialog bounds are approximately x14–775, y14–584: **761×570**. Left pane x14–227 is **213px / 28%**; right pane is 548px. Dialog radius is roughly 32–36px. A hairline vertical divider separates columns. Padding: left title x36, right title x250, so approximately 22px each. Titles are about 17px, medium/bold; rows about 13–14px at this image scale. The close button is a white circular ~30px control, x731/y26, with a restrained shadow.

Observed sidebar: General; Connectors; Wallet; Secure store; Permissions; Messaging channels; Devices; Data controls; Help & support; Legal info. Log out is anchored at the bottom. Rows are roughly 34px apart; icon plus label, no descriptions. Active rows use a light gray fill; the blue outline visible in Whoops captures appears to be focus and should not be required on every selected state. Settings body scrolls independently of sidebar; titles remain at the top. Gray groups have ~16px radii and tiny internal separators. No cards nested inside cards.

General shows account, usage, language and appearance groups. Connectors shows a search pill, Connected group, then Available rows with logo, name and a right-aligned action. Permissions shows selectable rows and management groups. Empty Secure store keeps only its explanatory line and Add at the top. Settings screenshots do not show an avatar editor pane. A bottom menu capture shows keyboard shortcuts, app download, issue report and Settings. [Screenshot sources](https://seo.whoops.com.tw/meta-muse/), [independent settings capture](https://tech.yahoo.com/ai/meta-ai/articles/stop-meta-training-muse-data-163434020.html).

The nested dark confirmation in `yahoo-settings-2.webp` has a compact ~410×230px rounded panel, left-aligned question and secondary copy, then two equal width horizontal buttons. The reference is not a full-screen warning page. Preserve the current app's honest capabilities; do not add Meta account/billing rows that have no working equivalent.

**Implementation inference:** a responsive desktop settings dialog around 800–880px wide, 600–680px high, with a 220px sidebar is reasonable after accounting for screenshot scaling. Exact CSS dimensions and mobile settings navigation are not established by the evidence. A mobile section list followed by a detail pane is an adaptation, not a measured copy.

## Desktop chat shell and scale

`claire-tour-0330s.png` at **05:30** provides an unobscured full shell except the lower-left presenter overlay. Product viewport approximately x28–1874, y92–987 = **1846×895**. The reference video has a large desktop viewport:

| Part | Observed frame bounds/dimension | Practical interpretation |
| --- | --- | --- |
| Icon rail | x28–102, width 74 | ~64–68px rail at normal app scale |
| Side chat pane | x102–358, width 256 | separate ~220–240px optional list |
| Chat region | x358–1489, width 1131 | flexible remaining region |
| Inspector | x1489–1874, width 385 | ~320–360px at normal scale |
| Composer | x512–1334, y910–971, 822×61 | centered, width-constrained, ~52–56px high |
| Inspector avatar | x1628–1735, y162–267, ~106px | ~88–96px circular avatar |
| Inspector tabs | x1509–1855, y379–417, 346×38 | horizontal four-way pill |

Main rail glyphs are thin monochrome outlines, roughly 25px in this film. Chat selected circle is about 46px. At 05:30 the six primary centers are y258,318,379,439,499,559: 60px vertical pitch. A lower divider precedes an open PDF shortcut; menu is bottom-left. This PDF shortcut is contextual content, not a required global primary destination.

The side chat pane has search pill at top and adjacent ellipsis. Empty state is small and vertically centered: outline chat icon, a short title, three short muted lines, then a pill action. It should not dominate the whole app. Current side-chat empty state is already directionally close.

Chat has no large generic title. Its reading column uses natural-width bubbles with a limit; blue/red/green sent bubbles are right-aligned and gray received bubbles are left-aligned. The first long received block at 05:30 is x538–1180; sent “Polly” is x1240–1308. The composer reaches wider than typical message bubbles. Body size approximately 18px in the scaled film suggests about 16px normal. Separate timestamp centered above a conversation interval, not a metadata line on every message. Composer: plus at left, “Message” placeholder, microphone at right when empty; filled message uses send arrow. No permanent toolbar of attachment chips is shown below it.

`meta-muse-chat-workspace.webp` independently shows **light collapsed desktop**: a 68px left rail, a top-left rounded chat-title capsule with menu icon and separate back circle, floating avatar centered above chat, a subtle top fade, and a ~54px bottom composer. Its glyph rail has Chat, Search, Feed, Ideas, Goals, Library. The current screenshot `desktop-media.png` keeps an always-visible Computer/Offline capsule and lacks the compact central avatar when inspector is closed; these are visible differences. Desktop is not inherently dark: the product supports light/dark/system and theme colors.

## Desktop inspector, task detail and browser workspace

At 05:30 (`claire-tour-0330s.png`), the inspector has close at top-right, circular avatar and overlapping pencil at lower-right, name beneath, status immediately beneath. Four icon tabs: list/activity, shield/approvals, clock/upcoming, fingerprint/identity. Rows have ~40px square gray icon tiles, title, muted outcome and lighter time. No large card around the whole activity list.

**24:15** `claire-tour-1455s.png` is the actual activity detail dialog. Bounds approximately x435–1463, y162–912 = **1028×750** in the filmed viewport. Radius ~38px. Header height ~92px, muted dark surface, a green completion label above task title, X at top-right. Body left timeline x435–777 (**342px, one third**), right content x777–1463. Timeline shares header surface color; right summary matches darker app canvas. Timeline rows: small outline icons, ~14px labels, connected faint vertical rule, selected row filled black. Right Summary begins with ~42px horizontal padding. Outside shell is dimmed but still visible. This is stronger evidence for task details than a generic side sheet.

**06:50** `claire-tour-0410s.png` shows opening SOUL.md from Identity: nearly full workspace document viewer, persistent rail, filename upper-left, formatting toolbar centered, ellipsis and X right. Main text column centered with extensive surrounding whitespace. The film does not show a generic name/personality preference form.

**30:40** `claire-tour-1840s.png` shows computer workspace: rail stays, narrow live chat x102–631 (**529px**), browser x631–1874 (**1243px**). The chat's small avatar floats at top; composer remains at bottom. Browser top bar has task title + muted working/domain line, Stop, primary takeover pill, X. Below is a horizontal domain tab strip; live screen beneath. Browser preview also exists inside chat as a card with screenshot and “Open browser” pill. No separate large explanatory settings panel precedes the live browser.

## Creation and customization

Sources: **28:30** `claire-tour-1710s.png`, **28:45** `claire-tour-1725s.png`, **29:00** `claire-tour-1740s.png`; also `artifacts/muse-research/fidelity/claire-four-candidates.png` and `claire-creation-1710-1790.jpg`.

The user asks in chat for a teal dragon and a name change. The reply contains four **square** images arranged 2×2, compact to the left of the reading column. After choosing, selected image stays full contrast while other images dim. The avatar and name in the inspector update and status reads “Generating video.” Later work states animate the chosen avatar. All approved existing assets and the real generation pipeline must remain untouched.

No new-avatar modal, gallery drawer or settings profile form is directly shown in the inspected film. A compact creation dialog can be a useful application adaptation, but should not be described as an exact observed Muse screen. The pencil on the inspector avatar is observed; its complete click flow is not filmed. A public launch discussion reports it focusing the chat field, which agrees with the conversational flow, but is not enough to claim an exact animation or dialog.

## Mobile composition and sizing

Official full-phone frames at 01:02, 01:06, 01:08, 01:18, 01:56 and 02:16 share screen bounds x737–1182, y56–1020 = **445×964**. For an illustrative **390×845 viewport**, multiply source distances by 0.876. Native safe-area treatment is part of that viewport; the phone frame and blue background are not.

### Chat and message menu

**00:10** `official-tour-0010s.png` and **00:24** `official-tour-0024s.png` are zoomed. They show a white/light-gray canvas, blue right bubbles, very pale gray left bubbles, roughly 18px normalized body text and 22–24px bubble radius. Grouped assistant bubble/image corners are flattened subtly at the joining edge. Content itself is not enclosed in additional cards.

The floating avatar is about 42–48px in a normal 390px composition. It overlaps a white name capsule, with status expanding beneath when needed. Top-left menu circle is about 44px. Text behind the top area fades toward white. There is no solid horizontal header rule.

Composer is a white rounded pill with plus left and microphone/send right. Below it, a separate translucent white five-way pill contains Chat, Feed, Ideas, Goals, Library with **icons only**. Selected destination gets a pale-gray inner pill. At 01:18 normal full phone the tab pill is x758–1159, y930–999 = 401×69px, normalized **351×60px**, ~20px from each screen edge and ~18px from bottom. Composer and bottom bar are floating over content, not a full-width rectangular navigation footer.

**00:12** `official-tour-0012s.png` is the long-press menu. Background dims; selected bubble stays undimmed. Above it: rounded reaction strip. Below it: a white rounded menu aligned to bubble's left, three rows Reply, Copy, Share with left icons and separators. Approximate width 56% of phone screen and row height 48px after normalizing the zoomed frame. The current app has only a small quote icon beside messages. Implementing Reply, Copy and Share can preserve the existing quote behavior; do not invent a persisted reaction system merely to reproduce the reaction strip.

### Agent panel and approvals

**01:02** `official-tour-0062s.png`: full-screen white panel, X top-left, share top-right. Avatar ~84px raw = **74px normalized**, name ~23px normalized, status ~17px. Avatar starts ~70px below screen top. Four-icon tab pill begins ~242px from screen top, height **49px normalized**, 16px side gutters. Name/status group has generous breathing room. The list begins directly beneath tab control and scrolls independently. No primary navigation at bottom.

**01:06** `official-tour-0066s.png`: approval history plain rows, square pale-gray icon tiles, title, muted detail, pale timestamp. **01:08** `official-tour-0068s.png`: Needs review with overflow menu at right, service icon, question, explanatory copy, Details chevron, then vertically stacked full-width pills: colored primary allow, gray task-level allow, gray deny. History follows. No large bordered approval card.

### Feed, Ideas, Goals, Library

**01:18** `official-tour-0078s.png`: feed items use emoji/object illustration in a narrow left gutter; title and body in a right text column, images below, action row (heart, Discuss, information), thin horizontal separator. Top-right circular sliders control opens instructions. Feed layout is not a grid of dashboard cards.

**01:22** `official-tour-0082s.png`: Feed instructions edit appears as **dark floating sheet despite light feed**, with rounded text surface, title + muted guidance above a divider, large plain textarea area, then two independent equal width pill buttons Cancel/Save underneath. This is an observed special case; do not infer that all light-theme dialogs should be dark.

**01:34** `official-tour-0094s.png`: Ideas title, categorized rows with large colorful object/emoji at left, medium title and gray paragraph at right. Hairline separators start at the text column; category label spans the whole width. No outer card around each idea.

**01:56** `official-tour-0116s.png`: Goals list uses checkboxes/chevrons and a vertical ellipsis per row, muted detail beneath. Group labels have small colored icon/text; Create a goal row followed by plain category rows with icon and plus. **Independent observed goal prompt** `meta-muse-goals.webp`: small rounded popup with title, close, short explanatory paragraph, one full-width primary pill; it sends user into chat.

**02:16** `official-tour-0136s.png`: Library has top avatar, top-right ellipsis, a two-way Artifacts/Media segmented control, plain artifact rows with 44px normalized colorful square thumbnails, title/detail, vertical ellipsis. Bottom navigation remains. Desktop **21:50** `claire-tour-1310s.png` uses category sidebar (search; Artifacts: All artifacts/Documents/Web artifacts; Media: Images/Videos/Podcasts; System files bottom), main title and action group, sparse thumbnail grid. Desktop and mobile library layouts intentionally differ.

## Acceptance comparison

Capture equivalent states, not merely the same page names: light desktop compact chat; desktop with both side-chat list and inspector; settings General and Connectors; activity detail dialog; mobile chat with enough text to scroll behind header; mobile agent panel/approval; mobile and desktop library; creation choices; live browser workspace. Compare spacing, control scale, wrapping and navigation placement at matching viewport dimensions.

Do not claim pixel identity based on a successful build or broad visual resemblance. Exact font family, responsive breakpoint values, spring animations, mobile settings flow and keyboard focus implementation are not established by these screenshots. Do not replace working OpenMuse functionality with inert Meta-specific controls solely for appearance.
