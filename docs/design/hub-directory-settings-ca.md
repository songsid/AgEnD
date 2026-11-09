# CA bootstrap in the AD settings API

M-2687 / #3425. Both authorized settings listeners can inspect an LDAPS server without application credentials, then fetch public CA material after confirming the exact leaf fingerprint. This composes the existing TLS/AIA bootstrap under the shared settings controller; it writes no config, secret, SQL operation or Save permit.

| Surface | Routes | Authority |
|---|---|---|
| Hub listener | POST `/hub/v1/admin/hub/directory/ca/inspect`, `…/ca/fetch` | The existing current, eligible configured-admin session, Origin and CSRF checks before body/controller acquisition. |
| Fleet listener | POST `/api/settings/hub/directory/ca/inspect`, `…/ca/fetch` | The existing exact local D3 host-session proof, including Host, Origin, CSRF, authority epoch and disconnect checks. |

The Hub session and HTTP entry advertise the separate `directory-ca-v1` capability only with the settings provider. This is an API capability, not a form or an authority grant. An editor must require its own matching module capability as well. Older servers without the new mark cannot offer this action. There are no new UI modules in this slice.

`inspect` accepts only `{url}`. It normalizes the LDAPS endpoint and stores a short-lived opaque probe with the exact actor/session, mounted source image/epoch/directory identity and clock bounds. Request ids may differ across its HTTP calls; the actor/session may not. Inspection sends no LDAP or credential bytes. It returns only the ref, expiry, canonical server and public leaf summary. Input metadata and returned summaries cannot retarget the stored probe.

`fetch` accepts only `{ref, fingerprint, bindDn?, bindPassword?}`. Service fields must be supplied together; the controller never reuses the old service password or an administrator's personal authentication input. A matching actor must consume the probe before the credential-bearing await, including failed/ambiguous fetches. A pin mismatch refuses before another pool admission or socket. Retrying a failed fetch requires fresh inspection; the future dialog may retain the same explicit trust choice only while the exact server/leaf/source still matches.

The existing bootstrap authenticates that confirmed leaf with normal TLS hostname verification and an exact pin before any LDAP bytes. A matching presented issuer chain is used directly. Otherwise only that same directory's bounded, base-scope AIA certificate read is permitted: no external host, referral or arbitrary URL. The caller can try anonymous read first; `ca-auth-required` asks for explicit read-only service credentials. The resulting public CA bundle must verify its chain and pass a fresh ordinary CA-verified TLS connection. Hostname/validity/pin failures stop the flow. No relaxed verification or bootstrap leaf anchor enters the stored runtime directory configuration.

Each whole inspection/fetch occupies the mounted generation's existing 4/person,32/total physical-promise pool, using the configured administrator's immutable key. The controller also tracks it for Stop. TLS inspection, pinned fetch and final CA verification now await their owned socket close acknowledgement before settling. Cancellation invalidates the result but retains physical occupancy until cleanup. No independent budget is introduced.

At most 32 probes (retained plus preparing) may exist in the controller. Expired and superseded source images are pruned before counting the limit. A saturated retained-probe limit returns429 with Retry-After 10. Existing shared-pool failures remain bounded unavailable outcomes; no cap is raised. Authority/material/time are checked before and after waits, including a final clock sample after source checks. A revoked generation cannot return CA data or publish a late probe.

| Fixed CA code | HTTP | UI meaning |
|---|---|---|
| `ca-invalid` |400| Check the certificate/service-input format. |
| `ca-trust` |409| Fingerprint, hostname or certificate validity mismatch: stop. |
| `ca-auth-required` |403| Anonymous CA read was refused; supply the read-only service credential. |
| `ca-unsupported` |409| This fetch method is unavailable; import a CA PEM instead. |
| `ca-unavailable` |503| The directory operation could not complete. Keep the old settings and retry explicitly. |

Other existing protocol errors retain their bounded status/code. Raw TLS/LDAP text, secret values, filesystem refs and caller-selected metadata are never returned. An unsuccessful CA operation changes no persisted settings.

Fetch does not authorize Save. The editor still needs the existing preparation's exact candidate trust challenge, recent old-directory administrator authentication (or D3), immutable candidate administrator/group continuity, and the same sealed writer/SQL decision. The final UI must show the new host/leaf/CA material and bind its single trust dialog to the exact candidate, clearing that choice when material changes. The one-dialog form, its PNGs and retained-module SKEW remain future evidence; no automatic trust reuse or completed UI is claimed here.

Acceptance uses inert source/controller doubles for authority, TTL, one-use, quota and cancellation controls; real CA-verified loopback LDAPS for credential-free inspection, pinned service-only AIA fetch and ordinary verification; and actual Hub/fleet listeners for route authority/capability checks. Three socket-close controls delay only owned client close acknowledgement. No real directory/account, native process, pilot or live fleet is used. The local settings source still requires a valid mount; cold off/held source and the AD form remain unfinished.

No migration or second writer is added. Reverting these routes/helper removes CA settings actions; keep the socket-drain improvement if desired. Durable Hub state and existing rollback limits are unchanged.
