/**
 * #1441 part B: `agend update` decides, before it installs, whether the target release can run on the Node it will
 * actually run on (design baseline: #1441 issuecomment-6108441160; #1623 review). Pure decision, manifest reading and
 * npm range semantics here; the built CLI's order is in update-preflight-cli-1441.test.ts, the nvm install's bound check
 * in update-preflight-nvm-1441.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateUpdateTarget, lookupTargetManifest, manifestQuery, preflightUpdate, probeSystemNode, runtimePlatform, satisfiesNodeRange,
  type PreflightEnv, type SystemNode, type TargetManifest,
} from "../src/update-preflight.js";

const ENGINES = "^22.14.0 || ^23.6.0 || >=24";
const PINS = { "linux-x64": "22.23.3", "linux-arm64": "22.23.3", "darwin-x64": "22.23.3", "darwin-arm64": "22.23.3" };
const target = (over: Partial<TargetManifest> = {}): TargetManifest => ({ version: "2.3.0-beta.1", engines: ENGINES, runtimePins: { ...PINS }, ...over });
const host = (probe: Parameters<typeof runtimePlatform.hostPlatform>[0]) => runtimePlatform.hostPlatform(probe);
const glibcX64 = host({ platform: "linux", arch: "x64", glibc: "2.36" });
const muslX64 = host({ platform: "linux", arch: "x64", glibc: null });
const onPath = (version: string, path: string | null = null): SystemNode => ({ kind: "version", version, path, label: "the `node` on PATH" });

describe("evaluateUpdateTarget: the Node the target will run on", () => {
  it("a host the target's bundled runtime covers: the system Node does not matter (Node 16 on PATH, or none)", () => {
    expect(evaluateUpdateTarget({ manifest: target(), host: glibcX64, system: onPath("16.20.2") }))
      .toEqual({ kind: "runtime", host: "linux-x64", pin: "22.23.3" });
    expect(evaluateUpdateTarget({ manifest: target(), host: host({ platform: "darwin", arch: "arm64", darwinRelease: "24.3.0" }), system: { kind: "none" } }).kind).toBe("runtime");
  });

  it("an -agend.N runtime pin keeps its identity and is judged as the Node it installs (22.23.3-agend.1 under ^22.14.0)", () => {
    const pinned = target({ engines: "^22.14.0", runtimePins: { "linux-x64": "22.23.3-agend.1" } });
    expect(evaluateUpdateTarget({ manifest: pinned, host: glibcX64, system: onPath("16.0.0") }))
      .toEqual({ kind: "runtime", host: "linux-x64", pin: "22.23.3-agend.1" });
    expect(evaluateUpdateTarget({ manifest: target({ engines: "^22.24.0", runtimePins: { "linux-x64": "22.23.3-agend.1" } }), host: glibcX64, system: onPath("16.0.0") }).kind).toBe("refuse");
  });

  it("a runtime pin the launcher would not read: unknown, never a verdict", () => {
    const v = evaluateUpdateTarget({ manifest: target({ runtimePins: { "linux-x64": "^22.23.3" } }), host: glibcX64, system: onPath("16.0.0") });
    expect(v.kind).toBe("unknown");
  });

  it("musl with Node 20: refused — no bundled Node there, and Node 20 is outside the range", () => {
    const v = evaluateUpdateTarget({ manifest: target(), host: muslX64, system: onPath("20.20.2", "/usr/local/bin/node") });
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") return;
    expect(v.message).toContain("AgEnD was not changed");
    expect(v.message).toContain(`needs Node ${ENGINES}`);
    expect(v.message).toContain("not glibc-based (musl?)");
    expect(v.message).toContain("it would run on the `node` on PATH (Node 20.20.2, /usr/local/bin/node)");
    expect(v.message).toContain(`Install a Node that satisfies ${ENGINES} and put it first on PATH, then run: agend update`);
    expect(v.summary).toContain("v2.3.0-beta.1 needs Node");
  });

  it("the advice fits the range: a >=24 target never suggests Node 22", () => {
    const v = evaluateUpdateTarget({ manifest: target({ engines: ">=24", runtimePins: {} }), host: muslX64, system: onPath("22.23.3") });
    expect(v.kind === "refuse" && v.message).toContain("Install a Node that satisfies >=24");
    expect(v.kind === "refuse" && v.message).not.toMatch(/nvm install 22|Node 22\b(?!\.)/);
  });

  it("musl with Node 22.14 on PATH: runs on the system Node", () => {
    expect(evaluateUpdateTarget({ manifest: target(), host: muslX64, system: onPath("22.14.0") })).toEqual({ kind: "system", node: "22.14.0", label: "the `node` on PATH" });
  });

  it("a target with no runtime for this host (none at all, or not this host id) and Node 20: refused", () => {
    for (const runtimePins of [{}, { "darwin-arm64": "22.23.3" }] as Array<Record<string, string>>) {
      const v = evaluateUpdateTarget({ manifest: target({ runtimePins }), host: glibcX64, system: onPath("20.19.0") });
      expect(v.kind, JSON.stringify(runtimePins)).toBe("refuse");
      if (v.kind === "refuse") expect(v.message).toContain("ships no bundled Node for linux-x64");
    }
  });

  it("old glibc and old macOS: refused with the runtime's own reason", () => {
    const oldGlibc = evaluateUpdateTarget({ manifest: target(), host: host({ platform: "linux", arch: "x64", glibc: "2.17" }), system: onPath("20.0.0") });
    expect(oldGlibc.kind === "refuse" && oldGlibc.message).toContain("glibc 2.17 is older than the 2.28");
    const oldMac = evaluateUpdateTarget({ manifest: target(), host: host({ platform: "darwin", arch: "x64", darwinRelease: "19.6.0" }), system: onPath("18.0.0") });
    expect(oldMac.kind === "refuse" && oldMac.message).toContain("macOS older than 11");
  });

  it("the exact Node nvm selected is what is judged: 22.23.3 under ^22.24.0 is refused, under ^22.14.0 it runs", () => {
    const nvm: SystemNode = { kind: "version", version: "22.23.3", path: "/home/u/.nvm/versions/node/v22.23.3/bin/node", label: "the Node 22 nvm selected" };
    expect(evaluateUpdateTarget({ manifest: target({ engines: "^22.24.0", runtimePins: {} }), host: muslX64, system: nvm }).kind).toBe("refuse");
    expect(evaluateUpdateTarget({ manifest: target({ engines: "^22.14.0", runtimePins: {} }), host: muslX64, system: nvm }).kind).toBe("system");
  });

  it("a Node that cannot be read yet or at all: unknown, never compatible and never a refusal", () => {
    const v = evaluateUpdateTarget({ manifest: target({ engines: ">=99", runtimePins: {} }), host: muslX64, system: { kind: "unknown", note: "  Note: x" } });
    expect(v).toEqual({ kind: "unknown", note: "  Note: x" });
  });

  it("no node on PATH and no usable runtime: refused, saying so", () => {
    const v = evaluateUpdateTarget({ manifest: target(), host: muslX64, system: { kind: "none" } });
    expect(v.kind === "refuse" && v.message).toContain("no usable `node`");
  });

  it("a runtime pin outside the target's own range: refused (never runs a Node it rejects)", () => {
    const v = evaluateUpdateTarget({ manifest: target({ runtimePins: { "linux-x64": "20.19.0" } }), host: glibcX64, system: onPath("24.1.0") });
    expect(v.kind).toBe("refuse");
  });

  it("valid npm ranges are evaluated, not refused (22.x, 22.23.3, >=22.14.0 <23 on Node 22.23.3)", () => {
    for (const engines of ["22.x", "22.23.3", ">=22.14.0 <23", "22", "~22.23", "22.1 - 24", ">= 22.14"]) {
      expect(evaluateUpdateTarget({ manifest: target({ engines, runtimePins: {} }), host: muslX64, system: onPath("22.23.3") }).kind, engines).toBe("system");
    }
  });

  it("a range this check cannot evaluate: unknown — never a refusal (also for the runtime pin)", () => {
    for (const engines of ["not a semver range", "^22.0.0-0", "~>22", "^22 ||", "1.x.3", "022"]) {
      expect(evaluateUpdateTarget({ manifest: target({ engines, runtimePins: {} }), host: muslX64, system: onPath("20.0.0") }).kind, engines).toBe("unknown");
      expect(evaluateUpdateTarget({ manifest: target({ engines }), host: glibcX64, system: onPath("20.0.0") }).kind, engines).toBe("unknown");
    }
  });

  it("requirements that cannot be read: unknown — the update goes on, the target's own install check still applies", () => {
    for (const manifest of [null, target({ engines: null })]) {
      const v = evaluateUpdateTarget({ manifest, host: muslX64, system: onPath("16.0.0") });
      expect(v.kind).toBe("unknown");
    }
  });
});

describe("satisfiesNodeRange: npm's range semantics for a stable Node (golden rows from semver 7.7.4)", () => {
  // [range, version, semver.satisfies] — the parser was also checked against semver on 960 000 random pairs, 0 mismatches.
  const rows: Array<[string, string, boolean]> = [
    [ENGINES, "20.19.0", false], [ENGINES, "22.14.0", true], [ENGINES, "22.13.9", false], [ENGINES, "23.5.0", false], [ENGINES, "23.6.0", true], [ENGINES, "24.0.0", true],
    ["22.x", "22.0.0", true], ["22.x", "23.0.0", false], ["22.*", "22.23.3", true], ["22.X", "21.9.9", false],
    ["22.23.3", "22.23.3", true], ["22.23.3", "22.23.4", false], ["=22.23", "22.23.9", true], ["=22.23", "22.24.0", false], ["v22", "22.1.0", true],
    [">=22.14.0 <23", "22.14.0", true], [">=22.14.0 <23", "23.0.0", false], [">=22.14.0 <23", "22.13.0", false],
    [">=24", "24.0.0", true], [">=24", "23.99.0", false], [">24", "24.5.0", false], [">24", "25.0.0", true], [">24.1", "24.1.9", false], [">24.1", "24.2.0", true], [">24.1.2", "24.1.3", true],
    ["<22", "21.99.0", true], ["<22", "22.0.0", false], ["<=22", "22.99.0", true], ["<=22", "23.0.0", false], ["<=22.1", "22.1.9", true], ["<=22.1", "22.2.0", false], ["<=22.1.2", "22.1.2", true],
    ["~22", "22.99.0", true], ["~22", "23.0.0", false], ["~22.23", "22.23.0", true], ["~22.23", "22.24.0", false], ["~22.23.3", "22.23.2", false], ["~22.23.3", "22.23.9", true],
    ["^22", "22.0.0", true], ["^22", "23.0.0", false], ["^22.14", "22.13.0", false], ["^22.14", "22.99.0", true], ["^0.2", "0.2.9", true], ["^0.2", "0.3.0", false],
    ["^0.2.3", "0.2.2", false], ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false], ["^0.0", "0.0.9", true], ["^0.0", "0.1.0", false], ["^0", "0.9.9", true], ["^0", "1.0.0", false],
    ["22.1 - 24", "22.0.9", false], ["22.1 - 24", "24.9.9", true], ["22.1 - 24", "25.0.0", false], ["22 - 24.1", "24.1.9", true], ["22 - 24.1", "24.2.0", false], ["22.0.0 - 24.1.2", "24.1.3", false],
    ["*", "1.0.0", true], ["", "22.0.0", true], ["x", "22.0.0", true], [">*", "22.0.0", false], ["<*", "22.0.0", false], [">=*", "1.2.3", true], ["<=*", "1.2.3", true],
    ["< 22", "21.0.0", true], [">= 22.14", "22.14.0", true], ["^22.14.0 || <20", "19.0.0", true],
  ];
  it.each(rows)("%j on %s → %s", (range, version, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });
  it("outside the grammar (or a non-stable Node version): null", () => {
    for (const range of ["^22.0.0-0", "~>22", "^22 ||", "|| ^22", "1.x.3", "022", "22.0.01", "not a range", ">=22 <", "^22.14.0+build"]) {
      expect(satisfiesNodeRange("22.23.3", range), range).toBeNull();
    }
    expect(satisfiesNodeRange("23.0.0-pre", ENGINES)).toBeNull();
    expect(satisfiesNodeRange("9007199254740992.0.0", ">=22")).toBeNull();
    expect(satisfiesNodeRange("22", ENGINES)).toBeNull();
  });
});

describe("satisfiesNodeRange: version parts past Number.MAX_SAFE_INTEGER have no npm meaning (#1623 r2 review)", () => {
  // semver 7.7.4 validRange() is null for all of these: a written part past the limit, or an upper bound that x/~/^/
  // hyphen expansion pushes past it.
  const invalid = ["<9007199254740992", ">=9007199254740992", "<=9007199254740991", "^9007199254740991", "~9007199254740991",
    "9007199254740991.x", ">9007199254740991", "22 - 9007199254740991", "22.9007199254740992", "^22.0.9007199254740992", "99999999999999999999"];
  it.each(invalid)("%s: null, and the update verdict is unknown — never system, never refuse", range => {
    expect(satisfiesNodeRange("22.23.3", range)).toBeNull();
    expect(evaluateUpdateTarget({ manifest: target({ engines: range, runtimePins: {} }), host: muslX64, system: onPath("22.23.3") }).kind).toBe("unknown");
    expect(evaluateUpdateTarget({ manifest: target({ engines: range }), host: glibcX64, system: onPath("22.23.3") }).kind).toBe("unknown");
  });
  it("controls: the largest safe parts still evaluate (semver agrees)", () => {
    expect(satisfiesNodeRange("22.23.3", "<9007199254740991")).toBe(true);
    expect(satisfiesNodeRange("22.23.3", ">=9007199254740991")).toBe(false);
    expect(satisfiesNodeRange("22.23.3", "<=9007199254740990")).toBe(true);
    expect(satisfiesNodeRange("22.23.3", "^9007199254740990")).toBe(false);
    expect(satisfiesNodeRange("22.23.3", "~22.9007199254740990")).toBe(false);
  });
});

describe("lookupTargetManifest: the exact spec, the exact version", () => {
  const SPEC = "@songsid/agend@2.3.0-beta.1";
  const answer = (out: string | null) => () => out;
  it("reads engines and the runtime pins of the exact version, with the query the caller runs on its npm", () => {
    const calls: string[][] = [];
    const read = (args: string[]) => { calls.push(args); return JSON.stringify({ version: "2.3.0-beta.1", engines: { node: ENGINES }, optionalDependencies: { "@songsid/agend-node-linux-x64": "22.23.3", "other-dep": "1.0.0" } }); };
    expect(lookupTargetManifest(SPEC, "2.3.0-beta.1", read)).toEqual({ version: "2.3.0-beta.1", engines: ENGINES, runtimePins: { "linux-x64": "22.23.3" } });
    expect(calls).toEqual([["view", SPEC, "version", "engines", "optionalDependencies", "--json"]]);
    expect(manifestQuery(SPEC)).toEqual(calls[0]);
  });
  it("missing fields are absent, not invented", () => {
    expect(lookupTargetManifest("@songsid/agend@2.1.12", "2.1.12", answer(JSON.stringify({ version: "2.1.12" })))).toEqual({ version: "2.1.12", engines: null, runtimePins: {} });
  });
  it("the answer is for another version, or is not a version: null (it says nothing about this one)", () => {
    for (const version of ["2.2.0", "2.3.0-beta.10", "v2.3.0-beta.1", " 2.3.0-beta.1", "latest", 2.3]) {
      expect(lookupTargetManifest(SPEC, "2.3.0-beta.1", answer(JSON.stringify({ version, engines: { node: ENGINES } }))), String(version)).toBeNull();
    }
  });
  it("a spec that is not the exact version, or a version that is not one: null without asking npm", () => {
    let asked = 0;
    const read = () => { asked++; return JSON.stringify({ version: "2.3.0-beta.1", engines: { node: ENGINES } }); };
    expect(lookupTargetManifest("@songsid/agend@beta", "2.3.0-beta.1", read)).toBeNull();
    expect(lookupTargetManifest("@songsid/agend@2.3.0-beta.1", "beta", read)).toBeNull();
    expect(lookupTargetManifest("other@2.3.0-beta.1", "2.3.0-beta.1", read)).toBeNull();
    expect(lookupTargetManifest("@songsid/agend@02.3.0", "02.3.0", read)).toBeNull();
    expect(asked).toBe(0);
  });
  it("a failed lookup, invalid JSON, or an answer that is not a manifest: null", () => {
    expect(lookupTargetManifest(SPEC, "2.3.0-beta.1", answer(null))).toBeNull();
    expect(lookupTargetManifest(SPEC, "2.3.0-beta.1", answer("2.3.0-beta.1"))).toBeNull();
    expect(lookupTargetManifest(SPEC, "2.3.0-beta.1", answer("[]"))).toBeNull();
    expect(lookupTargetManifest(SPEC, "2.3.0-beta.1", answer(JSON.stringify({ engines: { node: ENGINES } })))).toBeNull();
  });
});

describe("preflightUpdate / probeSystemNode: read in the environment they are given", () => {
  const env = (answers: Record<string, { status: number | null; stdout: string }>, npm = "/opt/nvm/bin/npm") => {
    const calls: string[][] = [];
    const e: PreflightEnv = { npm, run: argv => { calls.push(argv); return answers[argv[0] === "sh" ? "node" : argv[0]!] ?? { status: 1, stdout: "" }; } };
    return { e, calls };
  };
  it("the requirements come from the npm it is handed, for the spec it is handed", () => {
    const { e, calls } = env({ "/opt/nvm/bin/npm": { status: 0, stdout: JSON.stringify({ version: "2.3.0-beta.1", engines: { node: ">=24" } }) }, node: { status: 0, stdout: "22.23.3 /opt/nvm/bin/node\n" } });
    const v = preflightUpdate(e, "@songsid/agend@2.3.0-beta.1", "2.3.0-beta.1", "the Node 22 nvm selected", muslX64);
    expect(v.kind).toBe("refuse");
    expect(calls[0]).toEqual(["/opt/nvm/bin/npm", ...manifestQuery("@songsid/agend@2.3.0-beta.1")]);
  });
  it("probe: exit 127 = no node; a version line = that Node; anything else = unknown", () => {
    expect(probeSystemNode(env({ node: { status: 127, stdout: "" } }).e, "x")).toEqual({ kind: "none" });
    expect(probeSystemNode(env({ node: { status: 0, stdout: "22.23.3 /n/node\n" } }).e, "x")).toEqual({ kind: "version", version: "22.23.3", path: "/n/node", label: "x" });
    for (const r of [{ status: null, stdout: "" }, { status: 0, stdout: "garbage" }, { status: 1, stdout: "22.23.3 /n/node" }]) {
      expect(probeSystemNode(env({ node: r }).e, "x").kind, JSON.stringify(r)).toBe("unknown");
    }
  });
});
