# Personal agent step 0 — M-3182

**Go for phase 1 engineering with an isolated launch profile and final-answer extraction. The existing Runtime invocation is not ready to ship as a personal agent unchanged.** Both real one-shot calls succeeded on Linux on 2026-11-15; Windows enforcement remains a phase 1 acceptance item.

## What ran

Two short real jobs on our own authenticated accounts, no mock model API, live pane, Fleet or container. Authentication alone was copied into private scratch `CODEX_HOME` / `CLAUDE_CONFIG_DIR`; no personal configuration was copied. The original auth files' size/mtime stayed unchanged, and the scratch credential copies were removed after the trial without logging the accounts out.

| CLI | Result | Time | Boundary evidence |
|---|---|---:|---|
| Codex 0.167.0, gpt-6.1-sol | Exit 0, clean final JSON | 8.784 s | Model's outside read failed; separate same-profile sandbox probe read the chosen file, denied a write with EROFS and denied the existing outside sentinel with ENOENT |
| Claude Code 2.1.325, claude-sonnet-5-5 | Successful result, clean final JSON | 5.342 s | Init exposes exactly Glob/Grep/Read, zero MCP servers; actual outside Read has a recorded permission denial; no Write/Edit/Bash tool or approval handler |

Both returned the fixture's `LARCH-42` and `Tuesday at 10:00`. The host confirmed no write file, no outside sentinel in output and no inherited-instruction canary. Codex's JSON stream does not show a write-command event, so its final claim about a refused write is **not** the evidence for that boundary; the direct sandbox probe is.

The runner kills its owned process group at 300 seconds. A local sleeping-child control used the same timeout path shortened to 150 ms and was killed in 151 ms. Neither real job approached the limit; there was no five-minute model burn.

## Launch requirements demonstrated

Codex used a controlled scratch profile, `approval_policy="never"`, a read-only filesystem profile and network disabled for commands. Only the chosen user-content folder plus necessary system/CLI runtime paths were readable. `--sandbox read-only` alone is insufficient evidence of one-folder reads. The [documented permission profiles](https://learn.chatgpt.com/docs/permissions) provide explicit filesystem read roots.

Apps, plugins, hooks and web search were disabled. Initial local prompt rendering still discovered repository skills despite the discovery switch. Before the real call, an inner scratch repository and explicit `skills.config` disables removed every discovered skill; the final rendered prompt has no skills block or instruction canary. Do not assume a new home or an experimental discovery flag alone suppresses skills. Codex warned that `skip_host_skill_discovery` is experimental and that the explicit `standard` tier was omitted for this model; no fast tier was requested.

Claude used `--safe-mode --restricted --setting-sources '' --permission-prompts none --permission-mode plan --tools Read,Glob,Grep --strict-mcp-config --mcp-config <empty.json> --no-session-persistence --no-chrome`. Safe mode suppresses personal customizations, **not every bundled feature**: init still lists 17 built-in skills and four bundled plugins. No personal skill/plugin is listed, no Skill or connector tool is exposed, and no subagent ran. Claude's boundary here is its file-tool policy, not an OS sandbox.

## What phase 1 must add

At alpha source `27b57d5c`, `buildNativeInvocation` still uses normal Runtime launch configuration. Its read-only flags do not include this trial's complete personal-setup isolation. Add a dedicated personal-agent launch profile; do not alter ordinary Fleet agents' setup. On Windows, validate the selected folder and repeat the boundary checks using that platform's sandbox and authentication storage before enabling the feature.

Use protocol completion to extract the answer: Codex's final agent message / `--output-last-message`, and Claude's successful `result.result`. Require successful process/turn completion and nonempty output. Never flatten stdout into a room answer: Runtime's `codexEventText` / provider event parser intentionally expose command text and output for the existing execution UI.

Keep one job at a time, the hard deadline, cancellation, clear sign-in/permission/timeout failures and no broader-access fallback. Pairing, Hub orchestration, reconnect/delivery proof, daily limits and Windows installation were not exercised by this step.

## Evidence and rollback

[Evidence packet](../evidence/personal-agent-step0-m3182/summary.json) contains selected protocol facts, final answers, the exact sandbox probe and a profile template. [Manifest](../evidence/personal-agent-step0-m3182/manifest.json) binds eight private raw inputs; credentials and account/session metadata are excluded. Private raw captures and the small runner remain in the author's `.artifacts/personal-agent-step0-m3182/`.

No product code, login, personal settings or installed CLI was changed. Rollback is removing this documentation branch; the disposable credential copies are already gone. This note implements the step 0 evaluation of [the accepted personal-agent plan](https://github.com/songsid/AgEnD/blob/8a87547c3/docs/design/hub-personal-agent.md), not a phase 1 release approval.
