# Actual CLI effort checks (M-2891 / #3636)

**Muse 加入 `EFFORT_BACKENDS`：YES。** Muse 1.4.15 的 `/effort` 已以同一程序、真實 TUI 與本機 mock request 證實，不需重啟。Codex 與 OpenCode 也已證實原生即時切換；這不會自動改變 AgEnD 目前的 restart/unsupported 策略。Kiro 與 Muse 的供應商逐模型等級：**unverified (no recorded catalog)**。依 leader 指示不呼叫真實帳號 API；PR 1 保留現有後端 fallback 清單可接受。

Evidence date: 2026-11-11. Distribution versions and binary digests are in [versions.txt](versions.txt) and [distributions.json](distributions.json). No product code or live configuration changed. This branch is an evidence record, not a request to enable OpenCode effort or alter restart behavior.

## Results

| Real CLI | Models / programmatic source | How effort is set | Native live switch / TUI |
|---|---|---|---|
| **Codex 0.167.0** | Offline `app-server` JSON-RPC `model/list` returned 12 bundled entries, with `supportedReasoningEfforts` and default per entry. Full mapping in [codex-model-levels.json](codex/codex-model-levels.json). Account/workspace availability was not checked. Account-populated `$CODEX_HOME/models_cache.json` uses `supported_reasoning_levels`; none was copied from the host. | Startup `-c model_reasoning_effort="high"`, or config key `model_reasoning_effort`. Native `/model --reasoning=high` changes the current session; the `/model` picker also selects the level. | **YES, observed.** Same Codex PID, low→high on the next Responses request. [Wire receipt](codex/codex-live-proof.json), [low](codex/codex-low-live.txt), [high](codex/codex-high-live.txt). Footer shows model + effort. Picker has low/medium/high/xhigh and [More reasoning → Max/Ultra](codex/codex-more-reasoning.txt) for GPT-6.1-Sol. There is no need to claim a native `/effort` command. |
| **Kiro 2.34.0, TUI/V2** | `chat --list-models --format json` exists, but this offline invocation returned `dispatch failure`. Genuine binary carries `additional_model_request_fields_schema`; native TUI reads model metadata `_meta.kiro.effortSchemaPath`, `effortLevels`, and `defaultEffortLevel`. **Vendor model tiers: unverified (no recorded catalog).** | `kiro-cli chat --effort LEVEL`; documented defaults use `chat.modelDefaults[model].output_config.effort` for Claude and `.reasoning.effort` for GPT. Native `/effort LEVEL` / `/model` exist. | Current mock has no model schema: actual TUI says [effort configuration unavailable](kiro/kiro-effort-high.txt). Therefore no successful current-binary per-model wire switch is claimed. Native live controls are independently present in the existing 2.34 audit and current official docs; AgEnD's comment that `/effort` is absent is stale. Current docs distinguish session-only `/effort` from explicitly saving a default. |
| **Muse 1.4.15-R8339.1** | Offline `model-profile show MODEL --effort TIER` resolves knobs. Provider-populated schema-v3 cache at `$XDG_DATA_HOME/muse/model-catalog/` (else the HOME data root) exposes `rows[].reasoning_effort_variants`. This fixture's variants are null. **Vendor model tiers: unverified (no recorded catalog).** | `--reasoning-effort` / alias `--effort`; help enum `none|minimal|low|medium|high|xhigh|max|ultra`. Settings key `reasoning_effort`; live `/effort LEVEL`. The global enum is not a universal model-support promise. | **YES, observed.** Same Muse PID, low→max on next main-turn request; status bar changes. [Pinned interim and caveats](muse/README.md), [wire receipt](muse/muse-live-proof.json). Reminder subagent effort is separate and excluded. No claim that the live slash change writes the startup default. |
| **OpenCode 1.19.5 (V1)** | `models PROVIDER --verbose` returns full model metadata including `capabilities.reasoning` and `variants`. [Bundled snapshot projection](opencode/opencode-bundled-model-variants.json): **140** OpenAI/Anthropic/Google entries, **109** with variants. This is CLI snapshot data, not vendor entitlement/live validation. Config can add, replace or disable variants. | Headless **`run --variant NAME`** ([help](opencode/opencode-run-help.txt), [successful mock run](opencode/oc-flag.txt), exit 0); config `provider.<id>.models.<model>.options` / `.variants`. TUI `/variants`, or Ctrl+T. Use the V1 interface; do not assume current V2 `provider/model#variant` docs apply to this binary. | **YES, observed.** Same OpenCode PID, low→high; requests carry `reasoning_effort`. [Wire receipt](opencode/opencode-live-proof.json), [picker](opencode/opencode-variants.txt), [high status](opencode/opencode-high-live.txt). The fixture with `reasoning:false` has no variants; the reasoning fixture has low/medium/high. |

### Exact per-model findings

Codex's bundled catalog groups (including hidden entries, which are not a promise of account access):

- `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-6.1-terra`, `gpt-5.6-terra`, hidden `gpt-daybreak-blue-latest` / `gpt-daybreak-red-latest`: low, medium, high, xhigh, max, ultra.
- `gpt-6-luna`, `gpt-5.6-luna`, hidden `codex-auto-review`: low, medium, high, xhigh, max.
- `gpt-5.5`: low, medium, high, xhigh.

Defaults and hidden flags are preserved in the JSON. The native CLI can expose `ultra`, while AgEnD intentionally has a smaller canonical ladder. No mapping change is proposed here.

OpenCode's exact 140-model mapping preserves each variant's **actual options**, not only its name. Examples from that binary:

- `openai/gpt-6.1-sol`: low/medium/high/xhigh/max map to `reasoningEffort`.
- `openai/gpt-4.1`: no variants.
- `anthropic/claude-sonnet-4-6`: low/medium/high/max map to adaptive thinking + `effort`.
- `anthropic/claude-haiku-4-5`: high/max mean **thinking token budgets** (16000/31999), not Anthropic's `output_config.effort` support. Do not infer effort API capability from the label.
- `google/gemini-3.8-flash`: low/medium/high map to `thinkingConfig.thinkingLevel`.

For Kiro and Muse, the authorized read-only search of previous Kiro 3.x and Muse 1.4.15 audit fixtures/captures found no real or sanitized model catalog. The Muse audit's “23-entry catalog” is composer tips, not models. [Search receipt](catalog-search.json). No new account read was authorized or performed. Kiro's offline “unavailable” result does **not** prove Sonnet lacks effort.

## Isolation, inputs and commands

- Existing binaries were copied into an owned prefix; Muse's updater/launcher was bypassed. OpenCode's exact Linux npm platform archive was downloaded without install scripts and checked against registry SHA-512 `i1qh7VooLGML9xX6ud93y0JA8j/1aPeDYRKjsmYXrJX1TjIWHgBBMkEbEJPZthpWbsJg//XfBgR6Kb7+NPaJiQ==`.
- `env -i`, empty HOME plus all XDG roots, private tmux, `unshare -Urn`, only loopback up. No real auth or CLI configuration copied. Kiro's scratch database was seeded with the existing audit's deliberately invalid offline token shape; this only bypasses local login UI. OpenCode's dummy configured provider keys do not grant an account.
- Namespace-local Responses and Chat Completions mocks return inert text, never tool calls. They cannot reach a vendor or the live Fleet. The only network retrievals outside the namespace were public install metadata/artifacts and documentation/GitHub.
- Original repository input: `5316eb1e0097777e14d9ddcc0ba60af7c03e5010`. Existing mocks: `scripts/manual/codex-version-audit/mock.mjs`, `scripts/manual/muse-version-audit/mock.py`. The Muse mock's audit file root was substituted to the owned prefix; protocol code was unchanged.
- [harness/](harness/) contains the actual narrow probe scripts. Copy them to the scratch `.e2891/` root if reusing: they are not a standalone installer. The Codex model-list helper expects the repository cwd. Mock configs are included. All startup commands below run inside the isolated namespace, with the copied binary first on PATH.

```sh
codex --version
codex --no-daemon --no-alt-screen -a never
# Separate stdio process: initialize → initialized → model/list {includeHidden:true}
codex app-server --stdio
# Live commands in the same TUI: /model --reasoning=low, /model --reasoning=high

kiro-cli --version
kiro-cli chat --help
kiro-cli chat --list-models --format json
# Mock fixture: [["offline mock acknowledgement"]]
kiro-cli chat --tui --agent-engine=v2 --model claude-sonnet-4.6 --effort low
# /effort and /effort high: schema-unavailable captures, not successful-switch evidence

muse --version
muse --help
muse model-profile show muse-spark-1.3 --effort high
# Complete Muse startup and live commands are in muse/README.md.

opencode --version
opencode models mock --verbose
opencode models openai --verbose
opencode models anthropic --verbose
opencode models google --verbose
opencode run --variant high --model mock/probe-reasoning 'offline flag control'
# Native TUI: /variants → low, prompt → /variants → high, prompt
```

OpenCode catalog runs set disabled model fetch and use the bundled snapshot, with empty HOME and dummy provider options; the mock-specific runs additionally supply an owned empty catalog file and explicit mock models. No provider inference call occurs in `models`.

## Evidence limits and cleanup

Captured text replaces the owned absolute scratch root with `/AUDIT`; the newly published Codex/Kiro/OpenCode text also removes trailing line whitespace and empty terminal rows, as recorded with original digests in `capture-normalization.json`. Muse interim captures remain unchanged. Request projections omit prompts/system text and carry body digests of the private originals (Codex's projection digest uses its parsed JSON serialization). No authentication secrets are in these receipts. The first Codex launch lacked its package companions and an early mock launch failed; `--no-daemon` and the copied Node 22 runner corrected the harness. The final same-PID requests succeeded; earlier reconnect text remains in its TUI history and is not presented as vendor behavior. An OpenCode flag probe mistakenly started in a separate network namespace timed out; the recorded exit-0 control ran in the mock's namespace. Its unverified hash-syntax attempt returned a generic error and is not used as an authoritative parser diagnosis.

See [checks.json](checks.json) for bounded assertions and the digest-first root manifest for all published files. No product regression suite was run for this evidence-only work. Audit processes are stopped and physically checked in the final cleanup receipt; the installed CLIs and live Fleet were not changed. Removing this owned scratch prefix/branch is the rollback; no deployment is involved.

Primary references (supplemental, not substituted for the captures): [Codex current session controls](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Kiro effort/schema/persistence](https://kiro.dev/docs/models/effort/), [OpenCode V1 variants](https://opencode.ai/v1/docs/models/#variants), [OpenCode tagged 1.19.5 variant implementation](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/provider/transform.ts).
