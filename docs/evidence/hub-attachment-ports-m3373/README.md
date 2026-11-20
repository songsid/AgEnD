# Attachment end-to-end fixture listener reservation

`tests/hub-attachments-e2e.test.ts` selected a free member port and closed
its temporary listener before identity/database setup and actual TLS start.
A competing listener could claim the address in that interval.

The fixture now uses the existing `hubListenerPorts()` helper. Its one
OS-assigned socket stays bound until the real `HubServer` TLS listener adopts
that same socket. The separate web HTTP listener already binds port 0 and
keeps its original behavior. Shared helpers, production code, retry policy
and test deadlines are unchanged.

The existing both-directions attachment case now attempts an actual TCP bind
immediately before the real TLS start. The original fixture lets it bind,
and the new assertion fails semantically. The fixed fixture gets
`EADDRINUSE`, then runs the existing signed-question/file-chunk/answer/download
flow and its digest, encryption, audit and access checks. The malformed-file,
size, repeated-use and mixed-version cases remain intact. These retain the
fixture's existing S5 audit/content adapters; the attachment store and member
TLS/WSS transport remain production components.

A second physical bind runs in the existing server cleanup, after the real
TLS server closes and before database/lease/scratch disposal. It must bind
successfully, so fixture lease disposal cannot mask a leaked listener.
Server and web cleanup are registered before their awaited starts. Reverse
cleanup attempts every owned close, collects errors and restores mocks in
an outer `finally`; clients/services/database close before leases and root.

`validation.json` records the base semantic failure, final 4/4 attachment
cases, the 3 existing helper cases and final test TypeScript check. One first
fixed run timed out at the existing 10-second limit while the newly added
shutdown was inside the transfer body. The final version observes shutdown
in the original cleanup stage; all original deadlines are preserved, and
the final attachment run passes. The helper cases passed in that first
batch and were not repeated after the fixture-only cleanup correction.

Only local synthetic HTTP/TLS/WSS fixtures were used: no real account,
external model, vendor CLI, live Fleet, browser or Windows operation. Main
has no corresponding test, so this is dev-only. Rollback reverts this test
file and evidence; there is no product setting or persisted-data change.
S-198 and S-199 remain separate work under M-3373.
