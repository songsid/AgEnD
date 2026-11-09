# Kiro2.36 →3.0 exact TUI/V2 resume, offline (#3047)

`session.json` starts from an actual **2.36.0** no-turn TUI session produced offline, with a never-valid dummy
stored login. The fixture changes its cwd/read path to a placeholder, adds the known model and
`exported_from_v1: true` to represent a carried Classic session. The UUID, timestamps, permissions and remaining
metadata shape came from that real2.36 file. `session.jsonl` uses the captured2.34 Prompt/AssistantMessage shapes
with synthetic canaries. **No real conversation or account is represented; this is not a real migration receipt.**

The unmodified2.36 and3.0 binaries each resumed this exact fixture, on the same scratch profile with an even newer
same-cwd sibling containing `WRONG-NEWER-SIBLING-3047`. The prior canary `OFFLINE-RESUME-MEMORY-3047` appears in both
normal composers; `/session-id` reports the fixture UUID in both. The transcript hash stays unchanged.
Each phase ran in a separate disposable network-none container; phase2's container exited before phase3 started.
No mock ACP, patched TUI, retirement-menu answer, model turn, real credential or host-global setting was used.
The four pane captures are actual120-column outputs with trailing blank rows trimmed, not fabricated displays.

Recipe: `scripts/manual/kiro3-tui-resume/`. The test additionally runs real backend preparation/build and pinned
transcript/forensic readers against this fixture: the sibling cannot take over, historical content is baselined,
and new owned tool progress appears once. Those appended test records are synthetic, not a3.0 model/tool audit.

This proves the audited3.0 **V2** exact-resume/storage path on this offline fixture. It does not certify V3 conversion,
all live conversation shapes, sign-in/refresh, model responses, tools, busy steering or future3.x builds. Existing
version/steering audit limits remain unchanged. Failed initial synthetic metadata and incomplete helper-PATH setup
were discarded before this valid control; they are not evidence of a product compatibility failure.
