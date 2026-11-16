# Personal agent phase 1 implementation (M-3224)

Implements the approved [product plan](https://github.com/songsid/AgEnD/blob/docs/hub-ux-review-m2902/docs/design/hub-personal-agent.md) and [step 0](https://github.com/songsid/AgEnD/blob/fd4cc047d34bbdaf931f8188d1398175e21c5e87/docs/design/hub-personal-agent-step0.md). Windows only; real use requires a trusted Hub certificate. Rigs and browser automation are isolated/headless, with no user desktop or live Fleet.

## Layers

1. `runtime-personal-profile.ts` supplies a distinct, local-only profile plan. `runtime-personal-answer.ts` reads only successful terminal answers. No ordinary Fleet/Runtime launch behavior changes. This layer is unmounted: no route, capability, installer or Ready state is offered by it.
2. Compose runner-owned staging and Windows platform checks, then the Hub's Runtime host, company-owner pairing and turn dispatch. Use a real Runtime coordinator rather than a dummy Fleet. Bind each turn to its original computer/job. Coordinator RPC acknowledgment is not completion; wait for a successful terminal task and the bounded final answer.
3. Add owner setup and EN/zh-TW personal-agent labels/states, direct and explicit room-mention adapters and headless integration evidence. Daily answer caps, personal-agent `@all`, admin version-list integration and published-artifact self-updates remain phase 2/3.

## Profile contract

The Hub cannot submit an argv, environment, authentication path or alternate launch configuration. The Windows runner derives those locally. One question gets one process, one shared folder, no approval and a 300-second deadline. Profiles use a fresh auth-only home and an empty private repository as the working directory. The selected content folder is separately granted read access; it must not be the home/drive/system directory, a private profile directory or a canonicalized alias of one. Runtime code must observe the realpath on Windows before invoking the pure plan builder.

Codex uses named filesystem read roots and disabled command network access. Do not append `--sandbox`: [permission profiles](https://learn.chatgpt.com/docs/permissions) are overridden by that older option. Disable personal hooks/apps/plugins, project instructions and every discovered skill, including provider-bundled skills. As step 0 showed, the discovery switch alone is insufficient. The composing worker must stage this profile and validate the resulting prompt before execution; the builder alone is not an isolation proof.

Claude uses safe/restricted mode, no settings sources, empty strict MCP configuration, only Read/Glob/Grep, plan/no prompts, no session persistence and no Chrome. Its file-tool boundary is weaker than an OS sandbox; this accepted limitation remains visible in the product plan.

No authentication is read or copied by these pure modules. Windows authentication storage and enforcement were not validated in step 0. The composing layer must validate them before advertising support, must use the person's own CLI login and must not fall back to another account or a broader profile.

## Answer contract

The ordinary Runtime preview intentionally includes command text/output and provisional assistant fragments. Personal answers never use that preview field. Codex contributes only the last completed agent message followed by successful turn completion. Claude contributes only successful `result.result`. Both also require exit 0 and nonempty bounded output. Malformed, repeated, incomplete, cancelled, failed or oversized results return a reason code without raw output. UTF-8 fragments are joined safely. No result is disclosed while the process is still running.

## First-layer verification

Focused profile/answer tests use only synthetic protocol and Windows-path fixtures. They cover mixed tool output, provisional text, exit/turn failures, bounds, split UTF-8, broad/private folders and profile arguments. Selected reversals pin the process-success guard, Claude terminal field and system-folder exclusions. This is not Windows sandbox/authentication or live-provider evidence.

Skill update: N/A for this unmounted layer; it adds no user-visible command, setting, capability or flow. The later mounted UI/host layer updates the Hub skill.

Rollback of this unmounted layer is a code revert; no stored data or migration.

## Worker transport layer

`personal-agent-v1` is offered only by a Runtime constructed with a local personal-folder binding. An ordinary Runtime refuses a personal run; a personal Runtime refuses ordinary runs, a different folder, conversation resume, MCP, alternate credentials, remote account operations, panes and managed updates. No production CLI entry constructs this binding yet. The Hub cannot enable it by sending a frame.

The Windows worker stages authentication fields only into a fresh private NTFS directory and isolates HOME, USERPROFILE, AppData and XDG paths. It never changes the source account or logs it out. The Codex preflight checks effective disabled feature flags and renders the prompt locally to refuse inherited catalogs or AGENTS instructions. The final execution also uses strict configuration parsing. Browser, image, computer and shell-snapshot features are disabled separately from the command sandbox. Raw stdout/stderr are never the personal Runtime's preview or answer. Even a successful worker frame remains private until physical child exit.

The hosted Windows proof uses fixed real CLI binaries and synthetic authentication. It checks shared-folder reading, outside/junction reads, writes and command network denial, with positive unsandboxed controls. It captures Claude help and checks its safety argument parser. This proof never calls a model or opens a desktop window. It is a composing-layer gate; unit fixtures alone do not claim Windows enforcement.

## Phase 1 routing decision

Per the product decision at `6375e660a`, personal agents answer people only. A verified M-3118 person-via-agent post counts as that person; an autonomous agent post does not. Personal agents are excluded from `@all`, and mentions in personal answers never launch other agents. A refused autonomous mention leaves its post visible, queues nothing and contributes no unanswered question to the overview. The posting agent receives the localized personal-agent/people-only refusal. Daily limits and agent-to-agent eligibility remain phase 2.
