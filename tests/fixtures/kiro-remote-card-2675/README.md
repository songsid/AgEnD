# #2675: kiro V3 cards answered by AgEnD's sequencer, against the real TUI

`e2e-2.34.0.txt` is one run of `rig/run.sh`, recorded on 2026-10-26. It drives kiro-cli 2.34.0's own V3 TUI with its offline mock agent:
- `KIRO_MOCK_ACP=true`, plus the test IPC socket that injects `question_request` / `mcp_elicitation_request` during a turn;
- a scratch HOME, `unshare -rn`, and a private tmux socket `-L k234`.

For setup, see `../kiro-2.34.0-audit/README.md`. `lib.sh`'s `molaunch`/`cmd`/`say` are the helpers from that audit. The scratch `tui.js` is patched with `../kiro-2.34.0-audit/rig/patch-tui.py`.

The rig is the same for every case:
1. Inject a card.
2. `rig/drive.mts.txt` reads it with `readKiroQuestionCard` / `readKiroMcpInputCard` and calls `answerRemoteCard` with one action. The script is kept as `.txt` so it is not compiled with the tests.
3. The run prints the card it read, the keys it sent and the outcome.

At the end, the transcript shows what kiro took as each answer:

| case | keys | kiro's transcript |
|---|---|---|
| option 2 | Down, Enter | `› All at once` |
| typed answer (with a line break) | paste, Enter | `› release, but only after the freeze` |
| option 3, then only sub-option 2 | Down, Down, Enter; then Space, Enter | `› Choose components [web]` |
| skip | Escape | the question closes, `Cancelled` |
| MCP form: decline | Down ×3, Enter | the request closes |
| MCP url (cursor on Copy URL): decline | Down ×2, Enter | the request closes |
| MCP url: cancel | Escape | the request closes |

V3's trust-all-tools warning, shown at launch, is accepted once in the rig: Down to `Yes, I accept`, verified, then Enter. In production the kiro backend's own startup handling answers it.
