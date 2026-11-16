# Real encrypted app-content repair

The first native Codex remote-MCP journey completed OAuth and reached the actual tools, then lost the fixture server when dispatch could not read its unbound question ciphertext. A no-model HTTP diagnostic reproduced the same `HubProtocolError: uncertain` at rooms.ts content verification. No live Hub/Fleet/AD was involved.

Root cause: app audit events omit content pointers for privacy, while the real content store serves only sealed rows. The map-backed tool fixture had hidden this dependency. An internal message binding now seals the content to `message:<UUID>` within the existing atomic question/post and metadata-audit transaction. Audit event content pointers stay null. The store still refuses loose, rebound or transplanted ciphertext, and a failed transaction rolls back the binding. No migration, member frame or capability is added.

The new real-HTTP/SQLite/encrypted-audit assertion failed before the repair (blank post; one selected, 27 excluded). Current door and audit suites pass 45/45 in two files, including exact direct question input, released answer and private audit-pointer checks. Source and test TypeScript programs exit 0. These are scoped acceptance controls, not a repeated mutation, browser or model campaign. The native journey is resumed separately on the repaired source.

Rollback disables app access and removes the new call sites/optional port together. Existing ordinary audit bindings and retention remain compatible; no data downgrade is required.
