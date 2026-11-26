/** L's private final-write resolver. Registration is by the owning admission path, never a tool argument. */
import { requestContextDigest } from "./request-context-store.js";
import { RequestContextV1Schema } from "./request-context-protocol.js";
import type { RequestContextV1 } from "./request-context-protocol.js";
import { RequestContextReferenceMap } from "./request-context-fence.js";
import type { RequestContextRegistrationGate } from "./request-context-fence.js";
import type { PreparedRequestContextInput, RequestContextInputProof, RequestContextRuntimeOwner } from "./request-context-turns.js";

interface AdmittedInput {
  readonly context: RequestContextV1;
  readonly proof: RequestContextInputProof;
  /** Must check the actual receipt/attempt, generation and launch immediately under the write lock. */
  current(owner: Readonly<RequestContextRuntimeOwner>, wireSha256: string): boolean;
}
interface Entry {
  admitted: AdmittedInput;
  prepared?: PreparedRequestContextInput;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export class RequestContextInputs {
  private readonly entries = new RequestContextReferenceMap<string, Entry>(
    row => row.admitted.context.ref.rootContextId, (_row, key) => `input:${key}`);
  constructor(registration: RequestContextRegistrationGate, private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw Error("Invalid request input bound");
    this.entries.installRegistration(registration);
  }
  get registrationGate() { return this.entries.registrationGate; }
  get drainRevision() { return this.entries.revision; }
  drainView(rootId: string) { return this.entries.view(rootId); }

  register(inputId: string, input: AdmittedInput): () => void {
    if (!inputId || inputId.length > 512 || /[\x00-\x1f\x7f]/.test(inputId)) throw Error("Invalid admitted input id");
    if (this.entries.has(inputId)) throw Error("Request input already registered");
    if (this.entries.size >= this.capacity) throw Error("Request input backlog is full");
    const context = freeze(RequestContextV1Schema.parse(structuredClone(input.context)));
    const proof = freeze(structuredClone(input.proof));
    const entry: Entry = { admitted: Object.freeze({ context, proof, current: input.current }) };
    this.entries.set(inputId, entry);
    return () => { if (this.entries.get(inputId) === entry) this.entries.delete(inputId); };
  }

  /** Only called by C at its final write, with its final formatted digest and exact owned launch. */
  prepare(inputId: string, wireSha256: string, owner: Readonly<RequestContextRuntimeOwner>): PreparedRequestContextInput | null {
    const entry = this.entries.get(inputId);
    if (!entry) return null;
    const { admitted } = entry;
    if (!/^[a-f0-9]{64}$/.test(wireSha256) || admitted.context.source.instance !== owner.instance
      || admitted.context.source.incarnation !== owner.incarnation || !admitted.current(owner, wireSha256)) {
      throw Error("Admitted request input is no longer current");
    }
    // A formatting retry can never adopt a later launch, proof or wire image under the same input key.
    if (entry.prepared) {
      if (entry.prepared.wireSha256 !== wireSha256 || requestContextDigest(entry.prepared.owner) !== requestContextDigest(owner)) {
        throw Error("Admitted request input changed during retry");
      }
      return entry.prepared;
    }
    const prepared = freeze({ inputId, wireSha256, owner: structuredClone(owner), context: admitted.context, proof: admitted.proof });
    // Re-registering the row bumps its drain revision and rechecks the root fence before publication.
    this.entries.set(inputId, entry);
    entry.prepared = prepared;
    return prepared;
  }
}
