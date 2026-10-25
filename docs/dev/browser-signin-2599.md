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

Stage 2 adds `BrowserBackendSignIns`, the fixed native PTY adapter, local setup
routes and shared browser cards. Every route retains the setup cookie, exact
Host/origin and post-await owner/TTL checks; tunneled setup cannot use login
controls. GET polling does not extend the idle lifetime. The pending file holds
only canonical selected/pending IDs, atomically at 0600. Old hint files are not
auth proof. Finish seals admission, awaits reap, and rechecks the committed
configuration before handoff. Shutdown also joins cleanup before any successor.
The `--backend-signin-capabilities` probe returns before marker/reset handling;
it keeps dashboard=false until stage 3. No installer behavior changes here.

Stage-2 browser proof: `PW_DIR=<own playwright package> OUT=<own output directory>
AGEND_HOME=<scratch home> tsx scripts/manual/setup-signin-2599.mts`. The actual
SetupHost and Chromium use injected stub backend transports and auth probes,
with a forbidden successor and all external browser requests blocked. It covers
three backend flows, agy skip, same-cookie refresh, verified cleanup and safe
logs. This is not real-provider or Windows/WSL acceptance.

Stage 3 exposes GET/POST `/ui/browser-backend-signins` behind the current local
admin session, CSRF, surface and post-await ownership checks. It shares the
exact `loginWindow` reservation with chat, install and profile sign-ins. Browser
cards serve default accounts, while credential profiles and explicit console
fallback keep the old controller. Provider hints stay with the starting session;
SSE contains no hints. Verified fresh login invokes default-account recovery;
reusing valid credentials only updates availability/pending metadata.

Installer pending IDs also feed the real NeedsYouHub as backend items without
a fabricated agent or chat world. They are web-only items and never a request to
spawn an agent. A failed structured reap keeps admission closed across an
in-process restart; a new host process plus manual cleanup is the recovery path.
The capability probe now advertises dashboard support; installer order remains
stage 4. Run `scripts/manual/dashboard-signin-2599.mts` with PW_DIR, OUT and a
scratch AGEND_HOME for the real dialog + cookie/CSRF HTTP proof, injected stub
backend, blocked external requests and no fleet.


Stage 4 moves package installation before backend sign-in, while keeping stored
progress IDs (4 = package installed, 3 = credentials verified). Capability JSON
must advertise version 1 and setup/dashboard/installer support; old or malformed
responses retain the explicit console fallback. New setup receives canonical
backend IDs. An already-completed setup is never reset: after service setup, the
installer opens an authenticated dashboard checklist instead. `agend web --code
--backend-signins ...` creates only a same-origin navigation hint; the page merges
IDs without starting a CLI, cancelling another writer, or accepting a command.
Antigravity remains console-only, with an explicit skip and pending hint. A deliberate Check sign-ins uses its existing read-only auth probe to clear that hint after console sign-in; it never starts an agy login or device bridge.

The PowerShell helpers are exercised with all WSL/auth/browser boundaries stubbed
and private HOME/USERPROFILE. Portable PowerShell 7 is a syntax/runtime proof,
not a claim of native Windows PowerShell 5.1 or WSL localhost acceptance. Actual
Windows acceptance: fresh install; Kiro method/org fields, Claude code, Codex
device code in browser; refresh joins; skip leaves Needs you; rerun preserves an
existing config; old published package falls back; agy never enters a structured
writer. No real-account acceptance is performed by the automated suite.

The shared shortcut source is encoded as UTF-16/base64 into a Windows command
line. Its existing 30,000-character test keeps space below the 32,767 limit;
embedded commentary is kept short to preserve that margin. The dashboard opener
still captures native stderr under Continue and restores ErrorActionPreference
in finally, because Windows PowerShell 5.1 represents stderr as error records.
