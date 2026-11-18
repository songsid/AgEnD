# Room findability — M-3341 A4

An owner can make a shared agent findable to room managers from its existing access page. The default is off. A manager sees its name, published introduction and owner, then sends the existing named invitation. Room membership still waits for owner consent; one-to-one rights require their own grant.

The [approved flow](../../design/hub-room-ask-owner-for-agent.md) and [A4 API/lifetime notes](../../design/hub-room-agent-discovery-api.md) describe the setting, opt-out precedence, role inventory and rollback.

## Validation

- Fail first: the new owner GET returned 404 before implementation (`a4-before.log`). A later held-permission test also found that discovery opt-out interrupted an already askable invitation; that failed 200-versus-409 first (`a4-askable-before.log`) and is now pinned with the askable path kept independent.
- New backend, owner UI and client files: 27/27 pass (15 backend, 9 UI, 3 client). They cover owner/CSRF/revisions, direct-catalog isolation, opt-out and askable compatibility, pending consent, pause/resume/new-publication reset, revocation, held selections/permission loss and rollback, team filtering, legacy schema, and scoped UI/client races.
- Seven new role-inventory cases pass: metadata changes affect the v2 digest; missing, unregistered, future and unkeyed schemas refuse; both original and v2 marker bytes survive registration.
- The affected integration run had 127 passes and three failures in existing exact feature vectors. All six vectors were updated for the new browser capability; the focused file then passed 20/20. The real factory/skill/changelog selection passed 33/33. Logs retain the diagnostic failures and their correction; counts describe separate runs, not distinct totals.
- Source and test TypeScript checks are clean. Seven assertion-based reversals are caught and restored: ignore owner opt-out, drop publication binding, drop preference-revision selection proof, drop commit permission, expose discovery in the direct catalog, omit inventory metadata, and accept a retired UI read. See `controls.json`.

## Rendered proof and limits

The owned headless browser matrix passed 81 checks and produced 28 EN/zh-TW desktop/phone originals: shared off/on, paused, not shared, owner-disabled, picker and invited. The first picker screenshots framed the search input without the result rows. A focused picker retake passed 41 checks and replaces those four originals. Fourteen principal originals and then the two principal picker replacements were read for glyphs, wrapping, actions, disclosure and synthetic-only content; the framing gap is resolved.

The rig uses actual owned HTTPS, SQLite, encrypted audit, shipped UI and ordinary cookie/CSRF APIs. Only directory, Fleet/publication metadata and state setup are synthetic. The unshared disabled view uses a retained frozen exposure, which has an owner access page; it is not proof of a freeze/unfreeze operation. It runs no Fleet process, CLI, model, real account or Windows pane, and changes no operator trust store or browser profile. All network requests stay on the owned loopback origin. Disposable browser homes/certificates and pages close in `finally`.

`browser.json` and `picker-retake.json` record the source base, changed-source digest and served asset hashes. After the full matrix, an asynchronous owner-setting read/write generation fence and reload after refusal were strengthened; rendered markup/copy did not change. The focused picker retake includes current module assets. This is UI/HTTP/storage proof; no live Fleet delivery is claimed.

Run `tsx scripts/manual/hub-room-owner-requests-m3341/discovery-browser.mts` with owned Linux `CHROME`, `PW_DIR` and `CJK_FONT`. `VIEW=picker` focuses retakes on the result rows. Public logs replace local paths with `<worktree>`; all visible names/IDs are fake. Manifest entries use `path` and `sha256`.

## Rollback and deferred work

The additive `s3-room-agent-discovery` v1 table is registered after the A2 request component. Its metadata enters the current inventory v2 without rewriting historical markers or the role migration registry. A hard downgrade needs the full pre-upgrade Hub backup restored. A compatible rollback must disable the discovery visibility mode and controls together, retaining existing room/invitation data and A2 pending-hint protection. No migration rows are removed or fabricated.

Named invitations keep their existing expiry, pending deduplication and batch limit; no daily quota is added here. A5 forwarding remains parked.
