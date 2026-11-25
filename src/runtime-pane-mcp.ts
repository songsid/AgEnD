import type { RequestContextRegistrationGate, RequestContextDrainView } from "./request-context-fence.js";
import { validateRuntimePaneSnapshot, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
/** Coordinator authority for a persistent pane. Durable call identities survive reconnects without replaying tools. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { runtimeJobDigest } from "./runtime-client-store.js";
import { validatePaneMcpBody, validatePaneMcpOwner, samePaneMcpOwner, type PaneMcpBody, type PaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import { OUTBOUND_TOOL_SCHEMAS, withComposites, expandCompositeCall } from "./channel/mcp-tools.js";
import { redactDiagnostics } from "./diagnostic-redaction.js";
import { validateRequestContextCallStamp, type RequestContextCallStamp } from "./request-context-call-protocol.js";
import type { RequestContextCallLease, RequestContextCallAdmission } from "./request-context-call.js";
import type { RequestContextCallReference } from "./request-context-pane.js";
interface ToolMenu { name: string; [key: string]: unknown }
interface Call { digest: string; operationId: string; responseId: string; state: "prepared" | "done" | "written"; requestContext?: CallContextReference }
interface CallContextReference { stampSha256: string; coverage: "covered" | "not-covered"; contextId?: string; rootContextId?: string; proofSha256?: string; reason?: "interrupted-launch" | "unbound-input" }
export type PaneRequestContextAdmission = RequestContextCallAdmission;
function validCallContext(raw: unknown): raw is CallContextReference {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as CallContextReference;
  const digest = (s: unknown): boolean => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  const id = (s: unknown): boolean => typeof s === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
  return digest(value.stampSha256) && (value.coverage === "covered"
    ? Object.keys(value).every(key => ["stampSha256", "coverage", "contextId", "rootContextId", "proofSha256"].includes(key))
      && id(value.contextId) && id(value.rootContextId) && digest(value.proofSha256)
    : value.coverage === "not-covered" && Object.keys(value).every(key => ["stampSha256", "coverage", "reason"].includes(key))
      && ["interrupted-launch", "unbound-input"].includes(String(value.reason)));
}
interface Ledger { version: 1; machineId: string; owner: PaneMcpOwner; calls: Record<string, Call> }
export interface PaneToolFailure { tool: string; operationId: string; reason: string; code: string | number | null }
export interface PaneMcpAuthority {
  registration?: RequestContextRegistrationGate;
  machineId: string;
  owner: PaneMcpOwner;
  /** Immutable ceiling from the durable launch; live policy may only narrow it. */
  toolCeiling: readonly string[];
  /** Bound to the daemon/launch identity and dynamic config; never a cached permission set. */
  current(): boolean;
  menu(): ToolMenu[];
  allowed(tool: string, args: Record<string, unknown>): boolean;
  invoke(input: { tool: string; args: Record<string, unknown>; operationId: string; requestContext?: PaneRequestContextAdmission }, current: () => boolean): Promise<{ result: unknown; error?: string; errorCode?: string | number }>;
  /** Internal covered-proof resolver; absent in production until end-to-end cutover. */
  requestContexts?: { resolve(owner: PaneMcpOwner, stamp: RequestContextCallStamp): { lease: RequestContextCallLease; reference: RequestContextCallReference } };
  toolFailed?(details: PaneToolFailure): void;
  responseWritten(operationId: string): void;
  /** Stable authenticated connection generation, distinct from one RPC's short-lived current() fence. */
  transportEpoch?(): string | null;
}
const errorResult = (text: string): Record<string, unknown> => ({ content: [{ type: "text", text }], isError: true });
/** One ledger per exact pane launch; no plaintext arguments, result, provider credential or user input is persisted. */
export class PaneMcpAuthorityLease {
  private ledger: Ledger;
  private readonly toolCeiling: ReadonlySet<string>;
  private closed = false;
  private retired=false;
  private drainSerial=0;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly results = new Map<string, unknown>();
  private presence: { at: number; epoch: string } | undefined;
  constructor(private file: string, readonly authority: PaneMcpAuthority) {
    validatePaneMcpOwner(authority.owner);
    this.toolCeiling = new Set(authority.toolCeiling);
    this.ledger = { version: 1, machineId: authority.machineId, owner: { ...authority.owner }, calls: {} };
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw Error("Unsafe pane tool ledger");
      const raw = JSON.parse(readFileSync(file, "utf8")) as Ledger;
      if (raw?.version !== 1 || raw.machineId !== authority.machineId || !samePaneMcpOwner(validatePaneMcpOwner(raw.owner), authority.owner)
        || !raw.calls || typeof raw.calls !== "object" || Array.isArray(raw.calls) || Object.keys(raw.calls).length > 65_536
        || Object.entries(raw.calls).some(([key, row]) => !/^[a-f0-9]{64}$/.test(key) || !row || !/^[a-f0-9]{64}$/.test(row.digest)
          || !/^[a-f0-9]{64}$/.test(row.responseId) || !/^[a-f0-9-]{36}$/i.test(row.operationId) || !["prepared", "done", "written"].includes(row.state)
          || row.requestContext !== undefined && !validCallContext(row.requestContext))) throw Error("Pane tool ledger scope differs");
      this.ledger = raw;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  close(): void { this.closed = true; this.results.clear(); this.presence = undefined; this.drainSerial++; }
  get drainRevision():string{return String(this.drainSerial);}
  drainView(rootId:string):RequestContextDrainView {
    const references:string[]=[];let unknown=false;
    if(!this.retired)for(const row of Object.values(this.ledger.calls)){
      if(row.requestContext?.coverage!=="covered")unknown=true;
      else if(row.requestContext.rootContextId===rootId)references.push(`pane-ledger:${this.authority.owner.launchId}:${row.operationId}`);
    }
    return {registration:this.authority.registration??null,revision:this.drainRevision,references,unknown};
  }
  retire(raw:RuntimePaneSnapshot):void {
    const exit=validateRuntimePaneSnapshot(raw),owner=this.authority.owner;
    if(exit.state!=="exited"||!samePaneMcpOwner(exit,owner))throw Error("Pane ledger retirement requires its owned exit");
    this.retired=true;this.close();
  }
  /** A retained helper must re-prove itself on the current transport after reconnect. No PID guessing. */
  serving(): boolean {
    const presence = this.presence;
    return !!presence && performance.now() - presence.at < 15_000 && !this.closed && this.authority.current()
      && this.authority.transportEpoch?.() === presence.epoch;
  }
  private current(transport: () => boolean): boolean { return !this.closed && transport() && this.authority.current(); }
  private allowed(tool: string, args: Record<string, unknown>): boolean { return this.toolCeiling.has(tool) && this.authority.allowed(tool, args); }
  private save(): void { atomicWriteFileSync(this.file, JSON.stringify(this.ledger), { mode: 0o600 }); }
  private key(body: Extract<PaneMcpBody, { method: "tools/call" | "response-written" }>): string {
    return createHash("sha256").update(JSON.stringify([body.helperId, body.callId])).digest("hex");
  }
  async handle(machineId: string, raw: unknown, transport: () => boolean, rawStamp?: unknown): Promise<unknown> {
    const body = validatePaneMcpBody(raw);
    let admission: PaneRequestContextAdmission | undefined, reference: CallContextReference | undefined;
    let receiptStampSha256: string | undefined;
    if (rawStamp !== undefined && !this.authority.requestContexts) throw Error("Originating-call protocol not negotiated");
    if (this.authority.requestContexts && body.method !== "presence" && body.method !== "tools/list") {
      const stamp = validateRequestContextCallStamp(rawStamp), stampSha256 = runtimeJobDigest(stamp);
      if (body.method === "response-written") {
        // An ACK grants no execution. Match the durable original row, even after its turn/proof has retired.
        receiptStampSha256 = stampSha256;
      } else if (stamp.coverage === "covered") {
        const captured = this.authority.requestContexts.resolve(body.owner, stamp);
        admission = { coverage: "covered", lease: captured.lease };
        reference = { stampSha256, coverage: "covered", ...captured.reference };
      } else {
        admission = { coverage: "not-covered", reason: stamp.reason };
        reference = { stampSha256, coverage: "not-covered", reason: stamp.reason };
      }
    }
    const captured = admission;
    const current = (): boolean => this.current(transport) && (captured?.coverage !== "covered" || captured.lease.current());
    if (machineId !== this.authority.machineId || !samePaneMcpOwner(body.owner, this.authority.owner) || !current()) throw Error("Pane tool owner is no longer current");
    if (body.method === "presence") {
      const epoch = this.authority.transportEpoch?.(); if (!epoch) throw Error("Pane helper transport identity is unavailable");
      this.presence = { at: performance.now(), epoch }; return { result: { ok: true } };
    }
    if (body.method === "tools/list") return { result: { tools: withComposites(this.authority.menu().filter(tool => this.toolCeiling.has(tool.name))) } };
    const key = this.key(body), previous = this.ledger.calls[key];
    // Compare BEFORE cached/in-flight results and response-written receipts. A legacy row never acquires a context.
    if (previous && (body.method === "response-written" && receiptStampSha256 !== undefined
      ? previous.requestContext?.stampSha256 !== receiptStampSha256
      : runtimeJobDigest(previous.requestContext ?? null) !== runtimeJobDigest(reference ?? null))) throw Error("Pane tool identity has different originating context");
    if (body.method === "response-written") {
      if (!previous || previous.state === "prepared" || previous.responseId !== body.responseId) throw Error("Pane tool response receipt differs");
      if (previous.state !== "written") {
        previous.state = "written"; this.save();this.drainSerial++;
        // ACK is already written durably before delivery evidence is published. Replays can never dispatch a tool.
        this.authority.responseWritten(previous.operationId);
      }
      this.results.delete(key);
      return { result: { ok: true } };
    }
    // M-2133: a composite (web_appearance, emoji_sticker) is its action's tool for every check below.
    const expanded = expandCompositeCall(body.params.name, body.params.arguments);
    if ("error" in expanded) return { result: errorResult(expanded.error) };
    const { name: tool, args } = expanded;
    if (!this.allowed(tool, args)) throw Error("Pane tool access was revoked");
    const parsed = OUTBOUND_TOOL_SCHEMAS.get(tool)?.safeParse(args);
    if (!parsed?.success) return { result: errorResult("Invalid tool arguments") };
    const checked = parsed.data as Record<string, unknown>, digest = runtimeJobDigest({ tool, args: checked });
    if (previous && previous.digest !== digest) throw Error("Pane tool identity has different arguments");
    if (previous) {
      if (this.inFlight.has(key)) return this.inFlight.get(key)!;
      if (this.results.has(key)) return { result: this.results.get(key), responseId: previous.responseId };
      // A restart or acknowledged call retains its identity, never replays a mutation to manufacture another result.
      return { result: errorResult(`Tool outcome is retained and will not be repeated. Inspect operation ${previous.operationId}.`) };
    }
    if (this.inFlight.size >= 32 || this.results.size >= 64 || Object.keys(this.ledger.calls).length >= 65_536) throw Error("Pane tool receipt backlog or ledger capacity reached");
    const call: Call = { digest, operationId: randomUUID(), responseId: randomBytes(32).toString("hex"), state: "prepared", ...(reference ? { requestContext: reference } : {}) };
    if(admission?.coverage==="covered")this.authority.registration?.assertRegistration(admission.lease.snapshot.context.ref.rootContextId);
    this.ledger.calls[key] = call; this.drainSerial++;
    try { this.save(); } catch (error) { delete this.ledger.calls[key];this.drainSerial++; throw error; }
    const allowed = (): boolean => current() && this.allowed(tool, checked);
    const run = Promise.resolve().then(async () => {
      if (!allowed()) throw Error("Pane tool permission was revoked before dispatch");
      let response: Record<string, unknown>;
      try {
        const value = await this.authority.invoke({ tool, args: checked, operationId: call.operationId, ...(admission ? { requestContext: admission } : {}) }, allowed);
        if (value.error) {
          // No args, reply bodies or raw provider errors in diagnostics. Redact BEFORE truncating so a
          // credential cannot survive as a partial token. An absent lower-level code stays explicitly unknown.
          const reason = value.error.length > 65_536 ? "Tool failure reason exceeded the diagnostic limit"
            : redactDiagnostics(value.error).replace(/[\r\n]+/g, " ").slice(0, 1000);
          const code = typeof value.errorCode === "number" && Number.isSafeInteger(value.errorCode) ? value.errorCode
            : typeof value.errorCode === "string" ? (value.errorCode.length > 4096 ? "[REDACTED]" : redactDiagnostics(value.errorCode)).slice(0, 80) : null;
          try { this.authority.toolFailed?.({ tool, operationId: call.operationId, reason, code }); } catch { /* Logging cannot change a settled tool outcome. */ }
          response = errorResult(`AgEnD tool operation failed: ${reason}${code === null ? "" : ` (code: ${code})`}. Inspect operation ${call.operationId} before retrying.`);
          response.structuredContent = { error: { reason, code, operationId: call.operationId } };
        }
        else {
          const text = typeof value.result === "string" ? value.result : JSON.stringify(value.result);
          response = text === undefined ? errorResult("AgEnD returned no tool result") : { content: [{ type: "text", text }] };
          if (Buffer.byteLength(JSON.stringify(response)) > 128 * 1024) response = errorResult(`Tool result exceeds the pane response limit. Inspect operation ${call.operationId}; do not repeat an uncertain mutation.`);
        }
      } catch { response = errorResult(`Tool outcome is unconfirmed. Inspect operation ${call.operationId}; do not repeat it.`); }
      call.state = "done"; this.save();this.drainSerial++;
      this.results.set(key, response);
      if (!allowed()) throw Error("Pane tool lease expired before returning its result");
      return { result: response, responseId: call.responseId };
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, run);
    return run;
  }
}
