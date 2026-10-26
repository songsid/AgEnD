# kiro-cli 2.34.0 `/session-id` and `/title` (#2684, survey #2681 candidates 5 and 10)

These fixtures are the **parse contract** for M-2025. The announcement strings are verbatim from live 2.34.0 `tui.js` (`sha256 fb15bdf3bd1d495bb6a51e39530f7b82985c3b49f54603dc29b69eaecf9019b7`, same hash as `../kiro-2.34.0-audit/`). The surrounding chrome is the already-audited TUI composer `../kiro-2.34.0-audit/t2-ready-120-2.34.0.pane.txt` (120 columns). The announcement is placed immediately above the idle composer.

## Why not a live tmux capture

Three isolated attempts (scratch HOME, `unshare -rn`, private tmux socket `k2681`, host `kiro-cli` 2.34.0, dummy social token, no account, no live fleet instance) did not reach the composer:

1. First-run HOME stopped at Builder ID sign-in. `/session-id` would have been typed into the login menu.
2. Esc after the login screen did not leave a `data.sqlite3` the seeder could find.
3. A seeded `data.sqlite3` plus `KIRO_MOCK_ACP=true` plus the audit-rig `patch-tui.py` (scratch copy of `tui.js` only) died immediately: `error: missing field 'oauth_flow' at line 1 column 177`. 2.34.0's BuilderIdToken now requires `oauth_flow`; the dummy `{access_token, provider, profile_arn}` shape that older audits used is no longer enough. The 2.34.0 audit workspace `/tmp/k234` is gone, and `seed.py` is not in the committed rig.

Host `tui.js` was not patched. No account was used.

## tui.js contract (not a conversation turn)

`tui.js-showSessionId-updateTitle.txt` is the `showSessionId` and `updateTitle` methods, copied verbatim:

- `/session-id` → `announceSystem(r, true, 10000)` with `Session ID: ${id}\nResume with: kiro-cli --resume-id ${id}` or `Session ID: none`. On TUI, `announceSystem` is `showTransientAlert` (`transientAlert` state, 10s). It is not a user or assistant message, so it does not land in the session jsonl (`Prompt` / `AssistantMessage`) and cannot arm the reply guard.
- `/title <name>` → `showAlert(\`Title set: ${title}\`)` on success, or the disabled / empty errors. OSC title is not in `tmux capture-pane`.

AgEnD therefore types these only on an idle, verified composer (same gates as a kiro delivery). The pane parser reads the last `Session ID:` line; `"none"` is special.

| File | What it shows |
|---|---|
| `tui.js-showSessionId-updateTitle.txt` | Verbatim 2.34.0 methods. |
| `tui-session-id.pane.txt` | Ready composer plus `Session ID: conv-owned-1`. |
| `tui-session-id-none.pane.txt` | Ready composer plus `Session ID: none`. |
| `tui-session-id-last.pane.txt` | Two announcements; the parser must take the last id. |
| `tui-title-set.pane.txt` | Ready composer plus `Title set: agend-dev-grok-t1`. |
