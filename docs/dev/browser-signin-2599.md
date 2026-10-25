# Browser backend sign-in: staged rollout (#2599)

The approved initial scope is Kiro, Claude Code and Codex. Antigravity remains
an explicit console fallback; its passive device-auth bridge is a separate
follow-up after an offline audit. Remote `/login agy` remains unsupported.

Each stage is a separate main-based PR with parity review and coordinator merge:

1. Structured driver (`structured-signin.ts`): fixed dedicated login commands,
   exact observed menus, closed actions, one owner/attempt/prompt revision, shared
   login reservation, independent credential probe and confirmed cleanup.
2. Pre-fleet setup routes/cards and pending backend IDs: authenticated local
   setup owner, session expiry/revocation, no fleet imports, teardown before
   successor handoff. Web-only and bot setup use the same sign-in step.
3. Dashboard reuse and pending sign-ins in Needs you, including backends not yet
   attached to an agent. Local admin only; no public link, guest or read session.
4. Installer order, capability detection and progress compatibility; explicit
   console fallback for agy and older packages, stub WSL/PowerShell and browser
   proofs, EN/zh-TW documentation. The Pages installer changes only in this stage.

Stage 1 has no routes, process launcher, browser card or installer activation.
Hosts supply the transport and the current authority predicate. The transport
must start only the supplied fixed login argv in a dedicated PTY, disable
automatic browser opening, keep no interactive shell after exit, bound native
operations, and confirm teardown including a late startup. The driver never
treats an exit code or screen text alone as successful authentication.

Kiro method selection uses the captured ordered menu and its current cursor;
organization URL/region and Claude's code can be entered only at their matching
live prompt. Unknown prompts fail closed after a short redraw grace. The
separate console path handles unsupported provider/onboarding screens. Only
the starting owner sees provider URLs/codes; safe change events contain neither
raw output nor supplied text. A possibly live child retains the shared login
reservation on cleanup failure; stage 2 must surface that a confirmed reap and
host restart are required before retrying. Each actionable prompt phase accepts
one answer per attempt, including across selection redraws or blank captures.
A different phase remains usable; retrying the same phase requires a new attempt.
An ambiguous input ends the attempt without repeating it.

Stage 1 proofs use injected inert transports, the audited Kiro/Claude menu
fixtures, synthetic provider screens, and held async boundaries. They do not
certify real provider login, setup HTTP authority, WSL behavior or browser UI;
those integrations require their later stages' proofs.

Rollback is per stage. Removing the unused stage-1 driver changes no active
login behavior; the extracted provider URL allowlist is byte-equivalent and
re-exported through the existing module. Later installer rollback selects its
explicit console path and preserves provider credentials.
