import { randomUUID } from "node:crypto";

/** Saved shared backend/model values wait for an agent's next start unless this
 * Settings apply explicitly authorizes restarting its currently running owner.
 * Keep this separate from hot config: saving a model is not evidence it ran. */
type Identity = { backend?: string; model?: string };
type Entry = { source: string; owner: object | undefined; desired: Identity; before: Identity; keys: Array<keyof Identity> };
const identity = (c: Identity): Identity => ({ backend: c.backend, model: c.model });
const same = (a: Identity, b: Identity) => a.backend === b.backend && a.model === b.model;

export class SharedDefaultAdoption {
  private entries = new Map<string, Entry>();
  has(name: string): boolean { return this.entries.has(name); }

  private receipts = new Map<string, { expires: number; entries: Map<string, Entry> }>();

  /** Issued synchronously with the confirmed defaults write, before another save
   * can replace its entries. Never mint consent from the later Apply request. */
  receipt(): string {
    const now = Date.now();
    for (const [id, item] of this.receipts) if (item.expires <= now) this.receipts.delete(id);
    while (this.receipts.size >= 256) this.receipts.delete(this.receipts.keys().next().value!);
    const id = randomUUID();
    this.receipts.set(id, { expires: now + 10 * 60_000, entries: new Map(this.entries) });
    return id;
  }

  fromReceipt(id: string | undefined, targets: ReadonlySet<string>): ReadonlySet<object> {
    const item = id ? this.receipts.get(id) : undefined;
    if (id) this.receipts.delete(id);
    if (!item || item.expires <= Date.now()) return new Set();
    return new Set([...item.entries].filter(([name, entry]) => targets.has(name)
      && this.entries.get(name) === entry).map(([, entry]) => entry));
  }

  track(name: string, owner: object | undefined, before: Identity, desired: Identity, source = ""): void {
    if (same(before, desired)) { this.entries.delete(name); return; }
    this.entries.set(name, { source, owner, before: identity(before), desired: identity(desired),
      keys: (["backend", "model"] as const).filter(k => before[k] !== desired[k]) });
  }

  /** Capture consent for these exact saved values and runtime owners, not later saves. */
  consent(targets?: ReadonlySet<string>): ReadonlySet<object> {
    return new Set([...this.entries].filter(([name]) => !targets || targets.has(name)).map(([, entry]) => entry));
  }

  view<T extends Identity>(name: string, owner: object | undefined, desired: T,
    consent?: ReadonlySet<object>, source = "", ownerIdentity?: Identity): { config: T; deferred: boolean } {
    const entry = this.entries.get(name);
    if (!entry) return { config: desired, deferred: false };
    // A replacement runtime cannot inherit consent. If its snapshot still has
    // the old identity, keep deferring; an adopted identity needs no restart.
    // An explicit per-agent edit replaces the shared choice.
    if (entry.owner !== owner && entry.source === source && same(entry.desired, desired)) {
      if (owner && !same(ownerIdentity ?? entry.before, desired)) {
        this.track(name, owner, ownerIdentity ?? entry.before, desired, source);
        return this.view(name, owner, desired, undefined, source, ownerIdentity);
      }
      this.entries.delete(name);
      return { config: desired, deferred: false };
    }
    if (entry.source !== source || !same(entry.desired, desired)) {
      this.entries.delete(name);
      return { config: desired, deferred: false };
    }
    if (owner && consent?.has(entry)) return { config: desired, deferred: false };
    const config = { ...desired };
    for (const key of entry.keys) {
      if (entry.before[key] === undefined) delete config[key];
      else config[key] = entry.before[key];
    }
    return { config, deferred: true };
  }
}
