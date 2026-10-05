# Embedded harness acceptance — 5 October 2026

Subsequent testing with an existing conversation exposed failures missed by the
fresh-conversation run below. See [renewed-work acceptance](../../docs/RENEWED-WORK-ACCEPTANCE.md)
for the corrections, failure reproductions and broader interaction coverage.

The active chat and model-backed task executors are OpenClaw's original
`runEmbeddedAgent`, compiled from the copied source at
`b56ae70a5e7e302dc2165c96b60214e84e19c7b1`. The source manifest verifies 10,664
unchanged upstream files. The build compiles 10,641 inputs and produces 5,573
outputs, including the original runtime worker entrypoints and database schemas.
See [the integration and provenance](README.md) for the host boundary.

The application no longer imposes its previous 10/16 model-turn limit,
automatic 96-step accumulated task limit, one-minute provider deadline,
five-minute inference deadline, or three-review forced partial delivery.
Explicit task budgets still apply. Upstream streaming recovery, retry limits,
context protection and cancellation remain active; the host admits six-hour
attempts. This does not promise unlimited provider availability or successful
answers to every request.

## Automated validation

The complete application suite passed: **1,384 tests, zero failures**. Server
and mobile type checks passed. Biome reported zero errors, with 278 existing
warnings and eight informational diagnostics. The copied source hash check and
native harness build passed.

Relevant acceptance coverage includes:

- [Native iteration](../../tests/openclaw-harness.test.ts): 25 actual tool calls
  across 26 model turns, exceeding the former per-turn cutoff.
- [Conversation and task execution](../../tests/openclaw-conversation-flow.test.ts):
  actual foreground admission, automatic title, alternative-source research,
  live plan progress, verified completion and publication.
- [Budget migration](../../tests/openclaw-budget.test.ts): 110 steps and more
  than six accumulated hours remain admissible; old automatic defaults are
  migrated while explicit revised budgets remain enforced.
- [Provider recovery](../../tests/openclaw-recovery.test.ts): native retries
  recover from a provider error and clear the durable interruption checkpoint.
- [Physical effect restart](../../tests/task-provider-restart.test.ts): restarting
  after a completed HTTP effect does not repeat that effect. This and the large
  history recovery cases were also rerun after the final receipt alias update.
- [Thread naming](../../tests/thread-titles.test.ts): authoritative first-message
  titles and legacy backfill preserve manually named conversations.

## Real provider acceptance

An isolated candidate service used the configured production model
`chatgpt/gpt-6-luna` and a read-only credential snapshot. It ran the exact user
question, “como está as eleições do brasil? como está a apuração?”, through
the application's real thread and foreground agent, then its durable task worker.
The test supplied neither a previous conversation nor a scripted model response.

The foreground admitted the original question as a task and created its thread
title. The worker searched the web and read G1 and O Globo, rather than returning
after one failed official URL. It finished in 150 seconds with a verified
response, a complete delivery review, no user clarification request and a posted
conversation publication. The 75 live plan observations included running steps
and completed steps while the task was still running; all three final steps
were completed. The test asserted the native OpenClaw runtime event as well.

Private run evidence is retained in the ignored workspace directory
`artifacts/openclaw-runtime/live-evidence/`; no credentials are committed here.
The cited sources and election figures are evidence of that particular test,
not a general claim about current election results.

## Production publication

The API image `openmuse-server:product-3512f6c` was published from production
base `7581bd3` plus this harness change. Unreleased personal-learning and
proactivity changes already present on the development branch were excluded.
The API and browser health checks passed, deployment maintenance ended, and
the existing pause state was preserved.

The web bundle and signed ARM64 APK were published under the same release:

- Web entry SHA-256:
  `dc663a57371549375ff891d6a331e4b2ff4b48396da0454c6bc89981937fce82`.
- APK SHA-256:
  `9fbac5fb7cd73ee60ac28c83dc6d38b858e98714aff93a344fe263333bb66acf`.

Both hashes were checked against public downloads. Authenticated browser checks
at widths 1,134 and 390 confirmed task status badges, individual removal,
the clear-finished confirmation and a historical task's completed plan steps.
The backfilled conversation title was visible in the conversation menu, and
the deletion confirmation was usable on both layouts. Browser checks reported
no page errors or unintended writes. Profile, model and avatar digests
matched before and after deployment.

The APK was built and its signing identity checked; this release was not
installed on a physical Android device during acceptance.

## Subsequent reliability incident

The 5 October delivery and long-conversation fixes, including the rejected
winner-only infographic and the stricter image acceptance gate, are documented
in [the harness reliability report](../../../docs/HARNESS-RELIABILITY-20261005.md).
