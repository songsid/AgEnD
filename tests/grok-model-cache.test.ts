import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const io = vi.hoisted(() => ({ defaultHome: "", afterStat: null as (() => void) | null, failRead: false, readBytes: 0, readCalls: 0, closes: 0 }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => io.defaultHome };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync(fd: number) {
      const stat = actual.fstatSync(fd);
      io.afterStat?.();
      return stat;
    },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
      io.readCalls++;
      if (io.failRead) throw new Error("synthetic read failure");
      const count = actual.readSync(fd, buffer, offset, length, position);
      io.readBytes += count;
      return count;
    },
    closeSync(fd: number) { io.closes++; actual.closeSync(fd); },
  };
});
import { readGrokModelCache } from "../src/backend/grok-model-cache.js";

const CAP = 1024 * 1024;
let scratch: string;
const cache = (home: string, data: unknown) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "models_cache.json"), JSON.stringify(data));
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "agend-grok-model-cache-"));
  io.defaultHome = join(scratch, "default-home");
  io.afterStat = null; io.failRead = false; io.readBytes = 0; io.readCalls = 0; io.closes = 0;
  vi.stubEnv("GROK_HOME", "");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });

describe("offline Grok model-cache choices", () => {
  it("uses the map key and whitelisted display fields without leaking credentials from the same cache", () => {
    const secret = "CREDENTIAL_CANARY_MUST_NOT_LEAVE_CACHE";
    cache(scratch, {
      fetched_at: "2000-01-01T00:00:00Z", identity: { access_token: secret }, api_key: secret,
      models: {
        "grok-4.7": { info: { id: "grok-wrong-info-id", name: "  Grok 4.7  ", description: "  Account model  ", hidden: false, headers: { authorization: secret } }, api_key: secret, env_key: secret, api_base_url: secret, headers: { authorization: secret } },
        "grok-key-alias": { info: { id: secret, name: "Alias" }, api_key: secret },
      },
    });
    const models = readGrokModelCache(scratch);
    expect(models).toEqual([{ id: "grok-4.7", label: "Grok 4.7", description: "Account model" }, { id: "grok-key-alias", label: "Alias" }]);
    expect(JSON.stringify(models)).not.toContain(secret);
    expect(models.map(Object.keys)).toEqual([["id", "label", "description"], ["id", "label"]]);
    expect(io.closes).toBe(1);
  });

  it("excludes hidden or invalid IDs, bounds metadata and falls back to the key when metadata is absent", () => {
    cache(scratch, { models: {
      "grok-visible": { info: { name: " ", description: 42 } },
      "grok-without-info": {},
      "grok-bounded": { info: { name: `  ${"N".repeat(200)}  `, description: `  ${"D".repeat(1100)}  ` } },
      "grok-hidden": { info: { name: "Hidden", hidden: true } },
      "claude-other-provider": { info: { name: "Other" } },
      "grok-bad key": {}, "grok-;shell": {}, "grok-\ncontrol": {}, ["grok-" + "x".repeat(156)]: {},
    } });
    expect(readGrokModelCache(scratch)).toEqual([
      { id: "grok-visible", label: "grok-visible" },
      { id: "grok-without-info", label: "grok-without-info" },
      { id: "grok-bounded", label: "N".repeat(160), description: "D".repeat(1000) },
    ]);
  });

  it("honors an explicit home, a trimmed GROK_HOME, then the private default home without applying its own TTL", () => {
    const envHome = join(scratch, "env"), explicitHome = join(scratch, "explicit"), defaultHome = join(io.defaultHome, ".grok");
    cache(envHome, { models: { "grok-env": {} } });
    cache(explicitHome, { models: { "grok-explicit": {} } });
    cache(defaultHome, { fetched_at: "2000-01-01T00:00:00Z", models: { "grok-default": {} } });
    vi.stubEnv("GROK_HOME", `  ${envHome}  `);
    expect(readGrokModelCache(explicitHome)).toEqual([{ id: "grok-explicit", label: "grok-explicit" }]);
    expect(readGrokModelCache()).toEqual([{ id: "grok-env", label: "grok-env" }]);
    vi.stubEnv("GROK_HOME", "  ");
    expect(readGrokModelCache()).toEqual([{ id: "grok-default", label: "grok-default" }]);
  });

  it.each(["", "{broken", "null", "[]", '{"models":[]}', '{"models":{}}'])("returns no choices for empty or invalid cache content: %j", (content) => {
    writeFileSync(join(scratch, "models_cache.json"), content);
    expect(readGrokModelCache(scratch)).toEqual([]);
    expect(io.closes).toBe(1);
  });

  it("refuses missing, nonregular and oversized cache files before reading", () => {
    expect(readGrokModelCache(scratch)).toEqual([]);
    const folder = join(scratch, "directory");
    mkdirSync(join(folder, "models_cache.json"), { recursive: true });
    expect(readGrokModelCache(folder)).toEqual([]);
    writeFileSync(join(scratch, "models_cache.json"), " ".repeat(CAP + 1));
    expect(readGrokModelCache(scratch)).toEqual([]);
    expect(io.readCalls).toBe(0);
  });

  it("bounds bytes even if a valid JSON file grows after fstat and still closes it", () => {
    cache(scratch, { models: { "grok-small": {} } });
    io.afterStat = () => appendFileSync(join(scratch, "models_cache.json"), " ".repeat(CAP + 64));
    expect(readGrokModelCache(scratch)).toEqual([]);
    expect(io.readBytes).toBe(CAP + 1);
    expect(io.closes).toBe(1);
  });

  it("returns no choices and closes the descriptor after a read error", () => {
    cache(scratch, { models: { "grok-readable": {} } });
    io.failRead = true;
    expect(readGrokModelCache(scratch)).toEqual([]);
    expect(io.readCalls).toBe(1);
    expect(io.closes).toBe(1);
  });
});
