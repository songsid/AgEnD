# Host-session Hub initialization

Implementation slice of [#3425](https://github.com/songsid/AgEnD/issues/3425), M-2687. Initial setup is exposed on the fleet listener and through Settings → Hub. Directory reconfiguration follows separately. It does not add a second settings writer or an AD editing endpoint.

## Authority and requests

Only the host's own D3 launch-link cookie session **on this computer** may initialize a Hub. Every request rechecks the exact session record, token and authority epoch. A generic administrator, chat account, guest, header token, public/gateway request, forwarded request or remote peer cannot use these routes. Mutations require the matching local Origin and CSRF token. The host proof is obtained before importing or creating the initializer, and rechecked after reading the body and creating the controller.

The fleet-only prefix is `/api/settings/hub/setup`:

| Method | Suffix | Purpose |
| --- | --- | --- |
| GET | empty | Whether a Hub already exists, setup is incomplete, or another fleet is present |
| POST | `/prepare` | Validate explicit setup fields and keep a server-owned draft |
| POST | `/test` | Recheck the draft's administrator through the directory service identity |
| POST | `/commit` | Consume the draft and initialize the exact confirmed plan |
| POST | `/cancel` | Invalidate a draft and clean up owned staging |
| POST | `/ca/inspect` | Inspect a directory TLS certificate without application data or credentials |
| POST | `/ca/fetch` | Fetch the CA through the existing exact-leaf-pinned helper |

Bodies are strict JSON, at most 192 KiB; unknown fields are refused. A browser supplies configuration values, a write-only service password, an administrator **login for selection**, and optionally write-only browser certificate/key PEMs. It cannot supply a PersonKey, a secret reference, a filesystem path, or a terminal confirmation. A supplied CA bundle requires confirmation of all its fingerprints before any service bind. Origins are canonicalized before certificate staging or sealing. Existing directory CA bootstrap rules, normal TLS verification and exclusive listener preflight are reused.

Responses contain bounded summaries, public fingerprints and opaque references. The reference is not authority: it is bound to the preparing host session, its exact in-memory record and authority epoch, the initial config image and a five-minute deadline. There are at most eight owned drafts and two physical operations. LDAP lookup, eligibility and close must settle before capacity is released. Cancel, expiry and shutdown keep late continuations fenced. No timeout race releases a slot early.

## The existing initialization path

`createHubInitializer` remains the single initial writer. Its CLI calls keep terminal provenance. Browser calls pass an explicit host-session source; neither source can consume the other's confirmation. Plans and secrets are copied before awaits. The initializer checks the source, session/lifetime and clock after asynchronous inspection, identity reads/provisioning and sealing, and before subsequent effects. A provisioned identity is recorded as owned even if the host session disappeared during provision; enabling never follows that lost proof. The existing CLI resume path can recover the same interrupted plan.

The controller selects the designated administrator with bounded service-account lookup, checks the exact immutable identity again, and repeats it at Save. No personal password is requested or used in candidate-directory binds. No person row, administrator session or grant is manufactured. The designated person still claims administration at their first actual Hub browser sign-in.

All fleet YAML patches go through FleetManager's existing synchronous writer. Other settings and comments are retained. The controller compares its expected raw image after each own patch; unrelated changes refuse the draft. Keys, copied browser TLS, bind secret, normalized seal and installation inventory use the existing initializer. `hub.enabled` is the last patch. Group policy remains never-enabled/off. No OS service installation, reboot, account changes or trust-store modification is performed.

An omitted name means the `hub.name` key is absent and the brand is plain “AgEnD Hub”. An explicitly present name remains trimmed, nonblank and bounded. CLI and browser initialization accept the same omission. Uploaded browser PEMs are copied into server-chosen private staging and checked for validity, hostname coverage and key match; only that owned staging may be cleaned up or retained for an interrupted resume.

## Required audit and recovery

Before a Hub database exists, setup uses a private, bounded, fsynced bootstrap event journal. It contains operation/result codes, request/session hashes and nonsecret confirmation identifiers, never passwords, PEM keys or directory fields. Required pre-enable audit failure leaves the Hub off. The initializer receipt also records explicit browser confirmation provenance; the manifest's confirmation identifier binds its canonical hash. Browser references and cookies are not stored.

At mount, the journal is validated and imported into the real audit chain **before either listener opens**. Each event and its durable import marker share one SQLite transaction. An append failure rolls back both; restart retries exactly once. Markers remain after audit retention so retained bootstrap evidence cannot be replayed. A changed event, unsafe file, torn tail or wrong-Hub binding refuses mounting rather than silently discarding evidence. Existing CLI installations without this journal keep working.

The new `s5-web-initialization-audit` schema component makes a binary without it refuse the migrated database. Reverting a binary is safe before migration; after migration use an appropriate pre-upgrade state backup. Never remove schema rows, rewind floors or reseal a modified configuration by hand.

## Evidence and remaining work

Tests use private scratch homes, real D3 HTTP cookies, an owned fake LDAPS peer with verified TLS, real S1 key generation/seal verification, real exclusive bind checks and normal-verification Hub HTTPS. Controls cover invalid/nonhost authority, a session revoked while the body is held, stale owner/image/deadline, disabled or recreated administrator, occupied ports at Save, CA inspection without credentials, wrong-pin refusal before bind, required-audit failure and atomic import/retry. Separate initializer controls hold key provisioning and sealing across host-session revocation and exercise CLI resume.

No pilot, real directory/account, native service manager or user fleet is exercised. The guided form uses the real fleet Settings shell, localized English/Traditional Chinese copy and shared form/error/loading components. Its display capability comes from the exact local host session; retained modules or a page without the capability offer no setup. The server still reauthorizes every request. CA inspection sends no credentials, explicit leaf confirmation permits a pinned CA fetch, and every imported CA fingerprint must be confirmed before the directory test. A tested draft is canceled on edits/back/unmount, write-only secrets are cleared for review, and an ambiguous consumed Save requires checking Settings rather than replaying it. Browser tests cover real HTTP/D3, verified fake LDAPS and normal-verification Hub HTTPS across desktop/phone, light/dark and EN/zh-TW. AD reconfiguration's SQLite decision/mount/session/notice integration remains separate M-2687 work. An initialization response confirms the sealed initialization; subsequent runtime readiness is still reported by the existing Hub status/hold surface.
