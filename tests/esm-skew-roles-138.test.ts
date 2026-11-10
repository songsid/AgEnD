/**
 * PR #3553 review (P2 2): module skew. The app shell statically imports app-session.js, and Settings → Devices (settings-devices.js)
 * is imported lazily; a browser tab can still hold the PREVIOUS web-authorize.js (cached by URL) when the new modules arrive. A new
 * named import from the old file is a SyntaxError at link time ("does not provide an export named …") — for the session menu that
 * stops the whole shell. So the new modules must link against BOTH the new web-authorize.js and the retained base one
 * (tests/fixtures/skew/web-authorize.base-d5e2a3c87.js: the bytes at upstream d5e2a3c87), and the words they print must exist
 * whichever copy is loaded.
 * Node's real ESM linker, in child processes, on the product's own source bytes: each case copies the entry module and everything it
 * statically imports into a scratch directory (browser-only dependencies — the Preact wrapper, icons, dialog, fetch helper — are
 * stubs; i18n is a tiny real register/t), swaps in the web-authorize.js under test, and imports the entry.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const UI = join(__dirname, "..", "src", "ui"), SHARED = join(UI, "shared");
const BASE_AUTHORIZE = join(__dirname, "fixtures", "skew", "web-authorize.base-d5e2a3c87.js");
const NEW_AUTHORIZE = join(SHARED, "web-authorize.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STUBS: Record<string, string> = {
  "app-html.js": `export const html = () => null; export const useState = (v) => [v, () => {}]; export const useEffect = () => {}; export const useRef = (v) => ({ current: v ?? null }); export const useLayoutEffect = () => {};`,
  "app-i18n.js": `const tables = { en: {}, "zh-TW": {} };
    export function register(ns, by) { for (const l of Object.keys(tables)) for (const [k, v] of Object.entries(by[l] || {})) tables[l][ns + "." + k] = v; }
    export const t = (key, ...v) => String(tables.en[key] ?? key).replace(/\\{(\\d+)\\}/g, (_, i) => v[i]);
    export const lang = () => "en"; export const setLang = () => {};`,
  "app-store.js": `export const guestPage = () => false;`,
  "ui-icons.js": `export const Icon = () => null;`,
  "ui-dialog.js": `export const Dialog = () => null;`,
  "settings-confirm.js": `export async function api() { return { ok: true, status: 200, body: null }; }`,
};
const IMPORT = /\bfrom\s+["']((?:\.\/|\/assets\/)[^"']+\.js)["']/g;

/** Copy `entry` and its static relative imports into a scratch dir (stubs for the browser-only ones; `authorize` replaces web-authorize.js). */
function scratch(entryPath: string, authorize: string): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-skew-")); dirs.push(dir);
  const seen = new Set<string>();
  const place = (src: string, name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    let text: string;
    if (STUBS[name]) text = STUBS[name]!;
    else if (name === "web-authorize.js") text = readFileSync(authorize, "utf8");
    else {
      const found = [src, join(SHARED, name), join(UI, name)].find((p) => existsSync(p));
      if (!found) throw new Error(`cannot place ${name}`);
      text = readFileSync(found, "utf8");
    }
    const flat = text.replace(/(["'])\/assets\//g, "$1./");
    writeFileSync(join(dir, name), flat);
    for (const m of flat.matchAll(IMPORT)) place(join(dirname(src), m[1]!.replace(/^\.\//, "")), m[1]!.replace(/^\.\//, ""));
  };
  const entry = entryPath.split("/").pop()!;
  place(entryPath, entry);
  return { dir, entry };
}
/** Link and evaluate `entry` with Node's own ESM loader; returns {ok} or the loader's complaint. */
function link(dir: string, entry: string, probe = ""): { ok: true; out: string } | { ok: false; error: string } {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(dir, entry)).href)}); ${probe}`;
  try { return { ok: true, out: execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: dir }) }; }
  catch (err) { return { ok: false, error: String((err as { stderr?: string }).stderr ?? err) }; }
}
const ENTRIES = [["the session menu (app-session.js, imported by the shell)", join(SHARED, "app-session.js")], ["Settings → Devices (settings-devices.js)", join(UI, "settings-devices.js")]] as const;

describe("PR #3553 review: the new modules link whichever web-authorize.js the tab holds", () => {
  it.each(ENTRIES)("%s links against the RETAINED base web-authorize.js", (_label, path) => {
    const { dir, entry } = scratch(path, BASE_AUTHORIZE);
    const r = link(dir, entry);
    expect(r.ok ? "ok" : r.error).toBe("ok");
  });
  it.each(ENTRIES)("%s links against the current web-authorize.js", (_label, path) => {
    const { dir, entry } = scratch(path, NEW_AUTHORIZE);
    const r = link(dir, entry);
    expect(r.ok ? "ok" : r.error).toBe("ok");
  });

  it("the harness sees the failure: a static named import of a new export from the base file does not link (the control)", () => {
    const { dir } = scratch(join(SHARED, "app-session.js"), BASE_AUTHORIZE);
    writeFileSync(join(dir, "probe.js"), `import { roleName } from "./web-authorize.js"; export { roleName };`);
    const r = link(dir, "probe.js");
    expect(r.ok ? "linked" : r.error).toMatch(/does not provide an export named 'roleName'/);
  });

  it("the words the new modules print exist whichever copy is loaded (the roles, Manage devices): no raw key in either", () => {
    for (const authorize of [BASE_AUTHORIZE, NEW_AUTHORIZE]) {
      const { dir, entry } = scratch(join(SHARED, "app-session.js"), authorize);
      const r = link(dir, entry, `const { roleName } = await import("./device-roles.js"); const { t } = await import("./app-i18n.js");
        console.log(JSON.stringify([roleName("admin", true), roleName("admin", false), roleName("guest", false), roleName("read", false), t("webauth.role"), t("app.manageDevices")]));`);
      expect(r.ok ? JSON.parse(r.out) : r.error).toEqual(["Owner ✓", "Admin · not verified", "Guest", "Read-only", "Role", "Manage devices"]);
    }
  });

  it("the current web-authorize.js still exports everything the base one did (an old consumer keeps linking)", () => {
    const names = (file: string) => new Set([...readFileSync(file, "utf8").matchAll(/^export (?:async )?(?:function|const|class) ([A-Za-z0-9_$]+)/gm)].map((m) => m[1]!));
    const now = names(NEW_AUTHORIZE);
    for (const n of names(BASE_AUTHORIZE)) expect(now.has(n), n).toBe(true);
    expect(now.has("roleName")).toBe(false);                                            // the new word lives in device-roles.js only
  });
});
