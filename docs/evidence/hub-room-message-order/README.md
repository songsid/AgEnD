# Committed room message order

Source `155cd71211f257b3478eed906a0cccaa41f6b51b` adds optional `RoomMessage.sequence` from the existing group-room row. A completed answer already moves to a later SQL sequence; HTTP history follows that order. Live clients previously had no committed ordering field and kept the queued placeholder's old array position, moving replies ahead of human conversation.

This slice changes two product files and no database or Fleet frame. The new actual HTTP/SQLite/SSE regression creates a pending reply, posts a human message, then receives the answer. It checks the pending and final sequence, the human's intervening position, identical live/history metadata and the existing final history order. The three-suite slice passes42/42 at this source; both native programs exit0. Logs and five source/test/note bindings are adjacent.

The pre-field assertion failure was executed on broader integration `2434afc76`, rather than this narrow parent. Its projector body is byte-equal to parent `17f636889`; the equality digest is recorded. The failed log retains the missing-number assertions without counting them as separate test cases.

U1 separately consumes the field in #3867 at `3d30a29e`. The real integration `500ee6d5` passes88 browser checks with eight original desktop/phone views and an image-only inspection of all eight. It explicitly asserts answer1 → answer2 → human → answers3–6. Its37 UI checks and native results are integration evidence, not execution of this PR. [The packet](https://github.com/songsid/AgEnD/tree/47844b7cb/docs/evidence/hub-rooms-integration-r3/r6-six-answers) retains the failing desktop order before U1's correction.

Cached tabs need the UI consumer to reorder live answers. Older/direct messages may omit sequence and keep their existing behavior. Removing the projection field rolls this metadata change back; persisted order and delivery identities remain intact. Parent #3874 must merge before this slice is synchronized and gated. Full S-142 still awaits the Team provider and combined PM walk.
