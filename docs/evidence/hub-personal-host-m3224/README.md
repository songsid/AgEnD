# Personal question host evidence

Historical composing checkpoint at e63206c0: the source review and tests below preceded registration. They used no
Windows process, real auth, model turn, browser window, AD or vendor service. The later registration delta now has
its own [authorized Windows x64 proof](windows-x64/README.md) and default-factory checks; the original test scopes
below are retained and are not described as a combined real-vendor end-to-end run.

The actual local HTTPS/WSS journey uses an inert Windows-shaped protocol peer with a private fixture CA. Company
sign-in and owner HTTP routes, SQLite, encrypted content, audit, sealed enrollment and the Runtime coordinator are
real. It proves one direct answer, exact replay without another run, owner-only disconnect and credential retirement.
It does not prove a real Windows worker or installer execution.

Completed checks (scopes overlap; do not add them):

- `vitest run tests/hub-personal-runtime-m3224.test.ts tests/hub-personal-turns-m3224.test.ts --maxWorkers=2`: 10 pass.
- `vitest run tests/hub-personal-http-m3224.test.ts tests/hub-personal-owner-m3224.test.ts tests/hub-room-feedback-protocol-m3224.test.ts --maxWorkers=2`: 20 pass before the final browser-kind assertion addition.
- Existing feedback adapter packet: four files, 74 pass (strict protocol, encrypted notification journal, retained room ask and post adapters).
- Existing HTTP/feedback packet: two files, 13 pass.
- `runtime-install.test.ts`: 37 pass in the first packet. `runtime-install-script.test.ts`: 26 pass after preserving the ordinary restart command line. The source and test TypeScript programs both exit 0 on the final source.
- Final HTTP personal-kind projection packet: 9 pass.

Fail-first evidence: disabling personal admission formerly poisoned catalog reads with 503; disconnect lacked a route;
replacement retained the old Runtime credential; a working turn continued after the owner's switch turned off. Each
assertion failed semantically before its focused repair. The native Windows proof from #4046 retains its ARM64 scope.

Local logs are under `.artifacts/m3224-host/`. No raw token, credential, machine journal or content receipt is committed.

Six selected assertion reversals were caught: personal @all exclusion, running-job revocation, exact answer ACK
mapping, legacy welcome size, partial role inventory, and interrupted feedback input recovery. The last reversal
first exposed a test timeout; moving its persisted-state assertion before the blocked delivery made the failure
semantic. The production file was restored byte for byte after each reversal.

Review follow-up: the CI correction adds the feedback journal to the exact member migration vector; member hello
capabilities stay unchanged. Startup also requests cancellation for an interrupted working turn. Retired enrollment
cleanup now records a confirmed external retirement and skips it on later events. An unconfirmed file outcome is
retried even if the in-memory machine already says revoked. The restart/retirement assertions were red before these
repairs; the affected three-file packet passes 25/25, and the final retirement file passes 9/9 (overlapping scopes).
No TLS/WSS, native, browser or full mutation campaign was repeated for this follow-up.
