import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * AgEnD's codex probe only READS $CODEX_HOME/models_cache.json; codex writes
 * it. So re-reading the file is not a refresh — "🔄 Refresh models" (#886) has
 * to make codex fetch. Measured on codex 0.156.0: `codex debug models` refetches
 * when the cache is older than codex's own ~5-minute TTL and rewrites the file.
 *
 * A stub `codex` stands in for the real one here: it records how it was called
 * and writes the catalog the way codex does, which is what refreshModelCatalog
 * relies on.
 */

let root: string;
let bin: string;
let shared: string;
let calls: string;
const realPath = process.env.PATH;
const realCodexHome = process.env.CODEX_HOME;

const catalog = (...slugs: string[]) => JSON.stringify({
  fetched_at: new Date().toISOString(),
  models: slugs.map(slug => ({ slug, display_name: slug, visibility: "list" })),
});

function stubCodex(behaviour: "refetch" | "fail") {
  writeFileSync(join(bin, "codex"), [
    "#!/usr/bin/env bash",
    `printf '%s|%s\\n' "$*" "$CODEX_HOME" >> '${calls}'`,
    behaviour === "fail"
      ? "echo 'error: failed to fetch models' >&2; exit 1"
      : `printf '%s' '${catalog("gpt-6-astra", "gpt-5.6-sol")}' > "$CODEX_HOME/models_cache.json"`,
  ].join("\n"));
  chmodSync(join(bin, "codex"), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-codex-refresh-"));
  bin = join(root, "bin");
  shared = join(root, "shared-codex-home");
  calls = join(root, "calls");
  mkdirSync(bin);
  mkdirSync(shared);
  writeFileSync(join(shared, "models_cache.json"), catalog("gpt-5.6-sol"));   // the stale list
  process.env.PATH = `${bin}:${realPath ?? ""}`;
  process.env.CODEX_HOME = shared;
});
afterEach(() => {
  process.env.PATH = realPath;
  if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome;
  rmSync(root, { recursive: true, force: true });
});

const recorded = () => existsSync(calls)
  ? readFileSync(calls, "utf8").trim().split("\n").map(l => { const [args, home] = l.split("|"); return { args, home }; })
  : [];

describe("CodexBackend.refreshModelCatalog", () => {
  it("makes codex refetch, so the next read sees a model the stale cache lacked", async () => {
    stubCodex("refetch");
    const backend = new CodexBackend(join(root, "instance"));
    expect((await backend.listModels()).map(m => m.id)).toEqual(["gpt-5.6-sol"]);

    await backend.refreshModelCatalog();

    expect((await backend.listModels()).map(m => m.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
  });

  it("asks for the live catalog, never the bundled one", async () => {
    // `--bundled` means "skip refresh"; passing it would make the button a no-op.
    stubCodex("refetch");
    await new CodexBackend(join(root, "instance")).refreshModelCatalog();
    expect(recorded().map(c => c.args)).toEqual(["debug models"]);
  });

  it("refreshes the CODEX_HOME that listModels will read", async () => {
    // An instance with its own isolated home reads THAT cache, so the refetch
    // has to land there — refreshing the shared one would change nothing it shows.
    stubCodex("refetch");
    const instanceDir = join(root, "instance");
    mkdirSync(join(instanceDir, "codex-home"), { recursive: true });
    writeFileSync(join(instanceDir, "codex-home", "models_cache.json"), catalog("gpt-5.6-sol"));
    const backend = new CodexBackend(instanceDir);

    await backend.refreshModelCatalog();

    expect(recorded()[0].home).toBe(join(instanceDir, "codex-home"));
    expect((await backend.listModels()).map(m => m.id)).toContain("gpt-6-astra");
  });

  it("fails loudly when codex cannot fetch, so a stale list is not called fresh", async () => {
    stubCodex("fail");
    await expect(new CodexBackend(join(root, "instance")).refreshModelCatalog()).rejects.toThrow();
  });
});
