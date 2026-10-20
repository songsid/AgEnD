# Muse Code 1.4.10-R6427.1 → 1.4.11-R6667.1 audit

Audit date: 2026-10-20. Version gate: ffb8104e. Isolation rule: bd0c88aa.
The upstream precheck reported MAJOR, hard=2, six changed literal counts and nine other prompt-like strings.
No upstream changelog was available in the supplied release artifacts.

Conclusion: neither hard finding is a new complete UI message. No production detector change is needed for the
exercised screens. The PR adds real new/old fixtures and production-backend assertions. It does not claim that every
enterprise approval profile or genuine subscription exhaustion was exercised.

## Permission finding

`Yes, don't ask again this session` occurs exactly once in each binary, at old byte5927050 / new byte5170295.
It sits in the generic protected-action approval option table beside `allow_once`, `allow_session`,
`allow_local_prefix`, and shell-command/filesystem/network matchers. The precheck changed because adjacent Rust
read-only strings moved (`_abort` and other choice identifiers); it did not discover a newly introduced sentence.

Actual behavior, using a local Meta Responses mock:

- With AgEnD's `--disable-approval --trust-workspace`, a bash call requesting escalation is denied with
  `unsandboxed execution requires human approval, but approval prompts are disabled`. Neither release opens a prompt.
- With approval enabled, the escalated call presents the existing two-option `Would you like to run the following
  command?` dialog. Untrusted mode presents the existing three-option staged dialog. Both use the `⟩` cursor already
  supported since1.4.7; both versions produce the same detector verdicts.
- AgEnD recognizes these as human permission interactions: `keys=[]`, `holdOnly`, `blocksDelivery`, `inputBlocked`.
  It neither approves nor admits a delivery's Enter. They cannot prove idle, even though a working timer or old ready
  header remains visible. Escape returns to an idle composer.

The session-wide option itself was not reached offline, including extra read/write-file probes. Static evidence places
it in generic approval policy, but cannot prove every route that can select it. Thus this audit makes no new claim
that the exact session-wide shape is recognized. It is an existing coverage limit, explicitly preserved from1.4.7.
The production-bypass negative control and the approval-enabled positive controls are separate evidence.

## Rate-limit / lock finding and quota

`rate limited retry error - .lock` is not an exact message in either artifact. At old byte4602406, the provider label
`rate limited` is adjacent to `connection failed`, retry/error fragments, then unrelated text. At new byte6872420,
`connection failed` moved, putting the same label next to ` retry  error  - .lock` and help text. `.lock` adjacency does
not establish a lock error, and adding a detector for that invented sentence would be wrong.

Both binaries print the same actual HTTP429 line:

```
└ Meta Model API rate limited (HTTP 429) · retrying in 1s · attempt 2/10
```

The production `/rate.?limit|too many requests|\b429\b/i` recognizes the retry row alone as `rate_limit`, action
`failover`; no user prompt words are needed. A separate injected HTTP402 response with a usage-limit error prints:

```
◆ model failed: API error 402: Usage limit reached (usage_limit_reached)
```

The existing `/quota|usage limit|out of credits/i` recognizes this row as `quota`, action `notify`, on both releases.
This proves detection of that rendered exhaustion shape, not every provider status/code or live account exhaustion.
The two capitalizations of the usage-limit label are in both binaries. There is no evidence here of a new Muse quota
regression, nor of `.lock` being part of a rate-limit notification.

## Remaining precheck changes

| Signal | Finding |
|---|---|
| `to select` 25→27 | selection chrome still appears in the captured login and local-work menus; existing structural predicates hold |
| `ENOENT` 11→10 | internal error-label occurrence count, not a removed AgEnD interaction sentence |
| `Muse Code` 480→434 | title remains `Muse Code 1.4.11`; ready alone is deliberately insufficient for idle |
| `rate_limit` 26→28 | identifiers elsewhere; actual provider retry and quota rows verified above |
| saved-login sentence 3→2; `muse login`34→33 | literals remain; logged-out startup still blocks with no auto-dismiss; existing auth-pattern tests remain controls |
| `Usage limit reached` new neighborhood | old/new same label; adjacent plugin/MCP/workflow identifiers moved |
| two workflow kernel continuation strings | pre-existing model-visible workflow instructions expanded with Agent.start refs and dynamic Phase.create; not interactive prompts |
| two `continue this session, run …` strings | existing resume sentence; workflow recovery and clipboard/session-log neighbors moved |
| `press Esc to deny.No approval choice selected.` | existing generic approval selection text, followed by relocated draft/navigation identifiers |
| `resume the Workflow … agent type …` | existing unavailable/invalid agent-definition remediation |
| `resume the intended session and retry` | extra occurrence adds side-chat source-session validation; not a new approval widget |
| `resume the parent session or make a new fork …` | existing fork saved-view remediation; following storage labels moved |

All nine flagged core phrases exist in both artifacts. Some workflow/side-chat explanatory strings genuinely expanded;
none is evidence that Muse now waits for an extra confirmation under AgEnD's tested flags.

## Other integration surfaces

Fresh echo/Meta ready screens, active work, Escape/draft restoration, exact-ID resume, missing-session output,
workspace trust, logged-out login, background task panels and the local-work quit menu were captured. The normal
root-flags-before-resume command still restores the conversation. Route-facts remain readable within the first64KiB
of the real log, despite a framed permission transaction at its start. Existing input-draft/idle/dialog/session parsers
accept these fixtures. Local-work quit remains held and is recognized by the stop path.

The background-task leg adds `--disable-sandbox` only because the container cannot provide Muse's OS sandbox. The
production escalation-denial and permission legs retain AgEnD's actual sandbox flags. No sandbox-success claim is
inferred from the background leg.

Fixture provenance, hashes, exact commands, mock protocol and normalization are in
[fixture SOURCES](../../tests/fixtures/muse-1.4.11/SOURCES.md). Tests use the production `MuseBackend`; there is no
fleet start/update/restart, host tmux or real provider call. The host Muse installation is unchanged. Mark audited only
after the fixture PR passes parity review and is merged; rollback is simply reverting the audit fixtures/tests/docs.
