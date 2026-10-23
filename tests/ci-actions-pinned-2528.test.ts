import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { extractUses } from "../scripts/ci/assert-actions-pinned.mjs";

const script = join(process.cwd(), "scripts/ci/assert-actions-pinned.mjs");
const run = (root: string) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8" }),
      stderr: "",
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

describe("assert-actions-pinned (#2528)", () => {
  it("passes on this checkout", () => {
    const r = run(process.cwd());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/every remote uses: is a 40-char SHA/);
  });

  it("fails on a tag-pinned uses:", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-actions-pin-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, ".github/workflows/x.yml"), "jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n");
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a local composite path", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-actions-local-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/x.yml"),
        "jobs:\n  j:\n    steps:\n      - uses: ./.github/actions/published-agend-tarball\n",
      );
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses YAML with the lockfile's js-yaml 4.3.2 after npm ci", () => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
    };
    expect(lock.packages["node_modules/js-yaml"]).toMatchObject({
      version: "4.3.2",
      resolved: "https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.2.tgz",
      integrity: "sha512-SFNOvSJ+Dgf/9An904Yx+CgSlIPCkIpao4qo51lpee25TIRejdH3rhR4EZMGoNx3/TP3O+wzWuiTFl4sqbltzA==",
    });
    const src = readFileSync(script, "utf8");
    expect(src).toMatch(/from ["']js-yaml["']/);
    expect(src).not.toMatch(/vendor\/js-yaml/);
    expect(existsSync(join(process.cwd(), "scripts/ci/vendor"))).toBe(false);

    const ci = yaml.load(readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8")) as {
      jobs: { "actions-pinned": { steps: Array<{ uses?: string; run?: string; with?: { "node-version"?: string } }> } };
    };
    const steps = ci.jobs["actions-pinned"].steps;
    expect(steps.map(s => s.uses ?? s.run)).toEqual([
      expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
      expect.stringMatching(/^actions\/setup-node@[0-9a-f]{40}$/),
      "npm ci --ignore-scripts",
      "node scripts/ci/assert-actions-pinned.mjs",
    ]);
    expect(String(steps[1]!.with?.["node-version"])).toBe("22");
  });

  it("groups github-actions patch and minor; majors stay ungrouped (#2528)", () => {
    const cfg = yaml.load(readFileSync(join(process.cwd(), ".github/dependabot.yml"), "utf8")) as {
      updates: Array<{
        "package-ecosystem"?: string;
        groups?: Record<string, { "update-types"?: string[]; "applies-to"?: string; patterns?: string[] }>;
      }>;
    };
    const ga = cfg.updates.find(u => u["package-ecosystem"] === "github-actions");
    expect(ga?.groups).toBeTruthy();
    const types = Object.values(ga!.groups!).flatMap(g => g["update-types"] ?? []);
    expect(new Set(types)).toEqual(new Set(["minor", "patch"]));
    expect(types).not.toContain("major");
    expect(Object.values(ga!.groups!).every(g => (g.patterns ?? []).includes("*"))).toBe(true);
  });

  it("accepts a 40-char SHA with a tag comment", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-actions-sha-"));
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/x.yml"),
        "jobs:\n  j:\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n",
      );
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function usesFromParsed(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (n == null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === "uses") out.push(String(v));
      walk(v);
    }
  };
  walk(doc);
  return out;
}

function yamlFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yamlFiles(p, acc);
    else if (name.endsWith(".yml") || name.endsWith(".yaml")) acc.push(p);
  }
  return acc;
}

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const LOCAL = "./.github/actions/published-agend-tarball";

function scratch(kind: "workflows" | "actions", body: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-actions-yml-"));
  const sub = kind === "workflows" ? ".github/workflows" : ".github/actions/x";
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, kind === "workflows" ? "x.yml" : "action.yml"), body);
  return dir;
}

describe.each(["workflows", "actions"] as const)("parsed YAML uses: in %s (#2528 Prism r1)", kind => {
  it("fails a quoted-key unpinned uses", () => {
    const body = "runs:\n  steps:\n    - \"uses\": actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a flow-style unpinned uses", () => {
    const body = "runs:\n  steps: [{uses: actions/checkout@v4}]\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a quoted-key full SHA and a local path", () => {
    const body = `runs:\n  steps:\n    - "uses": actions/checkout@${SHA} # v4.4.0\n    - "uses": ${LOCAL}\n`;
    expect(usesFromParsed(yaml.load(body))).toEqual([`actions/checkout@${SHA}`, LOCAL]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a flow-style full SHA and a local path", () => {
    const body = `runs:\n  steps: [{uses: actions/checkout@${SHA}}, {uses: ${LOCAL}}]\n`;
    expect(usesFromParsed(yaml.load(body))).toEqual([`actions/checkout@${SHA}`, LOCAL]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assert-actions-pinned yaml oracle (#2528)", () => {
  it("extractUses matches js-yaml uses values on this checkout", () => {
    const files = yamlFiles(join(process.cwd(), ".github/workflows"))
      .concat(yamlFiles(join(process.cwd(), ".github/actions")));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const fromYaml = usesFromParsed(yaml.load(text));
      const hits = extractUses(text);
      expect(hits.filter(h => h.unsupported), f).toEqual([]);
      expect(hits.map(h => h.value).sort(), f).toEqual([...fromYaml].sort());
    }
  });
});

describe.each(["workflows", "actions"] as const)("parsed YAML uses: in %s (#2528 Prism r3)", kind => {
  it("fails unpinned uses after a block-scalar name |", () => {
    const body = "runs:\n  steps:\n    - name: |\n        Checkout the project\n      uses: actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails unpinned uses after a block-scalar name >", () => {
    const body = "runs:\n  steps:\n    - name: >\n        Checkout the project\n      uses: actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts SHA and local uses after a block-scalar name |", () => {
    const body =
      `runs:\n  steps:\n    - name: |\n        Checkout the project\n      uses: actions/checkout@${SHA}\n    - name: |\n        Local\n      uses: ${LOCAL}\n`;
    expect(usesFromParsed(yaml.load(body))).toEqual([`actions/checkout@${SHA}`, LOCAL]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails an anchored-key unpinned uses", () => {
    const body = "runs:\n  steps:\n    - &key uses: actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a flow anchored-key unpinned uses", () => {
    const body = "runs:\n  steps:\n    - {&key uses: actions/checkout@v4}\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a tagged-key unpinned uses", () => {
    const body = "runs:\n  steps:\n    - !!str uses: actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails an explicit flow-key unpinned uses", () => {
    const body = "runs:\n  steps:\n    - {? uses: actions/checkout@v4}\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts SHA and local uses with an anchored key", () => {
    const body =
      `runs:\n  steps:\n    - &key uses: actions/checkout@${SHA}\n    - uses: ${LOCAL}\n`;
    expect(usesFromParsed(yaml.load(body))).toEqual([`actions/checkout@${SHA}`, LOCAL]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(["workflows", "actions"] as const)("parsed YAML uses: in %s (#2528 Prism r2)", kind => {
  it("fails a next-line scalar unpinned uses", () => {
    const body = "runs:\n  steps:\n    - uses:\n        actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a unicode-escaped quoted-key unpinned uses", () => {
    const body = "runs:\n  steps:\n    - \"u\\u0073es\": actions/checkout@v4\n";
    expect(usesFromParsed(yaml.load(body))).toEqual(["actions/checkout@v4"]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("actions/checkout@v4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a next-line scalar full SHA and a local path", () => {
    const body =
      `runs:\n  steps:\n    - uses:\n        actions/checkout@${SHA}\n    - uses:\n        ${LOCAL}\n`;
    expect(usesFromParsed(yaml.load(body))).toEqual([`actions/checkout@${SHA}`, LOCAL]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a unicode-escaped quoted-key full SHA and a local path", () => {
    const body =
      `runs:\n  steps:\n    - "u\\u0073es": actions/checkout@${SHA}\n    - "u\\u0073es": ${LOCAL}\n`;
    expect(usesFromParsed(yaml.load(body))).toEqual([`actions/checkout@${SHA}`, LOCAL]);
    const dir = scratch(kind, body);
    try {
      const r = run(dir);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

