# Approval System Analysis

Analysis of how the approval system interacts with Claude Code, based on live testing and source code inspection (2026-03-23).

## Architecture

```
Claude calls Bash tool
  │
  ├─ Layer 1: Claude Code permissions.deny (hard deny)
  │   Only truly catastrophic: rm -rf /, dd, mkfs
  │   Claude sees: "Permission to use Bash with command X has been denied."
  │   No hook fires. No user override possible.
  │
  ├─ Layer 2: PreToolUse hook → ApprovalServer
  │   Hook fires curl to 127.0.0.1:PORT/approve
  │   ApprovalServer checks danger patterns:
  │     Safe → auto-allow, no reason in response
  │     Dangerous → forward to Telegram inline buttons
  │       User clicks Approve → permissionDecision: "allow", reason: "approved by user"
  │       User clicks Deny → permissionDecision: "deny", reason: "denied by user"
  │       120s timeout → deny (same as user deny)
  │   If curl fails → fallback: deny with reason "approval server unreachable"
  │
  └─ Layer 3: Docker sandbox (if enabled)
      Command executes inside shared container regardless of which layer approved it
```

## What Claude sees

### On deny

Claude Code surfaces `permissionDecisionReason` as the `blockingError` message:

```javascript
// From Claude Code source (v2.1.81):
z.blockingError = {
  blockingError: _.hookSpecificOutput.permissionDecisionReason || _.reason || "Blocked by hook",
  command: T
}
```

| Scenario | Claude sees |
|----------|-----------|
| User clicks Deny | `"denied by user"` |
| Approval timeout (120s) | `"denied by user"` (same) |
| ApprovalServer unreachable | `"approval server unreachable"` |
| Hard deny (permissions.deny) | `"Permission to use Bash with command X has been denied."` |

### On allow

Claude Code stores `hookPermissionDecisionReason` but does NOT surface it to the model. There is no `blockingError` on allow, and no other mechanism passes the reason string to Claude.

```javascript
// From Claude Code source:
z.hookPermissionDecisionReason = _.hookSpecificOutput.permissionDecisionReason
// ↑ stored but never shown to model on allow
```

| Scenario | Claude sees |
|----------|-----------|
| Auto-approved (safe command) | `(Bash completed with no output)` or command output |
| User clicks Approve | Same — indistinguishable from auto-approve |

**Consequence:** Claude cannot tell whether a command was auto-approved or manually approved by the user. This is a Claude Code limitation, not something we can fix in the daemon.

## Danger patterns (ApprovalServer)

```javascript
const DANGER_PATTERNS = [
  /\brm\b/,                    // any file deletion
  /\bgit\s+push\b/,           // any push
  /\bgit\s+reset\b/,          // any reset
  /\bgit\s+clean\b/,          // any clean
  /\bgit\s+checkout\s+\./,    // discard changes
  /\bgit\s+restore\b/,        // discard changes
  /\bmv\b/,                    // move/rename files
  /\bdd\b/,
  /\bmkfs\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /(?<!\d)>\s*\/(?:etc|usr|var|bin|sbin|lib|opt|root|System|Library)\b/,
];
```

### Pattern notes

- `>\s*/` was narrowed to only match redirects to system paths. `echo > /tmp/file` is auto-approved; `echo > /etc/passwd` requires approval.
- `2>/dev/null` does NOT trigger (negative lookbehind `(?<!\d)` excludes fd redirects).
- `\brm\b` matches ALL rm commands including `rm file.txt`. There is no "safe rm" — any deletion requires approval.

## Hard deny list (permissions.deny)

```
Bash(rm -rf /)
Bash(rm -rf /*)
Bash(rm -rf ~)
Bash(rm -rf ~/*)
Bash(dd *)
Bash(mkfs *)
```

### Design decision: git operations NOT in hard deny

`git push --force`, `git reset --hard`, and `git clean` were originally in the hard deny list but were moved to ApprovalServer-only. Reason:

1. Hard deny gives Claude an opaque error message that it misinterprets as "approval server unreachable"
2. Claude then repeatedly asks the user if the server is broken
3. These operations are dangerous but not catastrophic — users should be able to approve them when needed

## Known limitations

1. **Claude cannot distinguish auto-approve from user-approve.** The `permissionDecisionReason` field is only surfaced on deny. This is a Claude Code limitation.

2. **Claude reads hook source code from system-reminder.** Claude Code puts the full curl command (including the fallback `"approval server unreachable"` string) into a system-reminder. Claude sometimes reads this static string and assumes it was the actual result, leading to confusion about server status.

3. **Hard deny error messages are opaque.** Claude Code's permissions system produces generic messages that Claude cannot distinguish from hook denials.

4. **sandbox `sudo` returns "command not found" instead of permission denied.** The Docker container doesn't have sudo installed. Claude may not understand this is by design.

## Test results (2026-03-23)

| Command | Layer | User action | Claude's understanding | Correct? |
|---------|-------|-------------|----------------------|----------|
| `ls`, `pwd`, `git status` | Auto-approve | — | Auto-approved | ✅ |
| `npm install axios` | Auto-approve | — | Auto-approved | ✅ |
| `curl httpbin.org` | Auto-approve | — | Auto-approved | ✅ |
| `echo > /tmp/file` | Auto-approve | — | Auto-approved | ✅ |
| `rm file.txt` | ApprovalServer | Approve | Thinks auto-approved | ❌ (can't fix) |
| `rm file.txt` | ApprovalServer | Deny | "denied by user" | ✅ |
| `mv file.txt dest` | ApprovalServer | Approve | Thinks auto-approved | ❌ (can't fix) |
| `git push origin main` | ApprovalServer | Deny | "denied by user" | ✅ |
| `git reset --hard HEAD` | ApprovalServer | Deny | "denied by user" | ✅ |
| `sudo ls /root` | ApprovalServer | Approve | "command not found" (no sudo in sandbox) | ⚠️ |
| `kill -0 $$` | ApprovalServer | Approve | Thinks auto-approved | ❌ (can't fix) |
| `rm -rf /` | Hard deny | — | "Permission denied" | ✅ |
| `echo > /etc/passwd` | ApprovalServer | — | Sent to Telegram | ✅ |
| `echo > /Users/me/file` | Auto-approve | — | Auto-approved | ✅ |
