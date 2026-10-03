# OkamiBot product rework implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Execute the authorized work in isolated worktrees; root reviews each delivery and takes over after two unsuccessful deliveries.

**Goal:** Deliver an accessible, usable personal agent after the user's first real acceptance exposed broken chat replay, desktop viewing, navigation and missing discoverable customization.

**Architecture:** Keep the existing API, durable workers and native executor. Add frontend modules for a desktop shell, locale catalog and animated avatar editor; preserve the mobile client and server-side ownership. Publish through a public HTTPS gateway with authenticated owner access; Tailscale remains infrastructure transport only.

**Tech stack:** Expo/React Native web, TypeScript, existing Hono/PGlite API and Linux executor. Avatar rendering must be real animated 3D with local assets, no paid avatar SaaS.

**Spec:** User acceptance and screenshots in this session, 2026-10-03: public access without Tailscale on the wife's device; EN default plus selectable PT-BR; stable Take control; visible name/personality/avatar settings; five animated 3D avatars and custom avatar creation; desktop-specific layout; full flow verification.

## Global constraints

- Preserve MIT notices, demo mode, durable tasks, credentials and existing accounts.
- Do not steal a human desktop session or cancel tasks while deploying fixes.
- No license fees or additional runtime machine.
- Never put access keys or provider tokens in bundles, URLs, logs or chat.
- Verify actual browser flows on the deployed build, not only fixtures or HTTP health.
- Public domain approved and published: https://app.okamibot.cloud, via Cloudflare Tunnel and authenticated application sessions.

## Review focus

- Failed provider run followed by a new message/reconnect must remain a valid AG-UI stream.
- Desktop frames, ownership and controls must survive polling, remount and human takeover.
- Refresh, logout/revocation and network loss must not strand first-time sign-in.
- Locale/profile changes must persist, preserve drafts/tasks and remain consistent after reload.
- Desktop and mobile layouts must expose controls at realistic viewport sizes; 3D assets must release GPU resources and respect reduced motion.

## Tasks

- [x] **Chat replay:** `apps/server/src/threads.ts`, `tests/local-threads.test.ts`. Preserve terminal transitions when projecting historical failures, without rewriting the journal. Exercise real AG-UI failed-to-success replay and current-run errors.
- [x] **Desktop stream:** `apps/mobile/src/desktop.tsx` and its server/executor adapters if evidence warrants. Reproduce missing frames and flashing controls; fix the lifecycle and test real viewing, take control, repeated input, handback and reconnect without disturbing user ownership.
- [x] **Desktop shell:** `apps/mobile/App.tsx` plus a dedicated shell module. Persistent navigation, readable wide chat, obvious settings, usable computer panel; preserve Android navigation.
- [x] **Localization:** Add a typed EN/PT-BR catalog/provider and persistent selection. Translate sign-in, navigation, chat, activity, connectors, desktop controls, settings, validation and error presentation. Separate app locale from an explicit agent response-language preference.
- [x] **Profile/avatar:** Expose name, nickname, speaking style, personality and response language in a direct settings screen. Add five distinct locally rendered animated 3D avatars and a custom avatar editor with saved appearance and preview; preserve existing profile revisions and chat personalization.
- [x] **Public access:** Use the user's selected domain with HTTPS and strong app authentication; optional Google sign-in requires explicit client configuration and an owner allowlist. Do not expose executor, vault, database or internal admin endpoints through the public gateway. Verify from outside Tailscale.
- [x] **Acceptance:** Test login, repeat chat, failure recovery, new/reopened threads, four background tasks, editing preferences, both locales, all avatars/custom creation, files and native viewing/control. Run applicable existing suites, build web/Android as changed, record real evidence and limitations, then remove integrated worktrees.

The user has explicitly authorized implementation and supplied the parallel execution method; no extra plan approval is required.

## Final delivery evidence

Public web and signed Android source: `40390aa`. Final server: `d6fa127`.
Browser and Android acceptance, current validation results, deployment receipts,
and remaining account/physical-device checks are recorded in
[the recovery report](2026-10-03-product-rework-resume.md). Integrated worktrees
were removed after preserving recovered changes. Physical phone and the running
24-hour soak remain explicit operational acceptance limits, not implemented-feature claims.
