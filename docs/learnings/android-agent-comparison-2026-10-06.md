# Android agent diagnostic comparison

Date: 2026-10-06
Status: 16 scored trials complete; local device service installed. Guest and host UI acceptance recorded separately in the Raycast extension.
Related: [local setup](../LOCAL-SETUP.md), [all sanitized outcomes and pins](android-agent-comparison-2026-10-06.json)

Use hosted Jev as the mobile-jev/Raycast default. Use a general agent with raw ADB for tasks that need more planning. Keep local Rizzo available as an explicit option. The raw ADB agent completed 4/4 scenarios, mobile-jev with hosted Jev 2/4, mobile-jev with Rizzo 1/4, and jev-sim with hosted Jev 1/4. This small diagnostic is not a reliability estimate.

## Scope and fairness

The operator reduced the original 84 trials to an 80/20 diagnostic. Four configurations each ran dark theme, screen timeout, calculator, and disposable Chrome form once, sequentially, with rotating configuration order. TEV-1 and the remaining local jev-sim combinations were excluded from live trials. Two identical saved decision packets compared hosted Jev, Rizzo and TEV-1 separately. Preflight and tuning folders were excluded from scores. Adapters and prompts were frozen before scored trials; the text receipt repair below occurred afterward.

Each trial used a new process and empty task history. The ADB agent used gpt-6.1-sol, an ephemeral Codex home, isolated working directory and HOME, no skills, project instructions, personal memory, prior transcript or benchmark results, and only exec_command/write_stdin. Its effective instructions restricted actions to raw ADB UI reads and inputs, banned settings writes, network and other automation, and capped actions at 30 and time at 180 seconds. Authentication was runtime-only and excluded from Git. Local runtime warmth and model weights were not reset.

Baselines were read back before each trial: dark theme off, timeout 30,000 ms, correct foreground app, cleared calculator showing 0, and empty synthetic form/fixture state. Dynamic Chrome accessibility fingerprints differed across form resets; relevant field/fixture values were verified, rather than claiming byte-identical browser trees. Scoring used Android settings, calculator result nodes and fixture receipts independently of model claims. The same goal text was used across harnesses; current candidate policies were preserved.

## All live results

| Scenario   | Configuration | Verified | Logged actions | Total s | Declared outcome |
| ---------- | ------------- | -------: | -------------: | ------: | ---------------- |
| dark-theme | mobile-jev    |      yes |              1 |    6.01 | done             |
| dark-theme | mobile-rizzo  |      yes |              1 |   12.76 | done             |
| dark-theme | sim-jev       |      yes |              2 |    4.78 | done             |
| dark-theme | adb-agent     |      yes |              1 |   22.70 | completed claim  |
| timeout    | mobile-rizzo  |       no |              0 |    7.15 | blocked          |
| timeout    | sim-jev       |       no |              1 |    5.30 | error            |
| timeout    | adb-agent     |      yes |              3 |   43.95 | completed claim  |
| timeout    | mobile-jev    |      yes |              3 |   15.12 | done             |
| calculator | sim-jev       |       no |             30 |   30.52 | executed         |
| calculator | adb-agent     |      yes |              8 |   25.84 | completed claim  |
| calculator | mobile-jev    |       no |             30 |  107.71 | step_limit       |
| calculator | mobile-rizzo  |       no |              2 |   26.17 | stuck            |
| form       | adb-agent     |      yes |             17 |   90.60 | completed claim  |
| form       | mobile-jev    |       no |              4 |   20.49 | error            |
| form       | mobile-rizzo  |       no |              1 |  121.14 | blocked          |
| form       | sim-jev       |       no |             30 |   41.74 | executed         |

## Limits and failures

mobile-jev/hosted Jev repeated calculator digit 1 to its action cap. Rizzo left 0+ and reported stuck; its timeout run blocked without an action, and its form run blocked after one. jev-sim hit a semantic stale-alias error on timeout; it exhausted its calculator/form action caps. jev-sim does not expose text entry in its candidate policy, so the form is a visible capability gap rather than a claim that another model would repair it. Its dark-theme run executed two actions before declaring completion. The mobile-jev form attempted text entry in the focused field, then stopped on Portal response parsing. The failed mobile-jev form logged four completed actions and one additional text mutation with an uncertain receipt; its action count is a lower bound. The raw ADB 30-action cap was supplied in its instructions and audited afterward; the 180-second cap was enforced by the runner. No scored trial was rescued or silently replaced. All failures, declarations and grader evidence remain in the JSON report.

Android 16 content insert discards the provider return value. After scores were frozen, the adapter was repaired to verify replacement/clearing through exact field readback, without replay. Real service replacement of synthetic Unicode text and clearing both returned HTTP 200 with verified exact-field-readback. Other transport receipts report verified=false. This repair does not turn the scored form failure into a pass.

## Timing and saved decisions

| Scenario/configuration  | Observation ms | Inference ms | Execution ms |
| ----------------------- | -------------: | -----------: | -----------: |
| dark-theme/mobile-jev   |           2341 |          369 |         1274 |
| dark-theme/mobile-rizzo |           2341 |         7260 |         1205 |
| dark-theme/sim-jev      |           1373 |          929 |         1383 |
| timeout/mobile-rizzo    |           1134 |         4713 |            0 |
| timeout/sim-jev         |           1210 |          735 |         1415 |
| timeout/mobile-jev      |           5690 |          838 |         4300 |
| calculator/sim-jev      |           8889 |         5648 |        15699 |
| calculator/mobile-jev   |          36670 |         4815 |        40888 |
| calculator/mobile-rizzo |           4721 |        16228 |         2409 |
| form/mobile-rizzo       |           2369 |       115462 |         1285 |
| form/sim-jev            |          12210 |         7100 |        22081 |

ADB inference and observation/execution phase timings were not instrumented separately; only total wall time and input action counts are reported. The failed mobile-jev form has no final aggregate. These values are missing, not zero.

Saved packet replay used identical body/context/question packets with only the model ID changed. It issued no device actions. First packet selected TAP/Dark with Jev and Rizzo; TEV-1 selected SCROLL_DOWN. Second packet selected SCROLL_DOWN with Jev and TEV-1; Rizzo selected BLOCKED. This is disagreement/latency evidence, not a graded model accuracy dataset.

- jev: saved packet request times 205 ms, 143 ms; median 174 ms.
- rizzo: saved packet request times 3679 ms, 4123 ms; median 3901 ms.
- tev1: saved packet request times 1228 ms, 810 ms; median 1019 ms.

These were already-running runtime request latencies; no matched cold-start comparison was performed. Rizzo health reported an earlier load time of 11.337 s; it is not a measured cold-start trial. Hosted cold-load time is unavailable; TEV-1 cold-load time was not isolated. Fresh context means no supplied prior memory, not cold weights. Local policies split more than 24 candidates into validated rounds; eliminated candidates receive zero mass and the combined distribution is not calibrated globally.

## Pins, delivery and restoration

Pinned Jev 1.13.0; gpt-6.1-sol alias (immutable server revision unavailable); Rizzo Q8 GGUF dbec3c89… and managed llama.cpp b11081/161755f29e…; TEV-1 digest 07be32e6…; sim-use 0.14.0; Portal 0.7.25 APK 6dc9e832…; Fossify Calculator 1.4.0 APK 7c5443c2…. Full hashes, prompt/adapter hashes, source revisions and runtime metadata are in the JSON report. Source checkouts contained authorized changes, so revision plus frozen file hashes identify the scored implementation.

Portal Cloud Connection remains disconnected, with no Mobilerun account/key/subscription. Samsung HoneyBoard is the active IME. Preflight recorded original dark theme on and timeout 600,000 ms; these settings were restored after scoring. The task-owned fixture reverse mapping and temporary fixture process were removed. Calculator remains installed as a usable offline app. No personal screen trace, credential, private transport or authentication state is in this report.

The service is active through the provisioning LaunchAgent on loopback port 3041. It preserves goal execution when the Raycast view closes, but service-process restart loses in-memory run history. Live checks verified PNG screenshot, 121-app inventory, launch/navigation, exact text replacement/clearing, stale-observation rejection, wrong-device rejection, lock contention and cancellation. Full mobile-jev pnpm check passed (100 tests), jev-sim offline suite passed (44 tests), extension check passed (14 tests). Provisioning ShellCheck and all 46 host tests passed after PR 181 merged. The extension was imported through supported host tooling. Fresh screenshots in the owned macOS guest verified the status view and goal form against synthetic service data; physical-host views and Raycast AI Agent activation were not verified. The guest was stopped and Rizzo restored. [Raycast acceptance details](/Users/dallascrilley/Code/raycast-projects/raycast-extension-agent-device-android/docs/android-agent.md) distinguish those UI checks from the real tablet service results.

A final audit exposed a stale-lock recovery race after cancellation. Both harnesses now share an atomic acquisition guard and publish complete owner records by rename. Six-process Node/Python race tests verified a single winner. Cancellation leaves a dead-owner lock that the next acquisition safely recovers; a crash during the short acquisition guard fails closed until the verified dead guard is removed. These fixes occurred after scoring. jev-sim provider checks were tightened after scoring to require exact model identity, Rizzo fingerprint/artifact hash and a portable source-pinned TEV-1 digest.
