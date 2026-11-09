# Directory security notices in the current shells

Part of #3425 / M-2687. Uses #3469's Hub recipient routes and #3470's host D3 routes. These are presentations of the existing durable outbox, not another delivery store.

The Hub's **Notices** page shows AD connection changes alongside existing fleet security notices. Directory history is available to original recipients even without current administrator or group permissions. The session's `directory-security-notices-v1` mark and the matching client mark/methods must both exist. No directory history is fetched on welcome startup. No new stream is created, and existing pairing stream behavior is preserved.

The fleet's **Needs you** page has a private host section only when the server marked this exact local D3 session and a configured Hub exists. The backend independently authorizes every request. This section uses only the fleet D3 routes, including when the Hub could not mount. Neither the payload nor its acknowledgment enters the shared Needs-you derivation, SSE, General, or the transient WebNotices store. The shared-list empty wording says there are no *other* waiting items. The shared sidebar count does not count this private queue. Refresh or reopening the page reads the current durable history; this slice adds no background notification or polling.

Both views page through 25 records at a time with **Older notices** and preserve the server's exact cursor. A collapsed or unread notice is never automatically acknowledged. **Acknowledge** posts only the exact displayed ID and updates only that row after success. It never acknowledges another recipient. A failed/ambiguous write is not replayed automatically; the person is told to refresh before retrying. Reads and writes are serialized within the mounted section. A failed refresh keeps previously displayed history; 401/403 clears it. A busy read honors a bounded Retry-After delay (fallback 10 seconds), shows a plain busy state and retries. Busy acknowledgments require another explicit click.

Unmount or client replacement invalidates all pending results and cancels the retry timer. Its timer callback and read-entry generation checks overlap; the post-await read and acknowledgment checks guard late publication. No source claims that each redundant timer check is independently necessary.

Only field-name enums, event time, actor kind and acknowledgment state are displayed. No directory values, credentials, recipients, session identifiers, request identifiers or configuration images are introduced. A recorded connection change or restoration does not claim that mounting or directory health succeeded.

## Evidence

- `tests/hub-directory-notice-ui.test.ts`: mounted Preact, exact older-ID acknowledgment, failed write, overlapping clicks, late read/ACK after replacement, Retry-After and unmount cancellation, both capability directions and the actual client adapters.
- `tests/hub-shell-parity.test.ts`: directory-only recipient with no group/admin role, real shell and no welcome startup history read.
- `tests/hub-directory-host-notices.test.ts`: real fleet shell marks only the local D3 host, not an ordinary login or forwarded request. Existing cold-state/authority/transaction tests remain.
- `scripts/manual/hub-directory-notices/accept.mts`: one owned scratch rig with real Hub HTTPS and fleet HTTP/D3 listeners, inert directory, real sealed writer decisions and durable notice services. Four desktop/phone × EN/zh-TW journeys, eight PNGs, 44 checks. Host read/ACK occurs while the runtime is mounted with a separate WAL connection. Person targets stay unread after host ACK. A retained host shell without the display mark causes no private request. No browser API reply stubs. The browser ignores the owned test CA; this is not a new verified-TLS/real-LDAP claim.
- `scripts/manual/hub-directory-notices/mutations.py`: 11 isolated source reversals, all caught by AssertionError; original bytes restored. Browser and focused receipts are under `docs/evidence/hub-directory-notice-ui/`.
- `docs/screenshots/hub-directory-notice-ui/`: actual current shells, desktop/phone, EN/zh-TW. Fixtures use fictional names and owned loopback listeners only.

The first browser attempt stopped before initialization because its certificate did not name the loopback URL. The corrected run passed all browser checks but an unused fleet preview listener kept Node alive after cleanup. Only that owned process was terminated; the final fixture disables the unused preview and explicitly closes any preview listener. The final run passed all 44 checks and exited normally, with browsers, listeners, WAL connections and scratch state closed/removed.

No real directory, account, native CLI, pilot, OS service or live fleet was used. The AD editor/Save composition and startup compensation intent remain separate work. Reverting this UI patch leaves durable records and their routes intact; no database restore or epoch rollback is involved.
