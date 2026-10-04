# Harness implementation plan

Spec: `docs/superpowers/specs/2026-10-04-openclaw-harness.md`. User authorization: full harness review, maximum practical OpenClaw reuse, and repair of the demonstrated deliveries.

- [x] Preserve and inspect the failed PDF, current model configuration and prior infographic evidence.
- [x] Compare all harness layers with pinned OpenClaw; record specific source paths, adaptations and limitations.
- [x] Fix `engine/context-budget.ts` schema accounting and `engine/model.ts` continuation state projection. Demonstrate red/green admission and resumed-task tests.
- [x] Add `runtime-tools.ts`, actual tool inventory, and OpenClaw promise-ownership policy to chat and worker. Verify owner-scoped metadata and secret exclusion.
- [x] Vendor portable OpenClaw no-progress detection and result-limit policy with MIT notices. Integrate guards and output paging in `engine/tanstack-agent.ts`; preserve canonical receipts and recovery tools.
- [x] Add generic server document generation through existing media/file effect and artifact abstractions. Test Unicode, pagination, verification, replay, permissions and chat delegation.
- [x] Review integrated changes and run focused plus complete checks. 1130/1130 tests passed; final server/mobile TypeScript and Biome passed (230 existing warnings, four infos). Separate executor/desktop lifecycle contracts: 60/60.
- [ ] Exercise real connected-provider chat deliveries and repair any remaining failures exposed by them.
- [ ] Publish a clean source revision, resume the preserved production PDF, verify the originating attachment and record evidence.
- [ ] Update deployment acceptance and report concrete results and remaining configuration requirements.

Work ownership: context/provider reviewer owns projection and resume fixes; runtime reviewer owns self-description/policy wiring and runtime audit; document reviewer owns server creation and artifact validation; root owns loop/output integration, overall audit, integration testing and publication. Shared files are coordinated directly.
