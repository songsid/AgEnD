/**
 * M-3533 R2b: this Fleet's shared agents' pictures for the Hub's room offices (agent-pictures-model.ts). Each published share
 * reports its disc (what the owner's sidebar shows for it) and its identity-card portrait. A PNG is reduced to the square the
 * Fleet shows; another type goes as it is when it fits. Over its cap a picture is left out and reported as too large. The
 * sources are read every few seconds by a cheap key (a file's version); bytes are read and reduced only when a key changes.
 */
import { createHash, randomUUID } from "node:crypto";
import type { HubMemberLink } from "../client.js";
import { HUB_LIMITS } from "../protocol.js";
import {
  agentPictureResultSchema, agentPicturesResultSchema, characterSetBytes, HUB_AGENT_CHARACTERS_CAPABILITY, HUB_AGENT_PICTURES_CAPABILITY, HUB_PICTURE_AGENT_MAX, HUB_PICTURE_CHUNK,
  HUB_PICTURE_DISC_MAX, sniffPicture, type HubAgentPicturesRow, type HubCharacterSet, type HubPictureMime, type HubPictureOmitted, type HubPictureRef, type HubPictureSlot,
} from "../agent-pictures-model.js";
import type { CharacterCrop, PictureReduce } from "../../hub-picture-reduce.js";
import type { CharacterPlan } from "../../hub-character-plan.js";

/** A picture as the Fleet has it: `key` changes whenever the bytes would (a version, a content id); `load` reads them. */
export interface MemberPictureSource { key: string; load(): { bytes: Buffer } | null }
/**
 * M-3533 R2c: the agent's own character (hub-character-plan.ts): `key` changes whenever its pack, its set or the agent's office
 * would change what is cut; `load` gives the plan and its pack pictures by `src`.
 */
export interface MemberCharacterSource { key: string; load(): { plan: CharacterPlan; pictures: ReadonlyMap<string, Uint8Array> } | null }
export interface MemberPictureSources { disc: MemberPictureSource | null; portrait: MemberPictureSource | null; character?: MemberCharacterSource | null }
interface Prepared { bytes: Buffer; ref: HubPictureRef }
/** null: no readable picture; "too-large": over every cap (never kept in memory). */
type Made = Prepared | "too-large" | null;
/** A character cut and hashed: its set as the report names it and each picture's bytes; null: none that can be sent. */
type MadeCharacter = { set: HubCharacterSet; bytes: Map<string, Prepared> } | "too-large" | null;

export const MEMBER_PICTURES_POLL_MS = 5_000;
/**
 * M-3533 R2c (Prism #4421): what one `agent.pictures` frame may take, serialized — the link refuses a frame over
 * HUB_LIMITS.frame (256 KiB), and a refused report would be sent unchanged on every tick. Room for its envelope.
 */
export const MEMBER_PICTURES_REPORT_MAX = HUB_LIMITS.frame - 4 * 1024;
/**
 * The report fitted into one frame: every row keeps its disc and portrait (a report replaces the Fleet's rows, so none may
 * be left out); characters, whole, are left out from the last row back until the frame fits. Such a set is not "too large"
 * (the agent's own cap is not why): it is sent when the report has room again.
 */
export function fitReport(rows: HubAgentPicturesRow[], size: (rows: HubAgentPicturesRow[]) => number, max = MEMBER_PICTURES_REPORT_MAX): HubAgentPicturesRow[] {
  const out = rows.slice();
  for (let i = out.length - 1; i >= 0 && size(out) > max; i--) if (out[i]!.character) { const { character: _c, ...rest } = out[i]!; out[i] = rest; }
  return out;
}

export class HubMemberAgentPictures {
  private link: HubMemberLink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private sent: string | null = null;
  private stopped = false;
  /** Prepared pictures by source key and slot; only the keys in use are kept. */
  private made = new Map<string, Made>();
  private characters = new Map<string, MadeCharacter>();
  constructor(private readonly options: {
    current(): boolean;
    /** The published shares: exposure id and the agent behind it. */
    exposures(): Array<{ id: string; agent: string }>;
    sources(agent: string): MemberPictureSources;
    reduce: PictureReduce;
    /** M-3533 R2c: cuts a character's poses (cropInWorker); none: characters are not sent. */
    crop?: CharacterCrop;
    failed?(): void;
  }) {}
  connected(link: HubMemberLink | null): void {
    if (!link) { this.disconnected(); return; }
    if (this.stopped || !this.options.current() || !link.current() || !link.features.has(HUB_AGENT_PICTURES_CAPABILITY)) return;
    this.link = link; this.sent = null;
    if (!this.timer) { this.timer = setInterval(() => { void this.refresh(); }, MEMBER_PICTURES_POLL_MS); this.timer.unref?.(); }
    void this.refresh();
  }
  disconnected(): void { this.link = null; this.sent = null; if (this.timer) clearInterval(this.timer); this.timer = null; }
  close(): void { this.stopped = true; this.disconnected(); this.made.clear(); this.characters.clear(); }

  refresh(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.flush().catch(() => { try { this.options.failed?.(); } catch { /* diagnostic only */ } }).finally(() => { this.running = null; });
    return this.running;
  }

  /** A picture's cache entry is its agent's, its slot's and its source's (Prism #4393: two agents' sources may share a key). */
  private static cacheKey(agent: string, slot: HubPictureSlot, key: string): string { return JSON.stringify([agent, slot, key]); }
  private async prepare(agent: string, key: string, slot: HubPictureSlot, source: MemberPictureSource): Promise<Made> {
    const cacheKey = HubMemberAgentPictures.cacheKey(agent, slot, key);
    if (this.made.has(cacheKey)) return this.made.get(cacheKey)!;
    let made: Made = null;
    const raw = source.load()?.bytes ?? null;
    const mime = raw ? sniffPicture(raw) : null;
    if (raw && mime) {
      const small = mime === "image/png" ? await this.options.reduce(raw, slot) : null;
      const bytes = small && small.length <= raw.length ? small : raw;
      const type: HubPictureMime = bytes === small ? "image/png" : mime;
      made = bytes.length > (slot === "disc" ? HUB_PICTURE_DISC_MAX : HUB_PICTURE_AGENT_MAX) ? "too-large"
        : { bytes, ref: { sha256: createHash("sha256").update(bytes).digest("hex"), mime: type, size: bytes.length } };
    }
    this.made.set(cacheKey, made);
    return made;
  }

  /**
   * M-3533 R2c: the character cut (each pose its PNG), hashed. A picture the pack cannot give or that does not cut (not a
   * PNG, unreadable): null — never an uncut sheet. Over the agent's whole cap on its own: "too-large".
   */
  private async prepareCharacter(agent: string, source: MemberCharacterSource): Promise<MadeCharacter> {
    const cacheKey = JSON.stringify([agent, "character", source.key]);
    if (this.characters.has(cacheKey)) return this.characters.get(cacheKey)!;
    let made: MadeCharacter = null;
    const loaded = this.options.crop ? source.load() : null;
    const cut = loaded && loaded.plan.sources.every(src => { const b = loaded.pictures.get(src); return !!b && sniffPicture(b) === "image/png"; })
      ? await this.options.crop!(loaded.pictures, Object.values(loaded.plan.poses).map(p => p!.cut)) : null;
    if (loaded && cut) {
      const set: HubCharacterSet = {}, bytes = new Map<string, Prepared>();
      for (const [pose, p] of Object.entries(loaded.plan.poses)) {
        const png = cut.get(pose);
        if (!png || !p) { set[pose as keyof HubCharacterSet] = undefined; continue; }
        const ref: HubPictureRef = { sha256: createHash("sha256").update(png).digest("hex"), mime: "image/png", size: png.length };
        bytes.set(ref.sha256, { bytes: png, ref });
        set[pose as keyof HubCharacterSet] = { ...ref, mime: "image/png", ...p.meta };
      }
      const whole = Object.keys(loaded.plan.poses).every(pose => !!set[pose as keyof HubCharacterSet]);
      made = !whole ? null : characterSetBytes(set) > HUB_PICTURE_AGENT_MAX ? "too-large" : { set, bytes };
    }
    this.characters.set(cacheKey, made);
    return made;
  }

  private async flush(): Promise<void> {
    const link = this.link;
    const live = () => !this.stopped && this.link === link && !!link?.current() && this.options.current();
    if (!link || !live()) return;
    const shares = this.options.exposures().slice().sort((a, b) => a.id.localeCompare(b.id));
    // M-3533 R2c: characters only to a Hub that offered them (an older Hub's strict row refuses the field).
    const characters = !!this.options.crop && link.features.has(HUB_AGENT_CHARACTERS_CAPABILITY);
    const keyed = shares.map(s => { const src = this.options.sources(s.agent);
      return { ...s, src, key: [src.disc?.key ?? null, src.portrait?.key ?? null] as const, character: characters ? src.character ?? null : null }; });
    const signature = JSON.stringify(keyed.map(k => [k.id, k.agent, ...k.key, k.character?.key ?? null]));
    if (signature === this.sent) return;
    // Forget pictures no share uses now.
    const inUse = new Set(keyed.flatMap(k => [k.key[0] !== null ? HubMemberAgentPictures.cacheKey(k.agent, "disc", k.key[0]) : "", k.key[1] !== null ? HubMemberAgentPictures.cacheKey(k.agent, "portrait", k.key[1]) : ""]));
    for (const k of [...this.made.keys()]) if (!inUse.has(k)) this.made.delete(k);
    const charactersInUse = new Set(keyed.filter(k => k.character).map(k => JSON.stringify([k.agent, "character", k.character!.key])));
    for (const k of [...this.characters.keys()]) if (!charactersInUse.has(k)) this.characters.delete(k);
    const rows: HubAgentPicturesRow[] = [], bytes = new Map<string, Prepared>();
    for (const k of keyed) {
      const disc = k.src.disc ? await this.prepare(k.agent, k.key[0]!, "disc", k.src.disc) : null;
      const discRef = disc && disc !== "too-large" ? disc : null;
      const portrait = k.src.portrait ? await this.prepare(k.agent, k.key[1]!, "portrait", k.src.portrait) : null;
      // The portrait has what the disc leaves of the agent's 512 KB: the disc is never the one dropped (the design's order).
      const portraitRef = portrait && portrait !== "too-large" && portrait.ref.size <= HUB_PICTURE_AGENT_MAX - (discRef?.ref.size ?? 0) ? portrait : null;
      // M-3533 R2c: the character has what the avatar and portrait leave, whole or not at all (dropped first, Lumen R2c 3).
      const character = k.character ? await this.prepareCharacter(k.agent, k.character) : null;
      const left = HUB_PICTURE_AGENT_MAX - (discRef?.ref.size ?? 0) - (portraitRef?.ref.size ?? 0);
      const characterRef = character && character !== "too-large" && characterSetBytes(character.set) <= left ? character : null;
      const tooLarge: HubPictureOmitted[] = [...(disc === "too-large" ? ["disc" as const] : []), ...(portrait && !portraitRef ? ["portrait" as const] : []),
        ...(character && !characterRef ? ["character" as const] : [])];
      for (const p of [discRef, portraitRef]) if (p) bytes.set(p.ref.sha256, p);
      if (characterRef) for (const [h, p] of characterRef.bytes) bytes.set(h, p);
      rows.push({ exposureId: k.id, disc: discRef?.ref ?? null, portrait: portraitRef?.ref ?? null, ...(characterRef ? { character: characterRef.set } : {}),
        ...(tooLarge.length ? { tooLarge } : {}) });
    }
    if (!live()) return;
    const frameOf = (agents: HubAgentPicturesRow[]) => ({ v: 1 as const, type: "agent.pictures" as const, requestId: randomUUID(), linkEpoch: link.linkEpoch,
      // The rows' own JSON (built in a fixed key order): canonicalArguments caps its input at 64 KiB, which characters exceed.
      payload: { revision: createHash("sha256").update(JSON.stringify(agents)).digest("hex"), agents } });
    const fitted = fitReport(rows, agents => Buffer.byteLength(JSON.stringify(frameOf(agents))));
    const reply = await link.exchange(frameOf(fitted), "agent.pictures-result");
    const result = agentPicturesResultSchema.parse(reply.payload);
    if (!result.ok || !live()) return;
    for (const hash of result.need) {
      const p = bytes.get(hash);
      if (!p) continue;
      const count = Math.ceil(p.bytes.length / HUB_PICTURE_CHUNK);
      for (let index = 0; index < count; index++) {
        if (!live()) return;
        const data = p.bytes.subarray(index * HUB_PICTURE_CHUNK, (index + 1) * HUB_PICTURE_CHUNK).toString("base64");
        const answer = await link.exchange({ v: 1, type: "agent.picture", requestId: randomUUID(), linkEpoch: link.linkEpoch,
          payload: { sha256: hash, mime: p.ref.mime, size: p.bytes.length, index, count, data } }, "agent.picture-result");
        const got = agentPictureResultSchema.parse(answer.payload);
        // Refused: the report is sent again on the next tick (nothing is marked sent).
        if (!got.ok) return;
      }
    }
    if (live()) this.sent = signature;
  }
}
