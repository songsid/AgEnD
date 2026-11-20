/** Reuses Connect-account's bounded session, current-owner proof and shared writer lock. */
import { StructuredSignIn, type SignInAction, type StructuredSignInView } from "./structured-signin.js";
import type { LoginWindowClaim, LoginWindowLock } from "./login-window-lock.js";
import { ClaudeCredentialError, type ClaudeCredentialMetadata, type CredentialActor } from "./claude-credential-vault.js";
import { createClaudeSetupTokenTransport, type SetupTokenTransport } from "./claude-setup-token-transport.js";

export type SetupTokenRequest =
 | { operation: "start"; profile: string | null; revision: number; restart?: boolean; consumersRevision?: string }
 | { operation: "read" | "cancel"; id: string }
 | { operation: "input"; id: string; revision: number; action: SignInAction };
export type SetupTokenView = { login: StructuredSignInView; credential?: ClaudeCredentialMetadata; pending?: string[]; started?: string };
export type SetupTokenOwner = { handle: string; actor: CredentialActor; current(): boolean };
type TokenRun = { owner: SetupTokenOwner; profile: string | null; revision: number; session: StructuredSignIn; result?: { credential: ClaudeCredentialMetadata; pending: string[] } };
export class ClaudeSetupTokens {
 private run: TokenRun | null = null;
 constructor(private readonly deps: {
  lock: LoginWindowLock;
  metadata(profile: string | null): ClaudeCredentialMetadata | null;
  transport?(): SetupTokenTransport;
  commit(profile: string | null, revision: number, token: string, actor: CredentialActor, confirmation: { restart?: boolean; consumersRevision?: string }, current: () => boolean, claim: LoginWindowClaim): Promise<{ credential: ClaudeCredentialMetadata; pending: string[] }>;
 }) {}
 private same(owner: SetupTokenOwner): boolean { return !!this.run && this.run.owner.handle === owner.handle && JSON.stringify(this.run.owner.actor) === JSON.stringify(owner.actor) && owner.current(); }
 private view(owner: SetupTokenOwner): SetupTokenView {
  if (!this.same(owner)) throw new ClaudeCredentialError("session-changed");
  const run = this.run!; return { login: run.session.view(run.owner), ...(run.result ? { credential: run.result.credential, pending: run.result.pending } : {}) };
 }
 async operation(owner: SetupTokenOwner, request: SetupTokenRequest): Promise<SetupTokenView> {
  if (!owner.current()) throw new ClaudeCredentialError("session-changed");
  if (request.operation === "start") {
   const prior = this.run?.session.view(this.run.owner);
   if (prior && prior.phase !== "done" && !(prior.phase === "failed" && prior.reason)) {
    if (!this.same(owner) || this.run!.profile !== request.profile || this.run!.revision !== request.revision) throw new ClaudeCredentialError("in-use");
    return this.view(owner);
   }
   if (prior?.reason === "cleanup_failed") throw new ClaudeCredentialError("unavailable");
   if ((this.deps.metadata(request.profile)?.revision ?? 0) !== request.revision) throw new ClaudeCredentialError("conflict");
   const transport = this.deps.transport?.() ?? createClaudeSetupTokenTransport();
   let launched = false, signal: AbortSignal | undefined, ownClaim: LoginWindowClaim | null = null;
   const run: TokenRun = { owner, profile: request.profile, revision: request.revision, session: null! };
   const current = () => this.run === run && owner.current() && !signal?.aborted && (!ownClaim || this.deps.lock.isCurrent(ownClaim));
   run.session = new StructuredSignIn("claude-code", owner, {
    lock: this.deps.lock, current,
    transport: { ...transport, start: async (spec, abortSignal) => { signal = abortSignal; launched = true; await transport.start(spec, abortSignal); } },
    checkAuth: async () => {
     if (!launched) { ownClaim=this.deps.lock.heldFor("claude-code"); if(!ownClaim||ownClaim.kind!=="web")throw new ClaudeCredentialError("in-use"); return "invalid"; }
     const status=await transport.status();
     if(status.alive||status.exitCode!==0)return "invalid";
     let token = transport.takeToken();
     if (!token) return "invalid";
     try {
      await transport.close();
      const claim = ownClaim;
      if (!current() || !claim || claim.kind !== "web") throw new ClaudeCredentialError("session-changed");
      run.result = await this.deps.commit(request.profile, request.revision, token, owner.actor, request, current, claim);
      return "valid";
     } finally { token = null; }
    },
   });
   this.run = run;
   await run.session.start();
   return { ...this.view(owner), started: run.session.id };
  }
  if (!this.same(owner) || this.run!.session.id !== request.id) throw new ClaudeCredentialError("session-changed");
  if (request.operation === "cancel") await this.run!.session.cancel();
  if (request.operation === "input") {
   const result = await this.run!.session.action(this.run!.owner, request.id, request.revision, request.action);
   if (result !== "accepted") throw new ClaudeCredentialError(result === "invalid" ? "invalid" : "conflict");
  }
  return this.view(owner);
 }
 async close(): Promise<void> { if (this.run) await this.run.session.cancel(); }
}
