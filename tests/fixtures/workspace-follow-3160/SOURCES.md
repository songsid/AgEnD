# Real CLI records for #3160

Captured 2026-11-06 with `scripts/manual/workspace-follow/capture.mjs`, against its
ephemeral loopback Messages/Responses APIs. Each CLI ran in its own scratch HOME,
config and working directory, with synthetic model credentials and telemetry/update
checks disabled. No fleet or tmux was started or changed; no account credential was
read, copied or linked.

- Claude Code **2.1.319**: real Read (lines 2–4), Bash grep, Edit, secret-file Read
  and an outside-folder Read. Grep is not declared in this version, so the actual
  search uses Bash and is explicitly approximate in Follow.
- Codex CLI **0.164.0**, direct-tool mode: real exec_command sed/rg, custom
  apply_patch, secret-file cat, and cat with an explicit outside working directory.
  The harness asserts both CLIs actually changed `value = 1` to `value = 2` and
  completed all five tool results. Merely receiving a tool result is not success.

Run with a fresh output directory:

```
OUT=.artifacts/follow3160-capture-new node scripts/manual/workspace-follow/capture.mjs
```

The model catalog is a private test input selecting Codex's actual direct router,
not a changed host setting or vendor account cache. Its schema comes from the
[0.164.0 upstream model definition](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/protocol/src/openai_models.rs).
Arbitrary Code Mode JavaScript is not supported or claimed by this feature.

These JSONL excerpts preserve record order, timestamps, tool IDs, tool inputs and
result envelopes. `__WORK__` and `__BASE__` replace only owned scratch paths. Model
instructions, usage accounting and unrelated system records were omitted; Codex's
session_meta retains only admission/version fields. All file contents and canaries
are seeded fixture data. The untrimmed captures and API request declarations remain
in the ignored `.artifacts/follow3160-capture-final` directory. The first two probe
runs exposed undeclared tools; they are not acceptance evidence.
