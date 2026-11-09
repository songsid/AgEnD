# Hub confirmation language and Stop semantics (#3511 / #3512)

The Settings confirmation diff belongs to the server and follows the Fleet's configured locale. The browser renders the two exact existing EN/zh-TW Hub connection summary forms in the page's language, preserving the captured target as text. Unknown or extended lines remain verbatim. The stored proposal, id, digest, authority, confirmation controls and execution are unchanged. An own dictionary in the existing shared shell avoids a new module dependency for retained tabs.

**Stop remains a service pause.** It closes the Hub listener and pauses Agent chats; still-valid browser sessions can resume after Run. Explicit sign-outs and expired sessions do not resume. Both the initial dialog and the client/server confirmation summaries now say that in EN and zh-TW.

This fixes the wording rather than adding bulk revocation. The ordinary fence is also used for remounts, where signing everybody out would be a different behavior. The durable browser epoch participates in the sealed directory-settings head and actor rotation; advancing it as an independent Stop counter would violate that binding. A distinct durable bulk-sign-out operation would need its own lifecycle and recovery design. This patch changes no session state machine, epoch, grant or authentication rule.

Validation pairs fail-first mounted copy tests with a real sealed Hub HTTPS/production-AD/owned-LDAPS control: the listener refuses while stopped; after Run the valid session works and explicitly signed-out/expired sessions remain refused. The browser evidence exercises real pending Settings requests on both the Settings page and its waiting popup. Its Stop-dialog fixture projects initialized config without starting a Hub; the separate runtime control proves Stop/Run behavior. The main twin contains only the shared display component, because main has neither the alpha Hub Run control nor its locale keys.

Rollback is a UI/text revert. No schema, persisted session, configuration, certificate or credential migration is introduced.
