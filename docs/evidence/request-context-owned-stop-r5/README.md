# First-On failure and owned stop regression

The Settings confirmation for first On follows only the exact lifecycle stop it owns. A real stop advances its epoch before queueing and again inside the transition; both steps must be attributed to that stop. An unrelated stop, replacement or revoked route still invalidates the confirmation.

## Verification

- 214 tests passed across 11 named lifecycle, Settings and request-context files, using `--maxWorkers=2`.
- Three independent mutants failed: restore the old route logic; remove the expected-before-epoch comparison; omit the Fleet callback wiring.
- `settings-route-owned-stop-r5.test.ts` exercises the real lifecycle queue with inert daemons, including queued work, delayed teardown, external invalidation and replacement.
- `request-context-relaunch-s230.test.ts` carries the real lifecycle route through the first-On relaunch; activation is not committed in that preparation test.
- Controller tests prove a failed On remains visible through read/refresh, emits a Needs you item, exposes no private exception and creates no activation record. Check again clears the transient failure without activating.
- Local TypeScript 6.0.2 checking stops at the unchanged circular inference in `runtime-pane-port.ts:307` (TS7022/TS7024); no changed-file diagnostic. CI remains the clean-build gate.

## Real-app captures

The repository web smoke fixture serves the actual Settings and Needs you components and API. A scratch controller deliberately fails preparation before activation; all names/data are synthetic. The fixture starts no Fleet or CLI process and touches no live home. Desktop EN/light and phone zh-TW/dark reuse the existing approved failure text and Check again action. These are component crops to exclude unrelated fixture chrome. Physical phone behaviour is not claimed.

- [desk-en-failed-on.png](desk-en-failed-on.png) — SHA-256 `bf9a411fc1b2908d30ec7dce02f69a49fa1ccc6565991b14c8c201e403e38621`
- [desk-en-needs-failed-on.png](desk-en-needs-failed-on.png) — SHA-256 `fb02a4fd4ce9f0123a5cb99b1301411b0da41e258fb6839d83f498217bb90343`
- [phone-zh-TW-failed-on.png](phone-zh-TW-failed-on.png) — SHA-256 `32f07158c2ec20d1d972618377ae89d06b20a13c43f16aeadfc98691d39271b4`
- [phone-zh-TW-needs-failed-on.png](phone-zh-TW-needs-failed-on.png) — SHA-256 `31104b1c33c733b2a17ed2123a02773300eb5e21fb2ff73fc9a0abd63b1912da`

## Risk and rollback

No permission, readiness or activation checks are weakened. The observer only accounts for the owned stop’s actual adjacent epoch steps. The failure flag is process-local presentation state, with private diagnostics retained only in the daemon log. Revert this fix to restore the previous route behaviour; the request-context compatibility floor and activation history are unchanged.
