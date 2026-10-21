# codex 0.163.0 without `codex-code-mode-host` (#2357)

These were captured on 2026-10-21 from the official codex 0.163.0 package with its code-mode host deleted.

**Package.** The package is the npm platform tarball `@openai/codex@0.163.0-linux-x64`:
- fetched with `check-cli-versions.sh --download codex 0.163.0 <scratch>`;
- tarball sha256 `30efc97738b975940d78b59a9bea115fa34040b732807d54ec35ae6b7528de94`;
- `bin/codex` sha256 `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215`;
- `bin/codex-code-mode-host` sha256 `8724d73ec190536233ab4628d24a071bfbcf27e5124f08fe35129f26fe48b916`.

Its layout under `package/vendor/x86_64-unknown-linux-musl/` is:
- `codex-package.json` (`layoutVersion 1`, `entrypoint bin/codex`);
- `bin/codex` and `bin/codex-code-mode-host`;
- `codex-path/rg`;
- `codex-resources/bwrap`.

The 0.162.0 package has the same layout, including `bin/codex-code-mode-host`. For the repro, `bin/codex-code-mode-host` was deleted from a hard-linked scratch copy (`missing163/`).

**Run.** `scripts/manual/codex-version-audit/companion-missing.sh <package-dir> <label>` drove it:
- AgEnD's production `writeConfig` and `buildCommand` (`gen-cmd.ts`), with `[features] code_mode`, `code_mode_host` and `code_mode_only` in the shared config;
- a private tmux server inside `unshare -rn` (loopback only);
- scratch `AGEND_HOME` and `CODEX_HOME` under `$HOME`;
- the rig's mock Responses API, in mode `toolexec`: one call of the code-mode `exec` tool, then a text reply.

There was no account and no network. The host's `~/.codex` was never used.

**Files:**
- `tui-after-tool-turn.pane.txt`: the pane after the turn. The tool call's failure does not appear; the only sign is the footer `⚠ 4 warnings · f2 to view`.
- `tui-after-tool-turn-full-package.pane.txt`: the same turn on the complete package (`⚠ 3 warnings`).
- `tui-warning-f2.pane.txt`: the F2 warnings view, warning 1 of 4: `Code Mode is unavailable because failed to spawn code-mode host …: host executable was not found.`
- `rollout-session-meta.jsonl`: the rollout's `session_meta`. The cwd is replaced by `__CWD__` and `base_instructions` is dropped.
- `rollout-tool-output.jsonl`: the rollout's `custom_tool_call` and its `custom_tool_call_output`, `failed to spawn code-mode host <root>/bin/codex-code-mode-host: No such file or directory (os error 2)`. This is the text the model got back, verbatim.
- `exec-stderr.txt`: the same failure under `codex exec` (`scripts/manual/codex-version-audit` mock, offline). It contains the startup warning and the tool router's error line.

**What changes the outcome.**
- With default features, a missing host changes nothing.
- With `code_mode` alone, codex drops the `exec` tool and the direct tools still work.
- With `code_mode_only`, `exec` is the only tool path, so every tool call fails.
