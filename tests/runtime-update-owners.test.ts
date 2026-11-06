/** Private public-metadata rows and inert exact process observations; no native process queries. */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireRuntimeInstallLock, type RuntimeProcessObservation, type RuntimeProcessProof } from "../src/runtime-update-lock.js";
import { RUNTIME_INSTALL_RECEIPT, readRuntimeInstallReceipt } from "../src/runtime-update-install.js";
import { adoptRuntimeInstallOwner, readRuntimeInstallOwner, transferRuntimeInstallOwner, assertRuntimeInstallExclusive, attachRuntimeInstallChild, parseRuntimeInstallOwner, registerRuntimeInstallOwner, releaseRuntimeInstallOwner, type RuntimeInstallOwner } from "../src/runtime-update-owners.js";
const roots: string[] = [], origin = "https://paired.example.test", parent = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) }, child = { ...parent, pid: 123457 };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-install-owners-")); roots.push(root);
  writeFileSync(join(root, RUNTIME_INSTALL_RECEIPT), JSON.stringify({ version: 1, id: randomUUID(), createdAt: 1, revision: 1, origins: [origin], shared: false }), { mode: 0o600 });
  const lock = await acquireRuntimeInstallLock(root, { ownProof: parent }), owner = await registerRuntimeInstallOwner(root, origin, lock);
  return { root, lock, owner, directory: join(root, ".agend-runtime-owners") };
}
const alive = (proof: RuntimeProcessProof): RuntimeProcessObservation => ({ state: "alive", proof });
const gone = async (): Promise<RuntimeProcessObservation> => ({ state: "gone" });
function other(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<RuntimeInstallOwner> = {}) {
  const row = { ...f.owner, id: randomUUID(), parent: { ...parent, pid: 123456 }, ...overrides };
  writeFileSync(join(f.directory, `${row.id}.json`), JSON.stringify(row), { mode: 0o600 }); return row;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("commits only public parent identity before child startup and requires its exact live proof", async () => {
  const f = await fixture();
  try {
    expect(f.owner).toEqual({ version: 1, id: expect.any(String), installId: readRuntimeInstallReceipt(f.root)!.id, origin, parent });
    await assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone);
    await expect(attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => ({ state: "unknown" }))).rejects.toThrow(/unknown/);
    expect(JSON.parse(readFileSync(join(f.directory, `${f.owner.id}.json`), "utf8"))).toEqual(f.owner);
    const running = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child));
    expect(running.child).toEqual(child);
    await expect(releaseRuntimeInstallOwner(f.root, running, f.lock, async () => alive(child))).rejects.toThrow(/owned/);
    await releaseRuntimeInstallOwner(f.root, running, f.lock, gone); expect(readdirSync(f.directory)).toEqual([]);
  } finally { f.lock.release(); }
});
it("a second origin permanently disables exclusivity even after its owner exits", async () => {
  const f = await fixture();
  try {
    const second = await registerRuntimeInstallOwner(f.root, "https://z-other.example.test", f.lock);
    await releaseRuntimeInstallOwner(f.root, second, f.lock, gone);
    expect(readRuntimeInstallReceipt(f.root)?.shared).toBe(true);
    expect(readRuntimeInstallReceipt(f.root)?.origins[0]).toBe(origin);
    await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/shared/);
  } finally { f.lock.release(); }
});
it.each(["gone", "unknown", "live-child"] as const)("registration reaps shared-root capacity only with positive %s proof", async state => {
  const f = await fixture();
  try {
    rmSync(join(f.directory, `${f.owner.id}.json`));
    const receipt = readRuntimeInstallReceipt(f.root)!;
    writeFileSync(join(f.root, RUNTIME_INSTALL_RECEIPT), JSON.stringify({ ...receipt, origins: [origin, "https://z-other.example.test"], shared: true }));
    const rows = Array.from({ length: 64 }, (_, i) => other(f, { parent: { ...parent, pid: 123500 + i }, ...(state === "live-child" ? { child } : {}) }));
    const observe = async (pid: number): Promise<RuntimeProcessObservation> => state === "unknown" ? { state: "unknown" } : state === "live-child" && pid === child.pid ? alive(child) : { state: "gone" };
    const registering = registerRuntimeInstallOwner(f.root, origin, f.lock, observe);
    if (state === "gone") {
      await expect(registering).resolves.toMatchObject({ origin });
      const next = await registering; expect(readdirSync(f.directory)).toEqual([`${next.id}.json`]);
      expect(next.origin).toBe(origin); expect(readRuntimeInstallReceipt(f.root)?.shared).toBe(true);
    } else {
      await expect(registering).rejects.toThrow(/owned/); expect(readdirSync(f.directory)).toHaveLength(64);
      for (const previous of rows) expect(JSON.parse(readFileSync(join(f.directory, `${previous.id}.json`), "utf8"))).toEqual(previous);
    }
  } finally { f.lock.release(); }
});
it("registration preserves a stale row replaced during its process observation", async () => {
  const f = await fixture(), previous = other(f); let release!: (value: RuntimeProcessObservation) => void;
  try {
    const registering = registerRuntimeInstallOwner(f.root, origin, f.lock, async pid => pid === previous.parent.pid ? await new Promise(done => { release = done; }) : alive(parent));
    const refused = expect(registering).rejects.toThrow(/changed/);
    while (!release) await new Promise(done => setImmediate(done));
    const replacement = { ...previous, child }; writeFileSync(join(f.directory, `${previous.id}.json`), JSON.stringify(replacement));
    release({ state: "gone" }); await refused;
    expect(JSON.parse(readFileSync(join(f.directory, `${previous.id}.json`), "utf8"))).toEqual(replacement);
  } finally { f.lock.release(); }
});
it("a remembered shared receipt stays unavailable even when its bounded origin list has one entry", async () => {
  const f = await fixture();
  try {
    const receipt = readRuntimeInstallReceipt(f.root)!;
    writeFileSync(join(f.root, RUNTIME_INSTALL_RECEIPT), JSON.stringify({ ...receipt, revision: receipt.revision + 1, shared: true }));
    await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/shared/);
  } finally { f.lock.release(); }
});
it("even same-origin live or unknown owners defer without removing their reservation", async () => {
  for (const observation of ["alive", "unknown"] as const) {
    const f = await fixture(), prior = other(f);
    try {
      await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, async () => observation === "alive" ? alive(prior.parent) : { state: "unknown" })).rejects.toThrow(observation === "alive" ? /owned/ : /unknown/);
      expect(existsSync(join(f.directory, `${prior.id}.json`))).toBe(true);
    } finally { f.lock.release(); }
  }
});
it("a dead supervisor never vouches for a live or unknown retained child", async () => {
  for (const observation of ["alive", "unknown"] as const) {
    const f = await fixture(), prior = other(f, { child });
    try {
      await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, async pid => pid === prior.parent.pid ? { state: "gone" } : observation === "alive" ? alive(child) : { state: "unknown" })).rejects.toThrow(observation === "alive" ? /owned/ : /unknown/);
      expect(existsSync(join(f.directory, `${prior.id}.json`))).toBe(true);
    } finally { f.lock.release(); }
  }
});
it("prunes only positively gone or reused parent and child identities", async () => {
  const f = await fixture(), prior = other(f, { child });
  try {
    await assertRuntimeInstallExclusive(f.root, f.owner, f.lock, async pid => alive({ ...prior.parent, pid, birth: "638990000000000000" }));
    expect(existsSync(join(f.directory, `${prior.id}.json`))).toBe(false); expect(existsSync(join(f.directory, `${f.owner.id}.json`))).toBe(true);
  } finally { f.lock.release(); }
});
it("does not delete a replaced owner after a process query awaits", async () => {
  const f = await fixture(), prior = other(f); let release!: (value: RuntimeProcessObservation) => void;
  try {
    const checking = assertRuntimeInstallExclusive(f.root, f.owner, f.lock, () => new Promise(done => { release = done; }));
    const refused = expect(checking).rejects.toThrow(/changed/), replacement = { ...prior, child };
    writeFileSync(join(f.directory, `${prior.id}.json`), JSON.stringify(replacement)); release({ state: "gone" }); await refused;
    expect(JSON.parse(readFileSync(join(f.directory, `${prior.id}.json`), "utf8"))).toEqual(replacement);
  } finally { f.lock.release(); }
});
it("replaces its own child only after positive old-child absence and new-child identity", async () => {
  const f = await fixture();
  try {
    const first = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child)), next = { ...child, pid: 123458 };
    await expect(attachRuntimeInstallChild(f.root, first, next, f.lock, async pid => alive(pid === child.pid ? child : next))).rejects.toThrow(/owned/);
    const second = await attachRuntimeInstallChild(f.root, first, next, f.lock, async pid => pid === child.pid ? { state: "gone" } : alive(next));
    expect(second.child).toEqual(next); await assertRuntimeInstallExclusive(f.root, second, f.lock, gone);
  } finally { f.lock.release(); }
});
it("a replaced self row and unknown directory entries never become exclusivity", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.directory, "unknown"), "retain"); await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/unsafe/);
    rmSync(join(f.directory, "unknown")); const replacement = { ...f.owner, child }; writeFileSync(join(f.directory, `${f.owner.id}.json`), JSON.stringify(replacement));
    await expect(assertRuntimeInstallExclusive(f.root, f.owner, f.lock, gone)).rejects.toThrow(/changed/);
    await expect(releaseRuntimeInstallOwner(f.root, f.owner, f.lock, gone)).rejects.toThrow(/changed/);
    expect(JSON.parse(readFileSync(join(f.directory, `${f.owner.id}.json`), "utf8"))).toEqual(replacement);
  } finally { f.lock.release(); }
});
it("strictly rejects command/path/credential fields and malformed process identities", async () => {
  const f = await fixture();
  try {
    for (const bad of [{ ...f.owner, credential: "anything" }, { ...f.owner, child: { ...child, command: "anything" } }, { ...f.owner, parent: { ...parent, birth: "unknown" } }, { ...f.owner, origin: "https://paired.example.test/" }]) expect(() => parseRuntimeInstallOwner(bad)).toThrow();
  } finally { f.lock.release(); }
});

it("transfers only to the exact registered live child after checking the current row", async () => {
  const f = await fixture();
  try {
    const pending = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child));
    await expect(transferRuntimeInstallOwner(f.root, pending, f.lock, async () => ({ state: "unknown" }))).rejects.toThrow(/unknown/);
    expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(pending);
    const next = await transferRuntimeInstallOwner(f.root, pending, f.lock, async () => alive(child));
    expect(next).toEqual({ ...f.owner, parent: child }); expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(next);
    await expect(releaseRuntimeInstallOwner(f.root, pending, f.lock, gone)).rejects.toThrow(/changed/);
  } finally { f.lock.release(); }
});
it.each(["gone", "reused", "alive", "unknown"] as const)("registered self-child adoption requires positive %s parent proof", async state => {
  const f = await fixture(), previous = { ...f.owner, parent: child, child: parent };
  writeFileSync(join(f.directory, `${f.owner.id}.json`), JSON.stringify(previous));
  try {
    const observe = async (pid: number): Promise<RuntimeProcessObservation> => pid === parent.pid ? alive(parent)
      : state === "gone" ? { state: "gone" } : state === "unknown" ? { state: "unknown" } : alive(state === "reused" ? { ...child, birth: "638990000000000000" } : child);
    const adopting = adoptRuntimeInstallOwner(f.root, previous, f.lock, observe);
    if (state === "gone" || state === "reused") {
      await expect(adopting).resolves.toEqual(f.owner); expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(f.owner);
    } else { await expect(adopting).rejects.toThrow(state === "alive" ? /owned/ : /unknown/); expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(previous); }
  } finally { f.lock.release(); }
});
it("an unregistered child cannot adopt merely because its claimed parent is gone", async () => {
  const f = await fixture();
  try { await expect(adoptRuntimeInstallOwner(f.root, f.owner, f.lock, gone)).rejects.toThrow(/changed/); expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(f.owner); }
  finally { f.lock.release(); }
});
it.each([["adopt", "row"], ["adopt", "receipt"], ["transfer", "row"], ["transfer", "receipt"]] as const)("%s refuses a %s change while process proof is pending", async (kind, changed) => {
  const f = await fixture(), previous = kind === "adopt" ? { ...f.owner, parent: child, child: parent } : { ...f.owner, child };
  writeFileSync(join(f.directory, `${f.owner.id}.json`), JSON.stringify(previous));
  try {
    const replacing = async (pid: number): Promise<RuntimeProcessObservation> => {
      if (changed === "receipt") {
        const receipt = readRuntimeInstallReceipt(f.root)!; writeFileSync(join(f.root, RUNTIME_INSTALL_RECEIPT), JSON.stringify({ ...receipt, revision: receipt.revision + 1 }));
      } else writeFileSync(join(f.directory, `${previous.id}.json`), JSON.stringify({ ...previous, parent: { ...previous.parent, birth: "639000000000000000" } }));
      return kind === "adopt" && pid === child.pid ? { state: "gone" } : alive(pid === parent.pid ? parent : child);
    };
    await expect((kind === "adopt" ? adoptRuntimeInstallOwner : transferRuntimeInstallOwner)(f.root, previous, f.lock, replacing)).rejects.toThrow(/changed/);
    expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(changed === "row" ? { ...previous, parent: { ...previous.parent, birth: "639000000000000000" } } : previous);
  } finally { f.lock.release(); }
});

it.each(["control", "child-replace", "child-mutate", "id", "install", "origin", "parent"] as const)("transfer snapshots caller inputs during held verification: %s", async mutation => {
  const f = await fixture();
  try {
    const running = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child)), input = structuredClone(running);
    let release!: (value: RuntimeProcessObservation) => void; const queried: number[] = [];
    const work = transferRuntimeInstallOwner(f.root, input, f.lock, async pid => { queried.push(pid); return new Promise(done => { release = done; }); });
    if (mutation === "child-replace") input.child = { ...child, pid: 123458 };
    if (mutation === "child-mutate") input.child!.pid = 123458;
    if (mutation === "id") input.id = randomUUID();
    if (mutation === "install") input.installId = randomUUID();
    if (mutation === "origin") input.origin = "https://different.example.test";
    if (mutation === "parent") input.parent.birth = "639000000000000000";
    release(alive(child));
    const next = await work;
    expect(queried).toEqual([child.pid]); expect(next).toEqual({ ...f.owner, parent: child });
    expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(next); expect(readdirSync(f.directory)).toEqual([`${f.owner.id}.json`]);
  } finally { f.lock.release(); }
});
it.each(["control", "child-mutate", "id", "install", "origin"] as const)("adoption snapshots caller identity and binding during held verification: %s", async mutation => {
  const f = await fixture(), previous = { ...f.owner, parent: child, child: parent }, input = structuredClone(previous);
  writeFileSync(join(f.directory, `${previous.id}.json`), JSON.stringify(previous));
  try {
    let release!: (value: RuntimeProcessObservation) => void; const queried: number[] = [];
    const work = adoptRuntimeInstallOwner(f.root, input, f.lock, async pid => {
      queried.push(pid); return pid === child.pid ? new Promise(done => { release = done; }) : alive(parent);
    });
    if (mutation === "child-mutate") input.child!.birth = "639000000000000000";
    if (mutation === "id") input.id = randomUUID();
    if (mutation === "install") input.installId = randomUUID();
    if (mutation === "origin") input.origin = "https://different.example.test";
    release({ state: "gone" });
    const next = await work;
    expect(queried).toEqual([child.pid, parent.pid]); expect(next).toEqual(f.owner);
    expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(f.owner); expect(readdirSync(f.directory)).toEqual([`${f.owner.id}.json`]);
  } finally { f.lock.release(); }
});
it("attachment snapshots the caller's owner before waiting for a prior child's positive exit", async () => {
  const f = await fixture();
  try {
    const running = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child)), input = structuredClone(running), actualNext = { ...child, pid: 123458 }, nextChild = structuredClone(actualNext);
    let release!: (value: RuntimeProcessObservation) => void;
    const work = attachRuntimeInstallChild(f.root, input, nextChild, f.lock, async pid => pid === child.pid ? new Promise(done => { release = done; }) : alive(actualNext));
    input.id = randomUUID(); nextChild.birth = "639000000000000000"; release({ state: "gone" });
    const stored = await work;
    expect(stored.id).toBe(f.owner.id); expect(stored.child).toEqual({ ...child, pid: 123458 });
  } finally { f.lock.release(); }
});
it("exclusivity snapshots the caller's process proof across another owner's observation", async () => {
  const f = await fixture(), prior = other(f), input = structuredClone(f.owner);
  try {
    let release!: (value: RuntimeProcessObservation) => void;
    const work = assertRuntimeInstallExclusive(f.root, input, f.lock, async pid => pid === prior.parent.pid ? new Promise(done => { release = done; }) : alive(parent));
    input.parent.birth = "639000000000000000"; release({ state: "gone" }); await work;
    expect(readRuntimeInstallOwner(f.root, f.owner.id)).toEqual(f.owner);
  } finally { f.lock.release(); }
});
it("release snapshots the exact row ID before its registered child's exit query", async () => {
  const f = await fixture();
  try {
    const running = await attachRuntimeInstallChild(f.root, f.owner, child, f.lock, async () => alive(child)), input = structuredClone(running);
    let release!: (value: RuntimeProcessObservation) => void;
    const work = releaseRuntimeInstallOwner(f.root, input, f.lock, async () => new Promise(done => { release = done; }));
    input.id = randomUUID(); release({ state: "gone" }); await work; expect(readdirSync(f.directory)).toEqual([]);
  } finally { f.lock.release(); }
});
it("registration snapshots its own process proof before asynchronous stale-row observations", async () => {
  const f = await fixture(), prior = other(f);
  try {
    const registering = registerRuntimeInstallOwner(f.root, origin, f.lock, async pid => {
      if (pid !== prior.parent.pid) return alive(parent);
      f.lock.record.birth = "639000000000000000"; return { state: "gone" };
    });
    await expect(registering).rejects.toThrow(/changed/);
    expect(readdirSync(f.directory)).toEqual([`${f.owner.id}.json`]);
  } finally { f.lock.record.birth = parent.birth; f.lock.release(); }
});
