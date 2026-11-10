# Alpha parity acceptance

M-2801 · alpha base5d7a91697. The two changed production modules, mixed-record fixtures and lifecycle/UI tests are byte-identical to main#3545. Existing alpha native/paired exclusion is unchanged; this adds no native support. Main's unredacted raw-stream replay and12guard reversals carry on identical parser bytes.

This directory is a fresh real alpha Fleet web/admin sign-in + Chrome + bounded-file-reader run, not main screenshots relabelled. Two zh-TW cells (desktop light, phone dark) cover the same baselineUnknown/running/completed/retired/missingUnknown/retired/reopen stories. Four SKEW cases also ran. [Receipt](browser-receipt.json) records alpha's own panel hash and exact shared production hashes; the main images/receipt in the parent directory remain explicitly main evidence. [Cleanup](cleanup.json): loopback-only unprivileged namespace,32tracked owned processes,zero survivors,scratch removed.

| Story | Desktop zh-TW | Phone zh-TW |
|---|---|---|
| Before | [before](desk-light-zh-TW-before-unknown.png) | [before](phone-dark-zh-TW-before-unknown.png) |
| Running after parent yield | [running](desk-light-zh-TW-running.png) | [running](phone-dark-zh-TW-running.png) |
| Completion proven | [completed](desk-light-zh-TW-completed.png) | [completed](phone-dark-zh-TW-completed.png) |
| Completion retired | [clear](desk-light-zh-TW-completed-retired.png) | [clear](phone-dark-zh-TW-completed-retired.png) |
| Unknown retired | [clear](desk-light-zh-TW-unknown-retired.png) | [clear](phone-dark-zh-TW-unknown-retired.png) |
| Reopen stays clear | [reopened](desk-light-zh-TW-reopened.png) | [reopened](phone-dark-zh-TW-reopened.png) |

190/190 focused alpha tests (9suites) include all subagent/source/auth/UI cases, web preview and alpha's CLI registry-list guard. No new CLI/model/account/native/live fleet operation. Live phase and fixed clock are derived fixtures as disclosed in the parent README. No positive HTTP response stub, no extra shared-module import or control. Main-first merge prerequisite remains.
