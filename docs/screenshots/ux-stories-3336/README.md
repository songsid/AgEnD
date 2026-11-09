# C9: pairing before the owner's first sign-in

The existing Hub Administration form makes a pairing code for `olivia`, an
eligible fake-directory owner who has never signed in to this Hub. The offer
still waits for ownership confirmation and administrator approval. Selecting
the directory identity creates no owner session or grant.

| Capture | View |
| --- | --- |
| [English desktop](c9-directory-owner-en-desktop.png) | 1366 × 900 |
| [繁體中文手機](c9-directory-owner-zh-TW-phone.png) | 390 × 844 |

These are actual Chromium captures of the existing Hub UI, served over a
scratch HTTPS listener and using the production AD driver against the owned
fake LDAPS fixture. Every person, credential and pairing code is disposable
test data. Each language uses its own Hub database. The smoke checks that the
owner has no Hub person row before or after selection, the exact directory key
is bound to the offer, no grant is created, and there are no browser errors or
horizontal overflow.

The pending offer's owner label remains empty until their first sign-in;
selection does not manufacture a signed-in person record. These images do not
claim real AD, native service, live fleet or browser-certificate trust testing.
The test browser accepts only its throwaway web certificate; LDAPS uses normal
CA and hostname verification.

Reproduce with `scripts/manual/hub-directory/run.sh` and
`scripts/manual/smoke/smoke-hub-pair-owner-3336.mts`, using a private fixture env
file and an isolated Playwright installation. The PR acceptance records the
source revision, browser version, commands, fail-first result and mutations.
