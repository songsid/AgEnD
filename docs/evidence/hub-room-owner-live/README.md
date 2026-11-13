# Recorded owner and room stream recovery

At source `7e315c22ba151dd0234189bdc8fcc8ae98eb35ed`, the four focused actual HTTP/SQLite suites pass43/43 and both native TypeScript programs exit0. `acceptance.json` binds the source and test inputs. This is a small follow-up to #3866; its parent, plain alpha sync, resolution review and current-head CI are still merge conditions.

Agent answers stored the owner identity in `author_subject`, but their HTTP/SSE author projection omitted it. The projection now returns the owner's name from that recorded identity. The regression checks live events, history and history after changing the exposure owner and reopening the HTTP service.

The real four-agent browser walk also showed that simultaneous agent eligibility reads could fill a viewer's physical directory slots. A room event read then raised retryable backpressure and immediately ended the stream. The existing bounded event queue now retains that event for up to three fresh read retries, after25,50and100ms. Current lifetime/session checks remain after the delays and before writing. Persistent overload and other failures still close. The actual HTTP controls prove one transient overload recovers on the same stream, and continuous overload ends after the bounded attempts.

Original owner and stream fail-first logs, exact four-agent diagnostic, UI fixes,76browser checks and14original PNGs are preserved in the [separate integration packet](https://github.com/songsid/AgEnD/tree/472aac0c60586fe416346d35611e1f31f558abac/docs/evidence/hub-rooms-integration-r3/r5-owner-thread). Those execution scopes overlap the tests here and are not summed. Lumen's affected-view recheck and the Team provider/fullS142 are pending.

The test directory and input ports are inert; no real AD, Fleet, account, vendor API or CLI is used. There is no schema, message identity or permission change. Reverting the two fixes restores the prior missing owner metadata and immediate stream close on contention; storage and issued deliveries remain intact.
