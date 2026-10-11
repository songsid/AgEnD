/**
 * #1441 part B: `agend update` decides, before touching anything, whether the target release can run on the Node it
 * will actually run on (design baseline: #1441 issuecomment-6108441160). Pure decision and manifest parsing here; the
 * built CLI's order (refused before the marker, nvm and npm) is in update-preflight-cli-1441.test.ts.
 */
import { describe, expect, it } from "vitest";
import { evaluateUpdateTarget, lookupTargetManifest, runtimePlatform, type TargetManifest } from "../src/update-preflight.js";

const ENGINES = "^22.14.0 || ^23.6.0 || >=24";
const PINS = { "linux-x64": "22.23.3", "linux-arm64": "22.23.3", "darwin-x64": "22.23.3", "darwin-arm64": "22.23.3" };
const target = (over: Partial<TargetManifest> = {}): TargetManifest => ({ version: "2.3.0-beta.1", engines: ENGINES, runtimePins: { ...PINS }, ...over });
const host = (probe: Parameters<typeof runtimePlatform.hostPlatform>[0]) => runtimePlatform.hostPlatform(probe);
const glibcX64 = host({ platform: "linux", arch: "x64", glibc: "2.36" });
const muslX64 = host({ platform: "linux", arch: "x64", glibc: null });

describe("evaluateUpdateTarget: the Node the target will run on", () => {
  it("a host the target's bundled runtime covers: the system Node does not matter (Node 16 on PATH)", () => {
    expect(evaluateUpdateTarget({ manifest: target(), host: glibcX64, systemNode: "16.20.2", viaNvm: false }))
      .toEqual({ kind: "runtime", host: "linux-x64", pin: "22.23.3" });
    expect(evaluateUpdateTarget({ manifest: target(), host: host({ platform: "darwin", arch: "arm64", darwinRelease: "24.3.0" }), systemNode: null, viaNvm: false }).kind).toBe("runtime");
  });

  it("musl with Node 20: refused — no bundled Node there, and Node 20 is outside the range", () => {
    const v = evaluateUpdateTarget({ manifest: target(), host: muslX64, systemNode: "20.20.2", systemNodePath: "/usr/local/bin/node", viaNvm: false });
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") return;
    expect(v.message).toContain("nothing was changed");
    expect(v.message).toContain(`needs Node ${ENGINES}`);
    expect(v.message).toContain("not glibc-based (musl?)");
    expect(v.message).toContain("Node 20.20.2 (/usr/local/bin/node)");
    expect(v.message).toContain("then run: agend update");
    expect(v.summary).toContain("v2.3.0-beta.1 needs Node");
  });

  it("musl with Node 22.14 on PATH: runs on the system Node", () => {
    expect(evaluateUpdateTarget({ manifest: target(), host: muslX64, systemNode: "22.14.0", viaNvm: false })).toEqual({ kind: "system", node: "22.14.0", via: "path" });
  });

  it("a target with no runtime for this host (none at all, or not this host id) and Node 20: refused", () => {
    for (const runtimePins of [{}, { "darwin-arm64": "22.23.3" }] as Array<Record<string, string>>) {
      const v = evaluateUpdateTarget({ manifest: target({ runtimePins }), host: glibcX64, systemNode: "20.19.0", viaNvm: false });
      expect(v.kind, JSON.stringify(runtimePins)).toBe("refuse");
      if (v.kind === "refuse") expect(v.message).toContain("ships no bundled Node for linux-x64");
    }
  });

  it("old glibc and old macOS: refused with the runtime's own reason", () => {
    const oldGlibc = evaluateUpdateTarget({ manifest: target(), host: host({ platform: "linux", arch: "x64", glibc: "2.17" }), systemNode: "20.0.0", viaNvm: false });
    expect(oldGlibc.kind === "refuse" && oldGlibc.message).toContain("glibc 2.17 is older than the 2.28");
    const oldMac = evaluateUpdateTarget({ manifest: target(), host: host({ platform: "darwin", arch: "x64", darwinRelease: "19.6.0" }), systemNode: "18.0.0", viaNvm: false });
    expect(oldMac.kind === "refuse" && oldMac.message).toContain("macOS older than 11");
  });

  it("the sudo path installs nvm's Node 22: judged as a 22, so a 22-compatible target goes on and a >=24-only one does not", () => {
    expect(evaluateUpdateTarget({ manifest: target({ runtimePins: {} }), host: muslX64, systemNode: "18.0.0", viaNvm: true })).toEqual({ kind: "system", node: "22 (nvm)", via: "nvm" });
    expect(evaluateUpdateTarget({ manifest: target({ runtimePins: {}, engines: ">=24" }), host: muslX64, systemNode: "18.0.0", viaNvm: true }).kind).toBe("refuse");
  });

  it("no node on PATH and no usable runtime: refused, saying so", () => {
    const v = evaluateUpdateTarget({ manifest: target(), host: muslX64, systemNode: null, viaNvm: false });
    expect(v.kind === "refuse" && v.message).toContain("no usable `node`");
  });

  it("a runtime pin outside the target's own range: refused (never runs a Node it rejects)", () => {
    const v = evaluateUpdateTarget({ manifest: target({ runtimePins: { "linux-x64": "20.19.0" } }), host: glibcX64, systemNode: "24.1.0", viaNvm: false });
    expect(v.kind).toBe("refuse");
  });

  it("requirements that cannot be read: unknown — the update goes on, the target's own install check still applies", () => {
    for (const manifest of [null, target({ engines: null })]) {
      const v = evaluateUpdateTarget({ manifest, host: muslX64, systemNode: "16.0.0", viaNvm: false });
      expect(v.kind).toBe("unknown");
    }
  });
});

describe("lookupTargetManifest", () => {
  const runWith = (out: string | Error) => (() => { if (out instanceof Error) throw out; return out; }) as never;
  it("reads engines and the runtime pins of the exact version", () => {
    const calls: unknown[][] = [];
    const run = ((cmd: string, args: string[]) => { calls.push([cmd, ...args]); return JSON.stringify({ version: "2.3.0-beta.1", engines: { node: ENGINES }, optionalDependencies: { "@songsid/agend-node-linux-x64": "22.23.3", "other-dep": "1.0.0" } }); }) as never;
    expect(lookupTargetManifest("2.3.0-beta.1", run)).toEqual({ version: "2.3.0-beta.1", engines: ENGINES, runtimePins: { "linux-x64": "22.23.3" } });
    expect(calls).toEqual([["npm", "view", "@songsid/agend@2.3.0-beta.1", "version", "engines", "optionalDependencies", "--json"]]);
  });
  it("missing fields are absent, not invented", () => {
    expect(lookupTargetManifest("2.1.12", runWith(JSON.stringify({ version: "2.1.12" })))).toEqual({ version: "2.1.12", engines: null, runtimePins: {} });
  });
  it("a failed lookup, invalid JSON, or an answer that is not a manifest: null", () => {
    expect(lookupTargetManifest("x", runWith(new Error("E404")))).toBeNull();
    expect(lookupTargetManifest("x", runWith("2.3.0-beta.1"))).toBeNull();
    expect(lookupTargetManifest("x", runWith("[]"))).toBeNull();
    expect(lookupTargetManifest("x", runWith(JSON.stringify({ engines: { node: ENGINES } })))).toBeNull();
  });
});
