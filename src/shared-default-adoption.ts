/** Saved shared backend/model values wait for an agent's next start unless this
 * Settings apply explicitly authorizes restarting its currently running owner.
 * Keep this separate from hot config: saving a model is not evidence it ran. */
type Identity = { backend?: string; model?: string };
type Entry = { source: string; owner: object | undefined; desired: Identity; before: Identity; keys: Array<keyof Identity> };
const identity = (c: Identity): Identity => ({ backend: c.backend, model: c.model });
const same = (a: Identity, b: Identity) => a.backend === b.backend && a.model === b.model;

export class SharedDefaultAdoption {
  private entries = new Map<string, Entry>();

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
    consent?: ReadonlySet<object>, source = ""): { config: T; deferred: boolean } {
    const entry = this.entries.get(name);
    if (!entry) return { config: desired, deferred: false };
    // A new runtime has adopted the saved values; an explicit agent edit replaces
    // this shared choice. Neither may inherit an earlier apply's consent.
    if (entry.source !== source || entry.owner !== owner || !same(entry.desired, desired)) {
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
