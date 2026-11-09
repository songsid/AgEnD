# Hub AD connection editor

Implements the presentation portion of [#3425](https://github.com/songsid/AgEnD/issues/3425), on the sealed directory controller, public Hub-admin/D3 routes and stopped-source recovery already on alpha. It adds no authority or settings writer.

## Entry and compatibility

The configured directory administrator opens **Administration → This Hub → Edit AD connection**. It is a sub-page in the real Hub shell: Administration stays the PanelHeader, with a crumb and an AD connection PageHead. The host’s exact local D3 session gets the same form in the real **Settings → Hub** section. That host form loads without an AD sign-in while AD is unreachable, or while the Hub is stopped/held. The existing Run switch remains on this page.

`directory-editor-v1` in the Hub session and `directoryEditorV1` in the client must both be present. The host page requires its distinct D3-only HTML mark. These marks only control display: every public read, probe, preparation, test and Save keeps the existing route authority. Old modules, old servers, retained host HTML, public links and remote sessions cannot acquire authority from a mark. The Hub serves only the two new Hub modules; the fleet adapter is never on its module list. The read DTO adds the current directory epoch so the form can reject a stale displayed source before using its draft.

## Fields and Save

The form edits URL, search base, service DN, write-only service password, system roots or a PEM CA bundle, and the existing advanced login attribute/filter/timeout fields. Realm and profile are read-only. It never accepts an administrator, person key, recipients, audit changes or secret reference from a person.

One Save prepares and re-reads the current epoch and displayed fields. A changed server or CA opens one shared native trust dialog naming the new host, leaf fingerprint and CA fingerprints. Cancel invalidates the draft. The trust metadata must match the edited LDAPS endpoint, including its port, before the dialog is offered. SHA-256 values use two rows of four complete eight-character groups. Only its fingerprint action sends Save. Ordinary same-host changes have no extra dialog. Optional Test cancels its draft afterwards and never saves or sends a personal password. A blank service password reuses the existing one only when server, CA and service DN are unchanged; nonblank opaque secret bytes are preserved. The stored-password state is a visible label beside the field title, also linked as the input’s accessible description; it is never a secret value or placeholder.

For a Hub administrator, fresh authentication is inline when the server requires it. Only Save sends that personal credential, and the existing proof controller checks it against the OLD trusted directory. Candidate settings use only service credentials, require the same immutable administrator and configured group identities, then join the same sealed writer, SQLite decision, epoch transition, notice/audit commit and mount/forward-compensation flow. D3 recovery does not require a personal AD credential.

A successful Hub Save first refreshes the rotated session and CSRF state, then re-reads settings. A restored, interrupted or ambiguous Save offers Reload; the form never automatically replays Save. Cancel after Save is sent also requires Reload, even if a late response says ready. Single-flight, abort and permanent local generation fences drop late results after Cancel, navigation and sign-out; a late prepared ref is cancelled. Server checks remain authoritative if browser cancellation arrives late.

## CA bootstrap

Fetch CA first inspects the leaf without an LDAP password. The person confirms that leaf before anonymous retrieval. If anonymous retrieval is refused, a service-only retry re-probes and must match that exact confirmed host and leaf before sending the supplied service credentials. The fetched PEM is hashed in the browser; verified preparation must return the same host, leaf and CA hashes. The same dialog then shows the derived CA fingerprints and the final Save action. A mismatch stops without Save. It never offers a continue-anyway path.

## Verification and limits

See `scripts/manual/hub-directory-editor/README.md` and the digest-first receipts under `docs/screenshots/hub-directory-editor/`. Browser journeys use actual private HTTP, Hub HTTPS, a generated verified fake LDAPS peer and production UI modules. No API response substitutions are used; SKEW replaces only static modules/HTML, or uses the actual earlier server. Passwords, people and DNs in the fixtures are fictional. Shared UI gates verify their ordinary pages; the new form’s own phone tap/text/viewport checks run in this rig.

The backend already owns crash, compensation, browser epoch and held-authentication evidence in the prior directory slices. This PR does not repeat or broaden those claims. It does not reconfigure the Mac pilot or a real directory, change feature defaults, start an agent/CLI, or exercise native services. Removing the frontend commit hides these controls but does not reverse a committed directory change or a migrated Hub DB; restore settings through an authorized forward change, or use the documented stopped-backup procedure for a downgrade.

## Presentation polish before alpha.10

The type is shown as Active Directory (AD), with no raw profile token. The password input states that a stored value exists without returning it. Trust headings name SHA-256 and the target server; each full fingerprint is retained in eight unbroken eight-hex-character groups. Cancel is distinct from the host’s Run/Stop control. Short DN/CA/PEM hints and equal-width controls use the existing field layout.

The Settings Hub wrapper gives its cards a consistent gap and natural height. Phone retention uses full-width numeric touch inputs and a wrapping Save button. A disabled company sign-in action names its missing address/Fleet-name prerequisites with an accessible description; it starts no handoff. All existing authority and save paths are unchanged.

The earlier lower-card images were partial scroller views and did not reliably show the headings; no heading was missing from the component source. Acceptance now waits for all lazy headings and settled font paint, checks each title, and separately centers the Run/retention/company cards. The retention controls are measured above the fixed phone navigation. This avoids presenting a partially visible field as a complete screen.
