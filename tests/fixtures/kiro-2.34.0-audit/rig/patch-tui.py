# patch-tui.py <scratch HOME>/.local/share/kiro-cli/tui.js — the two edits the mock run needs, in a SCRATCH copy only.
# kiro unpacks tui.js per HOME and runs it as found. Under KIRO_MOCK_ACP=true the TUI talks to its in-process mock agent,
# which (1) has no sandbox to confirm, so every launch stops on "Could not confirm sandbox protection", and (2) gives an
# injected mcp_elicitation_request no resolve callback, so cancelling the card throws. The card component itself is not
# touched: what the panes show is 2.34.0's own rendering.
import sys
p = sys.argv[1]; s = open(p, encoding="utf8").read()
a = 'setSandboxExecution:(u)=>{if(r)return;'
assert s.count(a) == 1
s = s.replace(a, 'setSandboxExecution:(u)=>{if(process.env.KIRO_MOCK_ACP==="true")u={phase:"ok"};if(r)return;')
b = 'else if(e.type==="question_request"){let t={...e,value:{...e.value,resolve:(n)=>{console.log("Mock question resolved:",n)}}};this.broadcastEvent(t)}'
assert s.count(b) == 1
s = s.replace(b, b + 'else if(e.type==="mcp_elicitation_request"){let t={...e,value:{...e.value,resolve:(n)=>{globalThis.__agendAuditElicitation=n}}};this.broadcastEvent(t)}')
open(p, "w", encoding="utf8").write(s)
