import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, type Mode, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const io = vi.hoisted(() => ({
  defaultHome: "", afterStat: null as (() => void) | null, failRead: false, failStat: false, failClose: false,
  readGate: null as Promise<void> | null, readChunk: Infinity,
  readBytes: 0, readCalls: 0, closes: 0, syncCalls: 0, openFlags: [] as Array<string | number>,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => io.defaultHome };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const syncIo = () => { io.syncCalls++; throw new Error("synchronous cache I/O on the event loop"); };
  return { ...actual, openSync: syncIo, fstatSync: syncIo, readSync: syncIo };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(path: PathLike, flags: string | number, mode?: Mode) {
      io.openFlags.push(flags);
      const file = await actual.open(path, flags, mode);
      return {
        async stat() {
          if (io.failStat) throw new Error("synthetic stat failure");
          const stat = await file.stat();
          io.afterStat?.();
          return stat;
        },
        async read(buffer: Buffer, offset: number, length: number, position: number | null) {
          io.readCalls++;
          if (io.readGate) await io.readGate;
          if (io.failRead) throw new Error("synthetic read failure");
          const result = await file.read(buffer, offset, Math.min(length, io.readChunk), position);
          io.readBytes += result.bytesRead;
          return result;
        },
        async close() {
          io.closes++;
          await file.close();
          if (io.failClose) throw new Error("synthetic close failure");
        },
      };
    },
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
  io.afterStat = null; io.failRead = false; io.failStat = false; io.failClose = false; io.readGate = null; io.readChunk = Infinity;
  io.readBytes = 0; io.readCalls = 0; io.closes = 0; io.syncCalls = 0; io.openFlags = [];
  vi.stubEnv("GROK_HOME", "");
});

afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });

describe("offline Grok model-cache choices", () => {
  it("uses the map key and whitelisted display fields without leaking credentials from the same cache", async () => {
    const secret = "CREDENTIAL_CANARY_MUST_NOT_LEAVE_CACHE";
    cache(scratch, {
      fetched_at: "2000-01-01T00:00:00Z", identity: { access_token: secret }, api_key: secret,
      models: {
        "grok-4.7": { info: { id: "grok-wrong-info-id", name: "  Grok 4.7  ", description: "  Account model  ", hidden: false, headers: { authorization: secret } }, api_key: secret, env_key: secret, api_base_url: secret, headers: { authorization: secret } },
        "grok-key-alias": { info: { id: secret, name: "Alias" }, api_key: secret },
      },
    });
    const models = await readGrokModelCache(scratch);
    expect(models).toEqual([{ id: "grok-4.7", label: "Grok 4.7", description: "Account model" }, { id: "grok-key-alias", label: "Alias" }]);
    expect(JSON.stringify(models)).not.toContain(secret);
    expect(models.map(Object.keys)).toEqual([["id", "label", "description"], ["id", "label"]]);
    expect(io.closes).toBe(1);
    expect(io.syncCalls).toBe(0);
  });

  it("excludes hidden or invalid IDs, bounds metadata and falls back to the key when metadata is absent", async () => {
    cache(scratch, { models: {
      "grok-visible": { info: { name: " ", description: 42 } },
      "grok-without-info": {},
      "grok-bounded": { info: { name: `  ${"N".repeat(200)}  `, description: `  ${"D".repeat(1100)}  ` } },
      "grok-hidden": { info: { name: "Hidden", hidden: true } },
      "claude-other-provider": { info: { name: "Other" } },
      "grok-bad key": {}, "grok-;shell": {}, "grok-\ncontrol": {}, ["grok-" + "x".repeat(156)]: {},
    } });
    expect(await readGrokModelCache(scratch)).toEqual([
      { id: "grok-visible", label: "grok-visible" },
      { id: "grok-without-info", label: "grok-without-info" },
      { id: "grok-bounded", label: "N".repeat(160), description: "D".repeat(1000) },
    ]);
  });

  it("honors an explicit home, a trimmed GROK_HOME, then the private default home without applying its own TTL", async () => {
    const envHome = join(scratch, "env"), explicitHome = join(scratch, "explicit"), defaultHome = join(io.defaultHome, ".grok");
    cache(envHome, { models: { "grok-env": {} } });
    cache(explicitHome, { models: { "grok-explicit": {} } });
    cache(defaultHome, { fetched_at: "2000-01-01T00:00:00Z", models: { "grok-default": {} } });
    vi.stubEnv("GROK_HOME", `  ${envHome}  `);
    expect(await readGrokModelCache(explicitHome)).toEqual([{ id: "grok-explicit", label: "grok-explicit" }]);
    expect(await readGrokModelCache()).toEqual([{ id: "grok-env", label: "grok-env" }]);
    vi.stubEnv("GROK_HOME", "  ");
    expect(await readGrokModelCache()).toEqual([{ id: "grok-default", label: "grok-default" }]);
  });

  it.each(["", "{broken", "null", "[]", '{"models":[]}', '{"models":{}}'])("returns no choices for empty or invalid cache content: %j", async (content) => {
    writeFileSync(join(scratch, "models_cache.json"), content);
    expect(await readGrokModelCache(scratch)).toEqual([]);
    expect(io.closes).toBe(1);
  });

  it("refuses missing, nonregular and oversized cache files before reading", async () => {
    expect(await readGrokModelCache(scratch)).toEqual([]);
    const folder = join(scratch, "directory");
    mkdirSync(join(folder, "models_cache.json"), { recursive: true });
    expect(await readGrokModelCache(folder)).toEqual([]);
    writeFileSync(join(scratch, "models_cache.json"), " ".repeat(CAP + 1));
    expect(await readGrokModelCache(scratch)).toEqual([]);
    expect(io.readCalls).toBe(0);
    expect(io.openFlags.every(flags => flags === (constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)))).toBe(true);
  });

  it.skipIf(process.platform === "win32" || !constants.O_NOFOLLOW)("refuses a symlink at the final cache component before reading", async () => {
    const target = join(scratch, "private-target.json");
    writeFileSync(target, JSON.stringify({ models: { "grok-not-through-symlink": {} } }));
    symlinkSync(target, join(scratch, "models_cache.json"));
    expect(await readGrokModelCache(scratch)).toEqual([]);
    expect(io.readCalls).toBe(0);
    expect(io.closes).toBe(0);
  });

  it("allows an exact-cap regular cache, including partial asynchronous reads", async () => {
    const content = JSON.stringify({ models: { "grok-at-cap": {} } });
    writeFileSync(join(scratch, "models_cache.json"), content + " ".repeat(CAP - Buffer.byteLength(content)));
    io.readChunk = 8192;
    expect(await readGrokModelCache(scratch)).toEqual([{ id: "grok-at-cap", label: "grok-at-cap" }]);
    expect(io.readBytes).toBe(CAP);
    expect(io.readCalls).toBeGreaterThan(1);
    expect(io.closes).toBe(1);
  });

  it("bounds bytes even if a valid JSON file grows after fstat and still closes it", async () => {
    cache(scratch, { models: { "grok-small": {} } });
    io.afterStat = () => appendFileSync(join(scratch, "models_cache.json"), " ".repeat(CAP + 64));
    expect(await readGrokModelCache(scratch)).toEqual([]);
    expect(io.readBytes).toBe(CAP + 1);
    expect(io.closes).toBe(1);
  });

  it("keeps a held asynchronous file read pending while the event loop can continue", async () => {
    cache(scratch, { models: { "grok-async": {} } });
    let release!: () => void;
    io.readGate = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const pending = readGrokModelCache(scratch).then(models => { settled = true; return models; });
    let models;
    try {
      await vi.waitFor(() => expect(io.readCalls).toBe(1));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(io.closes).toBe(0);
      expect(io.syncCalls).toBe(0);
    } finally {
      release();
      models = await pending;
    }
    expect(models).toEqual([{ id: "grok-async", label: "grok-async" }]);
    expect(io.closes).toBe(1);
  });

  it.each(["stat", "read"])("returns no choices and closes the descriptor after a %s error", async (operation) => {
    cache(scratch, { models: { "grok-readable": {} } });
    io.failStat = operation === "stat";
    io.failRead = operation === "read";
    expect(await readGrokModelCache(scratch)).toEqual([]);
    expect(io.readCalls).toBe(operation === "read" ? 1 : 0);
    expect(io.closes).toBe(1);
  });

  it("contains a close failure after completing the bounded read", async () => {
    cache(scratch, { models: { "grok-readable": {} } });
    io.failClose = true;
    expect(await readGrokModelCache(scratch)).toEqual([{ id: "grok-readable", label: "grok-readable" }]);
    expect(io.closes).toBe(1);
  });
});
