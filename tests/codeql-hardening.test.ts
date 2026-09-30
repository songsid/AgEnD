import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureWorkspaceGit } from "../src/paths.js";
import { FleetManager } from "../src/fleet-manager.js";
import { builtinStatusEmojis } from "../src/status-emojis.js";

const tempDirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-codeql-"));
  tempDirs.push(dir);
  return dir;
}

const globalTargets = [Object.prototype, Object, Object.prototype.toString, Object.prototype.hasOwnProperty];
const fields = ["display_name", "description"] as const;
let globalDescriptors: Array<{ target: object; field: string; descriptor: PropertyDescriptor | undefined }>;
beforeEach(() => {
  globalDescriptors = globalTargets.flatMap(target => [...fields, "status_emojis"].map(field => ({
    target, field, descriptor: Object.getOwnPropertyDescriptor(target, field),
  })));
});
afterEach(() => {
  // Restore even when a pollution mutation fails, so it cannot affect later tests.
  for (const { target, field, descriptor } of globalDescriptors) {
    if (descriptor) Object.defineProperty(target, field, descriptor);
    else Reflect.deleteProperty(target, field);
  }
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectGlobalsUnchanged(): void {
  for (const { target, field, descriptor } of globalDescriptors) {
    expect(Object.getOwnPropertyDescriptor(target, field), `${field} on an inherited target`).toEqual(descriptor);
  }
}

describe("git-init command injection (CodeQL #7)", () => {
  it("initialises a real repository in a directory containing spaces and Unicode", () => {
    const dir = join(temp(), "workspace with spaces 測試");
    mkdirSync(dir);
    ensureWorkspaceGit(dir);
    expect(execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim()).toBe("true");
  });

  it.each(["quote breakout", "command substitution", "backticks"])("keeps %s payload literal without executing its marker", kind => {
    const root = temp();
    const marker = join(root, "PWNED");
    const names: Record<string, string> = {
      "quote breakout": `workspace"; touch ${marker}; #`,
      "command substitution": `workspace$(touch ${marker})`,
      backticks: "workspace`touch " + marker + "`",
    };
    // Keep the absolute marker path intact inside the payload: rewriting its
    // slashes would accidentally make the original injection test harmless.
    const dir = join(root, names[kind]);
    mkdirSync(dir, { recursive: true });
    expect(existsSync(marker)).toBe(false);
    ensureWorkspaceGit(dir);
    expect(existsSync(marker), "shell payload must not execute").toBe(false);
    expect(existsSync(join(dir, ".git")), "the exact literal path must be initialised").toBe(true);
  });

  it.each(["--bare", "-x"])("treats a relative %s directory as a path, not a git option", name => {
    const root = temp();
    mkdirSync(join(root, name));
    // Give a child its own cwd rather than changing the test worker's cwd.
    const module = new URL("../src/paths.ts", import.meta.url).href;
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const program = `import { ensureWorkspaceGit } from ${JSON.stringify(module)}; ensureWorkspaceGit(process.argv[1]);`;
    execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", program, "--", name], { cwd: root });
    expect(existsSync(join(root, name, ".git"))).toBe(true);
    expect(existsSync(join(root, "HEAD")), "git must not create a bare repository in the cwd").toBe(false);
  });

  it("preserves an existing .git file and keeps failed initialisation best effort", () => {
    const existing = temp();
    writeFileSync(join(existing, ".git"), "gitdir: /nonexistent/owned-test-repo\n");
    ensureWorkspaceGit(existing);
    expect(readFileSync(join(existing, ".git"), "utf8")).toBe("gitdir: /nonexistent/owned-test-repo\n");
    const file = join(temp(), "not-a-directory");
    writeFileSync(file, "keep me");
    expect(() => ensureWorkspaceGit(file)).not.toThrow();
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });
});

describe("identity metadata prototype pollution (CodeQL #9/#10)", () => {
  function fleet(instances: Record<string, unknown> = { alpha: { working_directory: "/tmp" } }) {
    const fm = new FleetManager(temp());
    const internal = fm as any;
    internal.fleetConfig = { instances, defaults: {} };
    const save = vi.spyOn(internal, "saveFleetConfig").mockImplementation(() => {});
    return { fm, internal, save, instances };
  }

  it("persists name and description for an own fleet instance through both HTTP tools", async () => {
    const h = fleet();
    await expect(h.fm.handleSetDisplayNameHttp("alpha", "Alpha")).resolves.toEqual({ display_name: "Alpha" });
    await expect(h.fm.handleSetDescriptionHttp("alpha", "does things")).resolves.toEqual({ description: "does things" });
    expect(h.instances.alpha).toMatchObject({ display_name: "Alpha", description: "does things" });
    expect(h.save).toHaveBeenCalledTimes(2);
    expectGlobalsUnchanged();
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"].flatMap(name =>
    fields.map(field => ({ name, field })),
  ))("refuses inherited $name for $field without changing a global target", async ({ name, field }) => {
    const h = fleet();
    const result = field === "display_name"
      ? await h.fm.handleSetDisplayNameHttp(name, "pwned")
      : await h.fm.handleSetDescriptionHttp(name, "pwned");
    expectGlobalsUnchanged();
    expect(result).toEqual({ error: `Instance '${name}' not found` });
    expect(h.save).not.toHaveBeenCalled();
    expect(Object.keys(h.instances)).toEqual(["alpha"]);
  });

  it("refuses a custom inherited config entry rather than mutating it", async () => {
    const entry = { working_directory: "/tmp" };
    const h = fleet(Object.create({ shadow: entry }));
    await expect(h.fm.handleSetDisplayNameHttp("shadow", "Shadow")).resolves.toHaveProperty("error");
    await expect(h.fm.handleSetDescriptionHttp("shadow", "pwned")).resolves.toHaveProperty("error");
    expect(entry).toEqual({ working_directory: "/tmp" });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("accepts explicit own special-name entries from parsed config without touching prototypes", async () => {
    const instances = JSON.parse('{"__proto__":{"working_directory":"/tmp"},"constructor":{"working_directory":"/tmp"},"hasOwnProperty":{"working_directory":"/tmp"}}');
    const h = fleet(instances);
    for (const name of ["__proto__", "constructor", "hasOwnProperty"]) {
      await expect(h.fm.handleSetDisplayNameHttp(name, "Registered")).resolves.toEqual({ display_name: "Registered" });
      await expect(h.fm.handleSetDescriptionHttp(name, "own entry")).resolves.toEqual({ description: "own entry" });
      expect(instances[name]).toMatchObject({ display_name: "Registered", description: "own entry" });
    }
    expect(Object.getPrototypeOf(instances)).toBe(Object.prototype);
    expect(h.save).toHaveBeenCalledTimes(6);
    expectGlobalsUnchanged();
  });

  it("supports a null-prototype instance dictionary", async () => {
    const instances = Object.assign(Object.create(null), { alpha: { working_directory: "/tmp" } });
    const h = fleet(instances);
    await expect(h.fm.handleSetDisplayNameHttp("alpha", "Alpha")).resolves.toEqual({ display_name: "Alpha" });
    await expect(h.fm.handleSetDescriptionHttp("__proto__", "pwned")).resolves.toHaveProperty("error");
    expectGlobalsUnchanged();
  });

  it("preserves the Classic registry fallback when no own fleet entry exists", async () => {
    const h = fleet();
    const setDisplayNameByInstance = vi.fn(() => true);
    const setDescriptionByInstance = vi.fn(() => true);
    h.internal.classicChannels = { setDisplayNameByInstance, setDescriptionByInstance };
    await expect(h.fm.handleSetDisplayNameHttp("classic-worker", "Classic")).resolves.toEqual({ display_name: "Classic" });
    await expect(h.fm.handleSetDescriptionHttp("classic-worker", "legacy")).resolves.toEqual({ description: "legacy" });
    expect(setDisplayNameByInstance).toHaveBeenCalledWith("classic-worker", "Classic");
    expect(setDescriptionByInstance).toHaveBeenCalledWith("classic-worker", "legacy");
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("persona emoji instance-config prototype pollution (CodeQL #21/#22)", () => {
  const customEmoji = { id: "111111111111111111", name: "fox", animated: false, available: true };
  const catalog = { ok: true as const, fetched_at: 1, emojis: [customEmoji], guilds: [] };

  function fleet(instances: Record<string, unknown> = { alpha: { working_directory: "/tmp" } }) {
    const fm = new FleetManager(temp());
    const internal = fm as any;
    internal.fleetConfig = { instances, defaults: {} };
    const save = vi.spyOn(internal, "saveFleetConfig").mockImplementation(() => {});
    // Keep validation and the write path real; stub the platform/network boundary.
    const resolve = vi.spyOn(fm, "resolveStatusEmojisFor").mockReturnValue({ ...builtinStatusEmojis("discord"), platform: "discord" });
    vi.spyOn(internal, "getInstanceAdapterId").mockReturnValue("dc");
    const list = vi.spyOn(fm, "listGuildEmojis").mockResolvedValue(catalog);
    return { fm, internal, instances, save, resolve, list };
  }

  it("sets and clears only the named status on an own instance", async () => {
    const entry = { working_directory: "/tmp", status_emojis: { failed: "🐙" } };
    const h = fleet({ alpha: entry });
    await expect(h.fm.handleSetPersonaEmojiHttp("alpha", { emoji: "🦊" })).resolves.toMatchObject({ value: "🦊" });
    expect(entry.status_emojis).toEqual({ failed: "🐙", delivered: "🦊" });
    await expect(h.fm.handleSetPersonaEmojiHttp("alpha", { emoji: "" })).resolves.toMatchObject({ value: null });
    expect(entry.status_emojis).toEqual({ failed: "🐙" });
    await h.fm.handleSetPersonaEmojiHttp("alpha", { emoji: "", status: "failed" });
    expect(entry).not.toHaveProperty("status_emojis");
    expect(h.save).toHaveBeenCalledTimes(3);
    expectGlobalsUnchanged();
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"])("rejects inherited persona name %s before validation or Discord work", async name => {
    const h = fleet();
    await expect(h.fm.handleSetPersonaEmojiHttp(name, { emoji: "<:fox:111111111111111111>" })).resolves.toEqual({ error: `Instance '${name}' not found` });
    expectGlobalsUnchanged();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("an inherited persona clear cannot delete existing prototype metadata", async () => {
    const h = fleet();
    Object.defineProperty(Object.prototype, "status_emojis", { value: { delivered: "🦊" }, writable: true, configurable: true });
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "status_emojis");
    const result = await h.fm.handleSetPersonaEmojiHttp("__proto__", { emoji: "" });
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "status_emojis")).toEqual(before);
    expect(result).toEqual({ error: "Instance '__proto__' not found" });
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("rejects persona %s removed during Discord validation without mutating an inherited target", async name => {
    const entry = { working_directory: "/tmp", status_emojis: { failed: "🐙" } };
    const h = fleet(Object.fromEntries([[name, entry]]));
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    h.list.mockImplementation(async () => { await gate; return catalog; });
    const pending = h.fm.handleSetPersonaEmojiHttp(name, { emoji: "<:fox:111111111111111111>" });
    try {
      await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
      delete h.instances[name];
      release();
      const result = await pending;
      expectGlobalsUnchanged();
      expect(result).toEqual({ error: `Instance '${name}' not found` });
      expect(entry.status_emojis).toEqual({ failed: "🐙" });
      expect(h.save).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });

  it("rejects an inherited replacement config after Discord validation", async () => {
    const original = { working_directory: "/tmp" };
    const inherited = { working_directory: "/elsewhere" };
    const h = fleet({ alpha: original });
    h.list.mockImplementation(async () => {
      h.internal.fleetConfig.instances = Object.create({ alpha: inherited });
      return catalog;
    });
    await expect(h.fm.handleSetPersonaEmojiHttp("alpha", { emoji: "<:fox:111111111111111111>" })).resolves.toEqual({ error: "Instance 'alpha' not found" });
    expect(inherited).toEqual({ working_directory: "/elsewhere" });
    expect(original).toEqual({ working_directory: "/tmp" });
    expect(h.save).not.toHaveBeenCalled();
    expectGlobalsUnchanged();
  });

  it("accepts explicitly owned special names without changing any global prototype", async () => {
    const h = fleet(JSON.parse('{"__proto__":{"working_directory":"/tmp"},"constructor":{"working_directory":"/tmp"},"hasOwnProperty":{"working_directory":"/tmp"}}'));
    for (const name of ["__proto__", "constructor", "hasOwnProperty"]) {
      await expect(h.fm.handleSetPersonaEmojiHttp(name, { emoji: "🦊" })).resolves.toMatchObject({ value: "🦊" });
      expect(h.instances[name]).toMatchObject({ status_emojis: { delivered: "🦊" } });
      await expect(h.fm.handleSetPersonaEmojiHttp(name, { emoji: "" })).resolves.toMatchObject({ value: null });
      expect(h.instances[name]).not.toHaveProperty("status_emojis");
    }
    expect(h.save).toHaveBeenCalledTimes(6);
    expectGlobalsUnchanged();
  });

  it("supports own persona config in a null-prototype dictionary", async () => {
    const h = fleet(Object.assign(Object.create(null), { alpha: { working_directory: "/tmp" } }));
    await expect(h.fm.handleSetPersonaEmojiHttp("alpha", { emoji: "🦊" })).resolves.toMatchObject({ value: "🦊" });
    await expect(h.fm.handleSetPersonaEmojiHttp("__proto__", { emoji: "🦊" })).resolves.toHaveProperty("error");
    expect(h.save).toHaveBeenCalledOnce();
    expectGlobalsUnchanged();
  });
});
