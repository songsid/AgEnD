/**
 * S3c PR B (S-55): the member's "Connect to a Hub" backend — thin, local-admin wrappers over S1's pairing client
 * (pairing-client.ts beginHubPairing / claimHubPairing, profile.ts HubMemberProfileStore), as Sentinel specified:
 * - The projection says only what is known: paired (from the profile: the Hub key's spkiSha256, its origins; no stored
 *   name; the link from S5's client lifecycle, else offline), pending (the transcript fingerprint and expiry; the Hub
 *   owner's and administrator's confirmations are the Hub's and unknown here: null), held (a local fact), unpaired.
 *   Never key_changed or revoked inferred from an I/O failure; missing or malformed private state holds, never reads as
 *   unpaired.
 * - The local owner's own fingerprint check is a separate private receipt (localConfirmed), never ownerConfirmed. Its
 *   continuation claims, and claims again only after an exact "pending", within the same generation, fingerprint,
 *   profile digest and expiry — bounded and sequential. Any unknown claim outcome stops and holds (no retry).
 * - cancel invalidates the in-flight generation first, then clears the local pending (no Hub cancellation).
 * - disconnect fences the client, saves a local tombstone (the profile is kept: S1 has no revoke; S5 refuses to
 *   reconnect from a disconnected binding), withdraws every exposure, and answers remote "pending" until the Hub's
 *   administrator revokes the fleet there.
 * State: hub-member/state.json (0600, atomic): { hubId, localConfirmed?, held?, disconnected? }.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.js";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "../private-files.js";
import { beginHubPairing as realBegin, claimHubPairing as realClaim } from "../pairing-client.js";
import { HubMemberProfileStore } from "../profile.js";
import { httpsOrigin, type HubConnectError, type HubPairingHold, type HubPairingView } from "./pairing-summary.js";
export { httpsOrigin, pairingSummary } from "./pairing-summary.js";

export type { HubConnectError, HubPairingHold, HubPairingView } from "./pairing-summary.js";
interface MemberState { hubId?: string; localConfirmed?: { digest: string; at: number }; held?: HubPairingHold; disconnected?: { at: number };
  /** Bindings disconnected and started over: never reconnected automatically (their profiles are kept: S1 has no revoke). */
  retired?: Array<{ hubId: string; profile: string | null }> }

const STATE = "hub-member/state.json";
const HUB_ID = /^[0-9a-f-]{36}$/;
/** The code's shape S1 accepts (pairing-client.ts): checked here only to say "code" rather than "refused". */
const CODE = /^[a-f0-9]{12}$/;

export interface HubMemberPairingDeps {
  home: string;
  /** S5's client lifecycle (absent: offline). */
  link?(): "online" | "offline";
  /** A composition hold (S5), if any. */
  hold?(): HubPairingHold | null;
  /** S5: stop and fence the member client now (synchronous). */
  fence?(): void;
  /** S3c: withdraw every exposure locally (saved before it returns). */
  withdrawAll?(): Promise<void> | void;
  now?(): number;
  pollMs?: number; maxPolls?: number;
  sleep?(ms: number): Promise<void>;
  begin?: typeof realBegin; claim?: typeof realClaim;
  profiles?(home: string, hubId: string): Pick<HubMemberProfileStore, "readProfile" | "readPending" | "profileDigest" | "clearPending">;
}

export function createHubMemberPairingApi(deps: HubMemberPairingDeps) {
  const now = () => (deps.now ?? Date.now)();
  const begin = deps.begin ?? realBegin, claim = deps.claim ?? realClaim;
  const profiles = deps.profiles ?? ((home: string, hubId: string) => new HubMemberProfileStore(home, hubId));
  let generation = 0;
  const read = (): MemberState => {
    if (!existsSync(join(deps.home, STATE))) return {};
    const s = JSON.parse(readPrivateFile(deps.home, STATE)) as MemberState;      // malformed: throws (held "unsaved")
    if (!s || typeof s !== "object" || (s.hubId !== undefined && !HUB_ID.test(s.hubId))) throw new Error("state");
    return s;
  };
  const write = (s: MemberState) => {
    const dir = ensurePrivateDirectory(deps.home, "hub-member");
    if (existsSync(join(deps.home, STATE))) privatePath(deps.home, STATE);          // an existing one: owned, private, no symlink
    atomicWriteFileSync(join(dir, "state.json"), `${JSON.stringify(s)}\n`, { mode: 0o600 });
  };
  const files = (hubId: string) => ({ pairing: existsSync(join(deps.home, "hub-member", hubId, "pairing.json")), pending: existsSync(join(deps.home, "hub-member", hubId, "pending.json")) });

  function view(): HubPairingView {
    let s: MemberState;
    try { s = read(); } catch { return { state: "held", hold: "unsaved" }; }
    if (!s.hubId) {
      // No state yet: a member home with Hub files but no state is not "unpaired" (held), an empty one is.
      let dirs: string[] = [];
      try { dirs = existsSync(join(deps.home, "hub-member")) ? readdirSync(join(deps.home, "hub-member")).filter((d) => HUB_ID.test(d) && !(s.retired ?? []).some((r) => r.hubId === d) && (files(d).pairing || files(d).pending)) : []; } catch { return { state: "held", hold: "unsaved" }; }
      return dirs.length ? { state: "held", hold: "unsaved" } : { state: "unpaired" };
    }
    const store = profiles(deps.home, s.hubId), f0 = files(s.hubId);
    // A retired binding's own profile (unchanged since it was retired) is not this pairing's: as if absent.
    let retiredProfile = false;
    try { const r = (s.retired ?? []).find((x) => x.hubId === s.hubId); retiredProfile = !!r && f0.pairing && store.profileDigest() === r.profile; } catch { return { state: "held", hold: "unsaved" }; }
    const f = { pairing: f0.pairing && !retiredProfile, pending: f0.pending };
    let origin: string | undefined;
    try {
      if (f.pairing) {
        const p = store.readProfile();
        origin = p.hub.memberOrigin;
        if (s.disconnected) return { state: "held", hold: "disconnected", memberOrigin: origin };
        const held = s.held ?? deps.hold?.() ?? null;
        if (held) return { state: "held", hold: held, memberOrigin: origin };
        return { state: "paired", hub: { hubId: p.hub.hubId, name: null, memberOrigin: p.hub.memberOrigin, webOrigin: p.hub.webOrigin, fingerprint: { kind: "hub-key", digest: p.hub.spkiSha256 } },
          link: deps.link?.() === "online" ? "online" : "offline" };
      }
      if (f.pending) {
        const p = store.readPending();
        origin = p.hub.memberOrigin;
        const held = s.held ?? deps.hold?.() ?? (p.expiresAt <= now() ? "expired" : null);
        if (held) return { state: "held", hold: held, memberOrigin: origin };
        return { state: "pending", memberOrigin: origin, fingerprint: { kind: "pairing", digest: p.fingerprint }, expiresAt: p.expiresAt, ownerConfirmed: null, adminApproved: null,
          localConfirmed: s.localConfirmed?.digest === p.fingerprint };
      }
    } catch { return { state: "held", hold: "unsaved", ...(origin ? { memberOrigin: origin } : {}) }; }
    if (s.held) return { state: "held", hold: s.held };
    return { state: "unpaired" };
  }

  /** The local owner's claim loop: one generation, exact "pending" only, bounded and sequential; anything else holds. */
  async function poll(gen: number, hubId: string, digest: string, current: () => boolean): Promise<void> {
    const store = profiles(deps.home, hubId), expected = store.profileDigest();
    const live = () => gen === generation && current();
    for (let i = 0; i < (deps.maxPolls ?? 120); i++) {
      if (!live()) return;
      let r: { status: "pending" | "paired" };
      try { r = await claim({ home: deps.home, hubId, approvedFingerprint: digest, expectedProfileDigest: expected, current: live }); }
      catch { if (gen === generation) { try { write({ ...read(), held: "unknown_outcome" }); } catch { /* view() holds on its own */ } } return; }
      if (r.status === "paired") { if (gen === generation) { const s = read(); delete s.localConfirmed; write(s); } return; }
      if (r.status !== "pending") return;
      let pending; try { pending = store.readPending(); } catch { return; }
      if (pending.fingerprint !== digest || pending.expiresAt <= now() || store.profileDigest() !== expected) return;
      await (deps.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))))(deps.pollMs ?? 5000);
    }
  }

  return {
    view,
    /** Start pairing (a confirmed Settings replay's continuation): S1 persists the pending claim at once. */
    async connect(input: { address: unknown; code: unknown }, current: () => boolean): Promise<{ ok: true; pairing: HubPairingView } | { ok: false; error: HubConnectError }> {
      const origin = typeof input.address === "string" ? httpsOrigin(input.address) : null;
      if (!origin) return { ok: false, error: "address" };
      const code = typeof input.code === "string" ? input.code.trim().toLowerCase().replace(/[\s-]/g, "") : "";
      if (!CODE.test(code)) return { ok: false, error: "code" };
      const v = view();
      if (v.state !== "unpaired") return { ok: false, error: "busy" };
      const gen = ++generation;
      try {
        const p = await begin({ home: deps.home, memberOrigin: origin, code, current: () => gen === generation && current() });
        const prior = read();
        write({ hubId: p.hub.hubId, ...(prior.retired ? { retired: prior.retired } : {}) });
        return { ok: true, pairing: view() };
      } catch (err) {
        const code2 = (err as { code?: string }).code;
        return { ok: false, error: code2 === "conflict" ? "busy" : code2 === "unavailable" ? "unreachable" : "refused" };
      }
    },
    /** The local owner compared the fingerprint (confirmed in Settings): save the receipt, then claim (see poll). */
    async confirmFingerprint(digest: unknown, current: () => boolean): Promise<{ ok: true; pairing: HubPairingView } | { ok: false; error: "conflict" | "expired" | "unsaved" | "refused" }> {
      const v = view();
      if (v.state === "held" && v.hold === "expired") return { ok: false, error: "expired" };
      if (v.state !== "pending" || typeof digest !== "string" || digest !== v.fingerprint.digest) return { ok: false, error: "conflict" };
      const s = read();
      try { write({ ...s, localConfirmed: { digest, at: now() } }); } catch { return { ok: false, error: "unsaved" }; }
      const gen = ++generation;
      void poll(gen, s.hubId!, digest, current);
      return { ok: true, pairing: view() };
    },
    /** Withdraw the local pending request (or clear an expired/refused hold): the in-flight generation first. */
    cancel(): HubPairingView {
      generation++;
      let s: MemberState;
      try { s = read(); } catch { return view(); }
      // Start over after a disconnect: back to unpaired; the old binding stays retired (never reconnected automatically).
      if (s.disconnected && s.hubId) {
        let digest: string | null = null;
        try { digest = profiles(deps.home, s.hubId).profileDigest(); } catch { return view(); }
        write({ retired: [...(s.retired ?? []).filter((r) => r.hubId !== s.hubId), { hubId: s.hubId, profile: digest }] });
        return view();
      }
      if (s.hubId && files(s.hubId).pending) { try { profiles(deps.home, s.hubId).clearPending(); } catch { return view(); } }
      delete s.localConfirmed;
      if (s.held === "expired" || s.held === "refused") delete s.held;
      if (s.hubId && !files(s.hubId).pairing && !s.held) { write(s.retired ? { retired: s.retired } : {}); return view(); }
      write(s);
      return view();
    },
    /** Leave the Hub (a confirmed Settings replay): fence, tombstone, withdraw every exposure; the Hub revokes later. */
    async disconnect(): Promise<{ ok: true; remote: "pending" } | { ok: false; error: "unsaved" | "conflict" }> {
      const v = view();
      if (v.state !== "paired" && !(v.state === "held" && v.hold !== "disconnected" && v.memberOrigin)) return { ok: false, error: "conflict" };
      generation++;
      try { deps.fence?.(); } catch { /* fenced on the tombstone below either way */ }
      try { write({ ...read(), disconnected: { at: now() } }); } catch { return { ok: false, error: "unsaved" }; }
      try { await deps.withdrawAll?.(); } catch { return { ok: false, error: "unsaved" }; }
      return { ok: true, remote: "pending" };
    },
    /** Whether a binding is disconnected (S5 refuses to reconnect from it, even after a restart). */
    disconnected(hubId?: string): boolean {
      try {
        const s = read();
        if (s.disconnected) return true;
        const r = hubId ? (s.retired ?? []).find((x) => x.hubId === hubId) : undefined;
        return !!r && profiles(deps.home, hubId!).profileDigest() === r.profile;
      } catch { return true; }
    },
  };
}

