/**
 * #1450 PR 1: the @songsid/agend-node-<os>-<cpu> packages are built only from an official, signature-verified Node
 * release, contain only `bin/node` + `LICENSE`, install only where they run (os/cpu/libc), and never link a global
 * `node`. The end-to-end cases run offline: a throwaway GPG key signs a fake dist served on 127.0.0.1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script, no type declarations
import { buildRuntimePackages, parseShasums, PLATFORMS, RELEASE_KEYS_COMMIT, runtimeManifest } from "../scripts/runtime/build-runtime-packages.mjs";

describe("manifests and SHASUMS parsing", () => {
  it("one package per shipped platform; libc only on linux; no bin field, ever", () => {
    expect(PLATFORMS.map((p: any) => p.id)).toEqual(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);
    for (const platform of PLATFORMS) {
      const m = runtimeManifest(platform, "22.23.3");
      expect(m.name).toBe(`@songsid/agend-node-${platform.id}`);
      expect(m.version).toBe("22.23.3");
      expect(m.os).toEqual([platform.os]);
      expect(m.cpu).toEqual([platform.cpu]);
      expect(m.libc).toEqual(platform.os === "linux" ? ["glibc"] : undefined);
      expect(m.files).toEqual(["bin/node", "LICENSE"]);
      expect("bin" in m, "npm must never link this node into a global bin").toBe(false);
      expect("scripts" in m).toBe(false);
    }
    expect(runtimeManifest(PLATFORMS[0], "22.23.3", "2").version).toBe("22.23.3-agend.2");
    expect(() => runtimeManifest(PLATFORMS[0], "v22.23.3")).toThrow(/not a Node release version/);
    expect(() => runtimeManifest(PLATFORMS[0], "22.23.3", "0")).toThrow(/repack/);
  });

  it("SHASUMS256: two-space format only; anything else is an error, not a skipped line", () => {
    const sum = "a".repeat(64);
    expect(parseShasums(`${sum}  node-v1.2.3-linux-x64.tar.gz\n\n`)).toEqual({ "node-v1.2.3-linux-x64.tar.gz": sum });
    expect(() => parseShasums(`${sum} node.tar.gz`)).toThrow(/malformed/);
    expect(() => parseShasums("not a sum")).toThrow(/malformed/);
  });

  it("the release keyring is pinned to a full commit", () => {
    expect(RELEASE_KEYS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

const haveGpg = spawnSync("gpg", ["--version"]).status === 0 && spawnSync("gpgv", ["--version"]).status === 0;

describe.skipIf(!haveGpg)("end to end against a signed fake dist (offline)", () => {
  const root = mkdtempSync(join(tmpdir(), "agrt-"));
  const version = "1.2.3";
  let server: Server;
  let distUrl = "";
  const gpgHome = (name: string) => {
    const home = join(root, name);
    mkdirSync(home, { mode: 0o700 });
    execFileSync("gpg", ["--batch", "--passphrase", "", "--quick-gen-key", `AgEnD ${name} <${name}@example.invalid>`, "ed25519", "sign", "never"], { env: { ...process.env, GNUPGHOME: home }, stdio: "ignore" });
    return home;
  };
  let trusted = "", stranger = "", keyring = "";
  const dist = join(root, "dist", `v${version}`);
  const sign = (home: string) => execFileSync("gpg", ["--batch", "--yes", "--detach-sign", "-o", join(dist, "SHASUMS256.txt.sig"), join(dist, "SHASUMS256.txt")], { env: { ...process.env, GNUPGHOME: home }, stdio: "ignore" });
  const writeSums = (omit?: string) => {
    const lines = readdirSync(dist).filter(f => f.endsWith(".tar.gz") && f !== omit)
      .map(f => `${createHash("sha256").update(readFileSync(join(dist, f))).digest("hex")}  ${f}`);
    writeFileSync(join(dist, "SHASUMS256.txt"), lines.join("\n") + "\n");
  };

  beforeAll(async () => {
    trusted = gpgHome("trusted");
    stranger = gpgHome("stranger");
    keyring = join(root, "trusted.gpg");
    writeFileSync(keyring, execFileSync("gpg", ["--export"], { env: { ...process.env, GNUPGHOME: trusted } }));
    mkdirSync(dist, { recursive: true });
    for (const platform of PLATFORMS) {
      const top = join(root, "src", `node-v${version}-${platform.id}`);
      mkdirSync(join(top, "bin"), { recursive: true });
      writeFileSync(join(top, "bin", "node"), `#!/bin/sh\necho fake-node ${platform.id}\n`);
      chmodSync(join(top, "bin", "node"), 0o755);
      writeFileSync(join(top, "LICENSE"), "Node.js license\n");
      writeFileSync(join(top, "README.md"), "must not be shipped\n");
      mkdirSync(join(top, "lib", "node_modules", "npm"), { recursive: true });
      writeFileSync(join(top, "lib", "node_modules", "npm", "package.json"), "{}");
      execFileSync("tar", ["-czf", join(dist, `node-v${version}-${platform.id}.tar.gz`), "-C", join(root, "src"), `node-v${version}-${platform.id}`]);
    }
    writeSums();
    sign(trusted);
    server = createServer((req, res) => {
      const file = join(root, "dist", decodeURIComponent((req.url ?? "/").split("?")[0]!));
      if (!file.startsWith(join(root, "dist")) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(readFileSync(file));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    distUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => {
    server?.close();
    for (const home of [trusted, stranger]) if (home) spawnSync("gpgconf", ["--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: home } });
    rmSync(root, { recursive: true, force: true });
  });
  const build = (out: string) => buildRuntimePackages({ node: version, out, distUrl, keyring, log: () => {} });

  it("builds four packages with only bin/node (executable), LICENSE and package.json", async () => {
    const out = join(root, "out-ok");
    const built = await build(out);
    expect(built.map((b: any) => b.name)).toEqual(PLATFORMS.map((p: any) => `@songsid/agend-node-${p.id}`));
    for (const platform of PLATFORMS) {
      const dir = join(out, `agend-node-${platform.id}`);
      expect(readdirSync(dir).sort()).toEqual(["LICENSE", "bin", "package.json"]);
      expect(readdirSync(join(dir, "bin"))).toEqual(["node"]);
      expect(statSync(join(dir, "bin", "node")).mode & 0o111).not.toBe(0);
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      expect(manifest.agendRuntime).toMatchObject({ node: version, tarball: `node-v${version}-${platform.id}.tar.gz` });
      expect(manifest.agendRuntime.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("a tarball that does not match the signed sum is refused", async () => {
    const victim = join(dist, `node-v${version}-darwin-arm64.tar.gz`);
    const good = readFileSync(victim);
    writeFileSync(victim, Buffer.concat([good, Buffer.from("tampered")]));
    try {
      await expect(build(join(root, "out-tampered"))).rejects.toThrow(/does not match the signed/);
    } finally { writeFileSync(victim, good); }
  });

  it("SHASUMS signed by a key outside the release keyring is refused", async () => {
    sign(stranger);
    try {
      await expect(build(join(root, "out-stranger"))).rejects.toThrow(/signature check failed/);
    } finally { sign(trusted); }
  });

  it("a platform missing from the signed SHASUMS is refused", async () => {
    writeSums(`node-v${version}-linux-arm64.tar.gz`);
    sign(trusted);
    try {
      await expect(build(join(root, "out-missing"))).rejects.toThrow(/not in the signed SHASUMS256/);
    } finally { writeSums(); sign(trusted); }
  });
});
