# U2 groundwork + B2 composition — not final acceptance

Historical packet at 5d3385fe8. The subsequent complete public U2 composition
is recorded in `../full-u2-composition/`; the hashes here bind the older source.

This supersedes the source hashes in `../preparation/`. It composes the public
U2 groundwork, not the complete administrator card. No parity/gate request and
no heavy browser/container campaign is made by this packet.

Bases and merges:

- B1 dependency: fb3d858755af7f55a5d8226679c8a00f33604749 (#3673, draft).
- B2 original preparation: 603777d2091a9d49d52cc639392da205b6728f32.
- Plain merge e47418fe61c213e66e529936e3168a49fa064bee brings public U2
  8b1d0a69244b14d73a57c97b261b54655ee92cc5. Three conflicts were resolved:
  the union of Hub module names; U1's E13/tab-close behavior with B2's queue;
  and both the notice-version and post-leave authority regression tests.
- Plain merge b88a894c8ea555652a45c472dce6425c847e9fcc brings U2
  1c72b48292b8f3107040ca0710f26a8467f88857 cleanly, including its picker id
  capability and its two-picker regression.

Changes verified:

- The actual U2 slot loads the real B2 component without an injected substitute.
  A first code completes step 2 through `onChanged`; switching company join off
  disables create and the outer instructions while preserving revoke.
- The actual U2 picker has its own dialog input/note ids. A selected hit is
  resolved before creation, and a changed GUID refuses the scope. A held module
  without the id capability uses the exact-DN fallback. The picker's unavailable
  hint also has a working DN action. Capability-skew tests replace only the
  marker; they are not real old-browser byte evidence.
- Current member Settings explicitly leases notice v3 only with the renderer
  marker and optional client method. Default consumers remain v2. The compatible
  `?v=2&notices=3` query keeps manual notices on older hosts. Retiring the last
  reader removes code rows from the presentation cache; older reads cannot
  overwrite current notices or restore retired code rows. Public-link and
  local-admin gates remain before any notice read. U1 prefill is preserved.
- A newly pinned race: a temporary browser-projection failure used to retire a
  still-current approval and leave its parent busy. The first finite deadline
  now remains pinned for the same request/session; failed or later reads cannot
  retire or extend it. Request/session changes still retire the queue.

Verification (serial, light runs):

- 263/263 tests in 19 focused suites, zero skips. Exact paths and source hashes
  are in `source-binding.json`.
- Native TypeScript source and test checks pass. Changelog: 385 fragments OK.
- 28 isolated reversals compile/parse and fail intended assertions, with
  byte-exact restoration; `mutations.json` records each. The API mutation runs
  the native source typecheck before its focused test; JavaScript mutations use
  `node --check`.
- Fail-first: the compatible member query omitted code rows before its API
  change; the projection/deadline race failed semantically before its fix.
  Initial composition also exposed two fixtures assuming the picker was absent;
  these now exercise the real unsupported-search-to-DN handoff.
- B1's 23 product files: 21 unchanged. Only its HTTP UI composition and local
  notice projection changed. Nine inherited picker/slot/Fleet files, including
  the Fleet input, are byte-identical to public U2 1c72b482.
- B2's diff check against that public U2 base is clean. Three pre-existing EOF
  blank lines in inherited U1 files are preserved rather than rewriting the
  Fleet-side dependency; they are not new B2 whitespace changes.

Tests use actual Preact with inert clients/fetch, plus an owned synthetic
HTTPS/LDAPS session fixture. No real company account, backend CLI, pilot,
directory, native Windows, Chromium or container operation occurred here.

Still pending: the complete U2 administrator card and landed B1/U2 plain sync;
real-shell EN/zh-TW desktop/phone PNGs and old-shell/CSS SKEW; combined B-L*
acceptance including distinct Fleet interfaces and 20/50-Fleet capacity. Under
decision d9122d7c and the leader's scheduling instruction, ask the leader before
the heavy campaign and do not overlap the alpha.15 rehearsal.

Risks remain browser layout/loading/timing and final orchestration, which these
unit checks do not claim to settle. Rollback is the B2 UI/session-capability and
notice-projection delta; B1's schema, credentials and code records remain intact.
