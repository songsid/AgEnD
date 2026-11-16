/**
 * AGEND-278: `agy models` for a NAMED account is run the way that account's agent is launched (`--app_data_dir <folder>`, with the
 * pin), so it answers as the account — never the default sign-in's list under the account's name (#3526 / D7).
 * The "binary" is a generated shell script that answers per folder (the real agy 1.5.9 does: an empty folder says "Please sign in").
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { runBackendProbe } from "../src/backend/cli-env-probe.js";
import { registerExecutableFixture } from "./support/process-guard.js";

let root: string;
const saved = process.env.AGEND_HOME;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend-agy-278-")); process.env.AGEND_HOME = join(root, "agend"); });
afterEach(() => { if (saved === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = saved; rmSync(root, { recursive: true, force: true }); });

const TOKEN = JSON.stringify({ token: { access_token: "a", refresh_token: "r" } });
/** A stand-in agy: the folder it is given decides the answer; with no folder it is the default sign-in. Every call is logged. */
function fakeAgy(): { path: string; calls: () => string[] } {
  const path = join(root, "agy"), log = join(root, "calls.log");
  writeFileSync(path, `#!/bin/sh
echo "$SSH_CONNECTION|$*" >> '${log}'
folder=""
if [ "$1" = "--app_data_dir" ]; then folder="$2"; shift 2; fi
case "$1" in
  --version) echo '1.5.9' ;;
  --help) echo '  --effort low|medium|high' >&2 ;;
  models)
    case "$folder" in
      "") printf 'default-1\\tDefault One\\n' ;;
      *work*) printf 'work-1\\tWork One\\nwork-2\\tWork Two\\n' ;;
      *) echo 'Error: Please sign in to view available models.' >&2 ;;
    esac ;;
  *) exit 1 ;;
esac
`);
  chmodSync(path, 0o755);
  registerExecutableFixture(path);
  return { path, calls: () => { try { return readFileSync(log, "utf-8").trim().split("\n"); } catch { return []; } } };
}
function backend(bin: string): AntigravityBackend {
  const be = new AntigravityBackend(join(root, "inst"), join(root, "home"), join(root, "agend"));
  (be as unknown as { binaryPath: string }).binaryPath = bin;
  return be;
}
function account(name: string, signedIn: boolean): string {
  const folder = join(root, "agend", "credential-profiles", "antigravity", name);
  mkdirSync(folder, { recursive: true });
  if (signedIn) writeFileSync(join(folder, "antigravity-oauth-token"), TOKEN);
  return folder;
}
const config = (credentialStoreHome?: string) => ({ workingDirectory: "", instanceDir: join(root, "inst"), instanceName: "probe-antigravity", mcpServers: {}, ...(credentialStoreHome ? { credentialStoreHome } : {}) });

describe("agy models as a named account", () => {
  it("the default account runs exactly `agy models`", async () => {
    const agy = fakeAgy();
    expect((await backend(agy.path).listModels(config())).map(m => m.id)).toEqual(["default-1"]);
    expect(agy.calls()).toEqual(["|models"]);
  });

  it("a signed-in named account's list is its own: the folder argument (relative to ~/.gemini) and the pin go with the call", async () => {
    const agy = fakeAgy();
    const folder = account("work", true);
    const models = await backend(agy.path).listModels(config(folder));
    expect(models.map(m => m.id)).toEqual(["work-1", "work-2"]);
    expect(agy.calls()).toHaveLength(1);
    const [pin, args] = agy.calls()[0]!.split("|");
    expect(pin).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(args).toMatch(/^--app_data_dir \S*credential-profiles\/antigravity\/work models$/);
    expect(args!.split(" ")[1]).not.toMatch(/^\//);                     // agy refuses an absolute folder
  });

  it("two accounts never share an answer, and neither is the default's", async () => {
    const agy = fakeAgy();
    const work = account("work", true), other = account("other", true);
    expect((await backend(agy.path).listModels(config(work))).map(m => m.id)).toEqual(["work-1", "work-2"]);
    expect(await backend(agy.path).listModels(config(other))).toEqual([]);   // this folder is answered "sign in"
    expect((await backend(agy.path).listModels(config())).map(m => m.id)).toEqual(["default-1"]);
  });

  it("an account with no sign-in is not asked at all: nothing runs, nothing is borrowed", async () => {
    const agy = fakeAgy();
    expect(await backend(agy.path).listModels(config(account("work", false)))).toEqual([]);
    expect(await backend(agy.path).listModels(config(join(root, "agend", "credential-profiles", "antigravity", "missing")))).toEqual([]);
    expect(agy.calls()).toEqual([]);
  });

  it("the CLI env probe of a named account carries its list, and the vendor-refresh path (the scoped catalog) no longer refuses antigravity", async () => {
    const agy = fakeAgy();
    const folder = account("work", true);
    const env = await backend(agy.path).probeCLIEnv(config(folder));
    expect(env.models.map(m => m.id)).toEqual(["work-1", "work-2"]);
    // runBackendProbe constructs its own backend; the factory resolves `agy` from PATH.
    const old = process.env.PATH;
    process.env.PATH = `${root}:${old}`;
    try {
      const result = await runBackendProbe({ mode: "env", backend: "antigravity", instanceDir: join(root, "inst"), config: { ...config(folder), backendOptions: { credential_profile: "work" } }, refreshVendorCatalog: true });
      expect(result && !Array.isArray(result) ? result.models.map(m => m.id) : result).toEqual(["work-1", "work-2"]);
    } finally { process.env.PATH = old; }
  });
});
