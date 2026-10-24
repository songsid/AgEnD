# kiro-cli 2.34.0 audit against 2.33.1 (2026-10-24, #2587)

The baseline is 2.33.1, the version the upstream watch compared against. The last live audit was 2.33.0's (`../kiro-2.33.0-audit/`). The host runs 2.30.0, which was not touched.

**Result.** Every launch screen is unchanged, and AgEnD's answers still lead to the composer. **New in 2.34.0:** V3 answers an MCP server's input request (MCP *elicitation*) with a card in place of the composer. On main AgEnD read that pane as an idle composer, so the next delivery landed in the card. The card is now held for the person (`kiroMcpInputRequestActive`, `tests/kiro-2.34.0-audit.test.ts`).

## Artifacts

| | 2.33.1 | 2.34.0 |
|---|---|---|
| `kirocli-x86_64-linux.tar.gz` sha256 | `5993158abeb1a3086a591d5c7dd77e3db3c889a3c0d8b41418bc6a1af79400fb` | `1a703c4e5a0cdfb4990d9476a0b0d4255a7802946f01220edaa717e8d7bdca05` (equals the release manifest's) |
| `bin/kiro-cli` sha256 | `801e11f74e31d26f883f5f56cde96c006124c94ee8e063c58f45ad183f34f147` | `94cae7e349f76869a19eae335a5b392fba8515743b1c2822b9ea33128c067cc6` |
| `bin/kiro-cli-chat` sha256 | `6c143853239d75ecbb51099ab1dc768c1a03707de6b9d5393fa3dacdf24bc036` | `596c48b3cba6db1f5c043434c20a5fd1d23ea7d35eb0b70e3bcfe4144d93a79c` |
| `tui.js` (unpacked to `~/.local/share/kiro-cli/` on the first `--v3`) sha256 | `97cb85df5fa98e78549488a9593712576258e91034547e52d200ea3f77f113a8` | `fb15bdf3bd1d495bb6a51e39530f7b82985c3b49f54603dc29b69eaecf9019b7` |

Supporting files:
- **Help:** `../kiro-help/chat-help-2.34.0.txt` is 2.34.0's `kiro-cli chat --help`. Its diff to 2.33.1 (`chat-help-2.33.1-2.34.0.diff`) adds only `--trust-workspace` ("Skip the 'Trust this workspace?' prompt for this launch only (V3 only)…; the decision is not saved"), plus a reordered `-v`. AgEnD's pins (`--legacy-ui --agent-engine=v1`, `--tui --agent-engine=v2`, `--v3`) are unchanged.
- **`tui-2.34.0-mcp-input.js.txt`:** the card component and the request handling, copied verbatim from 2.34.0's `tui.js`. 2.33.1's `tui.js` has no `Input requested` and no `mcp_elicitation_request`.
- **`precheck-2.33.1-2.34.0.txt`:** the watch's precheck. **`kiro-cli-chat-precheck-hits.strings.txt`:** the bytes around its three unhinted hits, found by a byte search; no kiro code was run for them.
- **`*.mcp-log.txt`:** what a stub MCP server (`rig/elicit-mcp.js`) received.

## Static precheck: MAJOR, hard=3, hinted=1

None of the flagged strings is a new prompt on AgEnD's path:
- **"Trust this workspace?"** (appeared 0→1 in `kiro-cli-chat`): the help text of the new `--trust-workspace` flag. The prompt itself lives in `tui.js`, as in 2.33, and is byte-identical (`v3-ws-120-*`, `v3-home-80-*`).
- **"Are you sure you want to continue uninstalling Kiro CLI?"** belongs to `kiro-cli uninstall`, which AgEnD never runs.
- **"The previous response was interrupted. Continue from the recorded response; do not repeat completed work."** is an agent-side note sent to the model when an interrupted turn is resumed (among `crates/agent/src/agent/mod.rs` events). It is never painted.
- **The hinted "rate limit reached:"** is a re-ordered string pool: the header now sits next to "Your prompt is too long even after truncation."
- **The count changes** are prose churn. Every detector literal is still present.

The changelog's other items:
- **Model picker editor:** "Choose which models the picker lists", inside V3's in-session `/model` picker. AgEnD never sends `/model` to kiro; model switches restart with `--model`. The picker needs the real model list, so it was not reached offline (the mock agent has none: "No models available").
- **Workflow recovery and saved sessions:** not visible in these launch and composer screens.

## Live captures

**Setup.** The same as 2.33.0's audit:
- an isolated `HOME`/`XDG_*`, run under `unshare -rn` with `coredump_filter` 0;
- a dummy social token in the scratch `data.sqlite3`;
- a private tmux socket.

The host's kiro install and data were not touched. Panes come from `capture-pane -p`, and from `-e` for `*.pane-e.txt`. Scratch paths are shortened to `/tmp/k234`; the detectors read wrapped paths joined.

**Launch screens** (both versions):
- `v3-ws-120`: V3, untrusted folder.
- `v3-home-80`: home at 80 columns.
- `t2-trust-120` / `t2-trust-80`: TUI trust-all-tools.
- `l1-start`: legacy; offline it stops at "Failed to fetch available models".
- `v3-ready-120`, `v3-ready-home-80`, `t2-ready-120`: the composers.

Each was driven by `KiroBackend.getStartupDialogs()`, picking the keys from the live pane as the daemon does:
- V3 folder or home: workspace trust Enter → trust-all Down → Enter → ready.
- TUI: Down → Enter → ready.

The steps are identical on both versions.

**The MCP input card (`mcp-<width>-<step>-<version>`).** Without a model, kiro asks for the card only inside a tool call. A request outside a tool (right after `initialized`, or during `prompts/get`) is answered `cancel` within milliseconds, by both versions (`elicit-2.33.1/2.34.0.mcp-log.txt`; V3 advertises `elicitation: {form, url}`). The V2 engine advertises no elicitation capability and answers `elicitation/create` with -32601 (`elicit-eng-v2.mcp-log.txt`). So the card was reached through the TUI's own test harness:
- `KIRO_MOCK_ACP=true` (an in-process mock agent);
- `KIRO_TEST_MODE=1` with `KIRO_TEST_TUI_IPC_SOCKET_PATH` (`rig/ipc.mjs`), whose `MOCK_SESSION_UPDATE` injects the agent's `mcp_elicitation_request` during a turn.

The card is 2.34.0's own component. Two edits to the scratch copy of `tui.js` (`rig/patch-tui.py`) only work around the mock:
- its missing sandbox, which would otherwise stop every launch on "Could not confirm sandbox protection";
- its missing resolve callback.

**Steps** (`rig/elscen.sh`, at 120 and 80 columns):

| step | what |
|---|---|
| `10-form` | a form request: `Input requested · MCP server`, the message, three fields, Submit / Decline, `esc to cancel · ↑↓ to navigate · enter to select · ctrl+s to submit` |
| `11-form-paste` | what a delivery's paste does: nothing visible |
| `12-form-paste-enter` | its Enter: "Favourite colour (required): (none)" accepted, the cursor on the next field |
| `13-form-esc` | Esc cancels the request; the turn goes on, composer below |
| `19-after-turn` | the turn completed: composer idle |
| `20-url` | a url request: Host, URL, Open in browser / ❯ Copy URL / I'll open it myself / Decline / Cancel |
| `21-url-esc` | cancelled |
| `30-question`, `31-question-esc` | the agent's `Question` card, for comparison: unchanged since 2.33.1 (`mcp-120-30-question-2.33.1`), not part of #2587 |

`mcp-120-10-form-2.33.1` and `mcp-120-20-url-2.33.1` show 2.33.1 painting nothing for the same requests: the turn just keeps thinking.

`mock-ready-120-*` is the mock session's composer.
