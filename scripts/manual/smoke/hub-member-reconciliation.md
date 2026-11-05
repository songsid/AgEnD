# Member reconnect barrier (S-56)

Run from the repository root, without an account, directory server or provider:

```sh
npx vitest run tests/hub-member-reconciliation.test.ts tests/hub-member-reconnect-network.test.ts
```

The network case creates test-owned loopback TLS/WSS listeners, a self-signed pinned identity,
Hub/member SQLite files, an encrypted journal key and an independently durable revision floor.
It uses the production S3 `HubRoomsService.receipt` and `reconcile`, and S1 pairing, client,
server, admission and journal. Directory and restricted execution are inert.

Two questions already exist in the member journal. One has advanced from queued to consumed;
the Hub retains its older queued receipt. The other has a current queued receipt on both sides.
The Hub commits the consumed receipt and its audit, then the test closes that socket before
its ACK. Reconnect obtains the retained consumed receipt, ignores the older queued ACK and
converges without transmitting the consumed receipt again. A duplicate signed question then
returns the original receipt without a second restricted-outbox insertion. Reopening the
member DB/key/floor preserves the acknowledgements. No question/answer plaintext, tool call
or terminal input is replayed by the handshake.

Composition contract:

- `createHubMemberHandshake({journal, publishSnapshot})` is the client's pre-ready `reconcile`.
  `publishSnapshot(link)` is S3c's complete current consent-ready snapshot, sent on the captured
  link. It must fence any of its own continuations; the handshake rechecks after it returns.
- `knownMessages({afterMessageId?, limit?})` and
  `unackedReceipts({afterSequence?, limit?})` return metadata only, at most 128 rows per page.
  `revocationVersion()` and `observeRevocationVersion(version)` provide a durable monotonic
  lower bound. A welcome version is neither a scoped revocation nor permission to execute.
- S5 owns `receive`: question → admission → receipt with the original request ID;
  revoke → admission fence; receipt → journal acknowledge; unexpected frames → hold.
  Older ACKs with the right message/digest are ignored without acknowledging a newer stage.
  Unknown IDs, future sequences, wrong digests or conflicting current stages are refused.
- The Hub's reconciliation cursor is global to this member's committed receipt history,
  independent of each known-ID page. It cannot move backwards or claim progress without rows.
- A receipt flush requires an exact echo before acknowledging it. A lost echo ends this link;
  the next link reconciles committed evidence. No blanket request or input retry is added.
- Metadata reconciliation has a 30 s deadline and at most 8192 exchanges. Excessive history,
  non-converging concurrent work or a retired/changing link refuses startup. The client surfaces
  its existing transport hold; it never becomes ready on incomplete evidence.
- Answer disclosure remains S4's responsibility, with a fresh exact release lease. This helper
  never resends answer bytes or manufactures an answer ACK. It adds no exposure ACK frame or
  remote-confirmed UI claim. Member enablement remains S5's complete-service composition gate.

This proof does not claim a production execution provider, a real directory, a browser flow,
Windows delivery or a composed fleet lifecycle. No live fleet or host configuration is used.
