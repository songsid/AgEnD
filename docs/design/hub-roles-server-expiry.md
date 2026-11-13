# Hub roles: inactive expiry settlement (M-3010 / S-127)

This helper follows the inactive writer in #3772 and the accepted roles design at 9e0006256. It has no timer, startup call, HTTP route, feature advertisement or registered migration. Production continues to use the existing group-only policy. Atomic cutover, actual resource/provenance consequences and live operation permits remain separate acceptance.

## One durable settlement per expiry term

The helper reads the exact owned role document and selects assignments whose recorded expiry has arrived. A term is the hash of Hub identity, realm, assignment identity and its exact deadline. Display changes do not create another term; a changed deadline does. Markers are durable independently of audit retention. Assignment history and the document revision remain unchanged.

One immediate SQLite transaction applies the mandatory server-prepared resource projection, appends one required `role.assignment-expired` record per term, records markers and management-expiry notice recipients, then advances the authorization epoch once for the batch. The audit actor is the local host, never a synthetic admin. Event bodies contain assignment/role/deadline metadata and the private projection digest, with no conversation contents. Every exact marker, policy image and ordinary resource fingerprint is checked again after audit and epoch work. Audit, projection, proof and epoch methods must settle synchronously; a thenable refuses and rolls back its synchronous prelude. A raised independent transport floor is never rolled back. Refresh runs after commit; a refresh failure reports unavailable without pretending committed markers or narrowing disappeared.

A missing actual resource adapter is not optional. The exported integration boundary receives a detached policy and expired-term list, prepares its bounded exact consequences, proves current state before commit, narrows it synchronously, and proves the committed result. This slice supplies only the owned synthetic SQL adapter in tests. It does not claim that pending joins, manual/code/invitation provenance or actual Fleet resources are wired.

Assignment deadlines must stop live authority at the read/operation boundary even when settlement is still waiting for the directory. This helper records durable consequences; it is not permission to extend an expired assignment. The later live permit/lease conversion must enforce each recorded deadline directly.

## Current authority and physical ownership

Management permissions are personal and Hub-wide under the strict role graph. Candidate recipients are therefore the configured root and current personal Administrator subjects, independent of a resource inventory. Each is freshly checked for eligibility through the existing policy owner's 4/person, 32-total directory pool. An explicitly disabled/deleted person is omitted; an unknown or mismatched result refuses the batch. If the administrator set changes through expiry while a physical read settles, preparation refuses and retries from the current time. Root is only the physical admission key; it is not impersonated in audit or used as a browser authority.

A single promise is published before integration callbacks can re-enter. Close invalidates that flight without releasing its slot early. There is a 20-second injected monotonic acceptance budget and wall-clock rollback refusal, with no race that pretends to abort a physical directory operation or releases its pool slot before it settles. Current lifetime, directory method/realm, exact policy, authorization epoch and full resource snapshot are rechecked after awaits. This is an acceptance deadline, not a new LDAP transport timeout.

## Clock floor and activation requirement

The maximum committed settlement timestamp is a persistent role-clock floor. `assertAuthorizationTime()` refuses clocks below it and rechecks the actual independent transport floor. Audit retention cannot remove the expiry markers or lower this clock floor. Restoring an older transport image against its independently raised floor also refuses.

The clock helper is only a fence, never an authorization permit. **Before runtime activation, every role-authority reader and writer, member lease, dispatch/tool boundary and stream disclosure must consume this fence together with the existing current/time/epoch proofs.** The pure evaluator alone does not persist a clock floor. No current runtime caller is changed in this slice, and it does not claim that live scheduling, lease expiry, streams or OS clock handling have already been converted.

## Evidence and rollback

Tests use actual in-memory SQLite, the hash-chained audit and retention implementation, the transport store's independent-floor protocol and the existing directory admission owner. Directory answers, held reads and resource effects are synthetic; there is no LDAP wire, browser, container, backend CLI, real account, Windows or live Fleet operation. Focused tests, compiling guard reversals, source hashes and exact-head CI are recorded separately in the receipt and acceptance.

Reverting the unreferenced helper has no production DB effect. After future activation, markers must remain across audit cleanup and role/assignment removal; rollback must use the separately reviewed forward recovery and downgrade policy, not removal of markers or restoration of an old policy snapshot.
