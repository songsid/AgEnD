/**
 * #4581 review (Prism, P2): module skew for the allowed-contacts editor. A tab may hold an older contact-auth-strings.js
 * with the new editor, or the older editor with the new strings (each is cached by its own URL). So the editor's new
 * words (the short line, What this allows and its details) live in its own namespace (`cgrant`, registered by
 * contact-grant-editor.js), and the shared grantBoundary / grantAllOrigins keep their full release text for older editors.
 * Node's real ESM linker, in a child process, on the product's own bytes (as tests/needs-verify-line-skew-m3710.test.ts):
 * the editor and what it imports are copied into a scratch directory, browser-only modules stubbed, with the
 * contact-auth-strings.js under test swapped in. Retained bytes: release 9a934f4ef's strings and editor (before this change).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const UI = join(__dirname, "..", "src", "ui"), SHARED = join(UI, "shared"), SKEW = join(__dirname, "fixtures", "skew");
const OLD_STRINGS = join(SKEW, "contact-auth-strings.base-9a934f4ef.js"), NEW_STRINGS = join(UI, "contact-auth-strings.js");
const OLD_EDITOR = join(SKEW, "contact-grant-editor.base-9a934f4ef.js"), NEW_EDITOR = join(UI, "contact-grant-editor.js");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STUBS: Record<string, string> = {
  "app-html.js": `export const html = () => null; export const useState = (v) => [v, () => {}]; export const useEffect = () => {};`,
  "app-i18n.js": `const tables = { en: {}, "zh-TW": {} }; let cur = "en";
    export function register(ns, by) { for (const l of Object.keys(tables)) for (const [k, v] of Object.entries(by[l] || {})) tables[l][ns + "." + k] = v; }
    export const t = (key, ...v) => String(tables[cur][key] ?? key).replace(/\\{(\\d+)\\}/g, (_, i) => v[i]);
    export const lang = () => cur; export const setLang = (l) => { cur = l; };`,
  "ui-dialog.js": `export const Dialog = () => null;`,
  "ui-icons.js": `export const Icon = () => null;`,
  "contact-auth-client.js": `export const personKey = (p) => JSON.stringify([p.platform, p.userId]);`,
  "clock-text.js": `export const dateTimeText = () => ""; export const timeText = () => ""; export const zhClock = () => false;`,
};
const IMPORT = /\bfrom\s+["']((?:\.\/|\/assets\/)[^"']+\.js)["']/g;

function scratch(editor: string, strings: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agend-skew-3783-")); dirs.push(dir);
  const seen = new Set<string>();
  const place = (src: string, name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const text = STUBS[name] ?? (name === "contact-auth-strings.js" ? readFileSync(strings, "utf8") : name === "contact-grant-editor.js" ? readFileSync(editor, "utf8")
      : readFileSync([src, join(SHARED, name), join(UI, name)].find((p) => existsSync(p)) ?? (() => { throw new Error(`cannot place ${name}`); })(), "utf8"));
    const flat = text.replace(/(["'])\/assets\//g, "$1./");
    writeFileSync(join(dir, name), flat);
    for (const m of flat.matchAll(IMPORT)) place(join(dirname(src), m[1]!.replace(/^\.\//, "")), m[1]!.replace(/^\.\//, ""));
  };
  place(join(UI, "contact-grant-editor.js"), "contact-grant-editor.js");
  return dir;
}
/** Import the editor (it links against the strings module under test), then read keys in en and zh-TW. */
function read(dir: string, keys: string[]): unknown {
  const script = `await import(${JSON.stringify(pathToFileURL(join(dir, "contact-grant-editor.js")).href)}); const i18n = await import("./app-i18n.js");
    const say = () => ${JSON.stringify(keys)}.map((k) => i18n.t(k)); const en = say(); i18n.setLang("zh-TW"); console.log(JSON.stringify([en, say()]));`;
  try { return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: dir })); }
  catch (err) { return String((err as { stderr?: string }).stderr ?? err); }
}
const NEW_KEYS = ["cgrant.boundary", "cgrant.moreTitle", "cgrant.boundaryMore", "cgrant.allOrigins", "cgrant.allOriginsMore"];
const NEW_WORDS = [
  ["Until it expires, these people's requests of this type are forwarded to this agent without asking.", "What this allows",
    "Only from this source to this agent, for this request type. It only decides whether a message is forwarded; what the receiving agent does with it still follows that agent's own permissions. To undo it, remove the rule in the agent's Permissions.",
    "Several people's words are in this conversation: tick each person the rule is for.", "A later request skips approval only when every person whose words it carries has a matching rule."],
  ["到期前，這些人的這類請求會直接轉交給這個 Agent，不再詢問。", "這會允許什麼",
    "只限從這個來源發給這個 Agent、這個請求類型。這只決定訊息能不能轉交；接收的 Agent 收到後要做什麼，仍照它自己的權限。要撤銷，到這個 Agent 的「權限」移除規則。",
    "這個對話裡有多人的話：請勾選這條規則適用的每個人。", "之後的請求，只有在它帶有的每個人都有符合的規則時，才會直接轉交。"],
];

describe("#4581 review: the editor's words, whichever editor and contact-auth-strings.js the tab holds", () => {
  it.each([["the RETAINED release", OLD_STRINGS], ["the current", NEW_STRINGS]])("the NEW editor with %s contact-auth-strings.js: its own words in en and zh-TW, never a raw key", (_l, strings) => {
    expect(read(scratch(NEW_EDITOR, strings), NEW_KEYS)).toEqual(NEW_WORDS);
  });
  it("the RETAINED release editor with the NEW contact-auth-strings.js: the shared boundary keeps its full explanation (nothing lost)", () => {
    const got = read(scratch(OLD_EDITOR, NEW_STRINGS), ["contactAuth.grantBoundary", "contactAuth.grantAllOrigins"]) as string[][];
    expect(got[0]![0]).toContain("This only decides whether a message is forwarded; what the receiving agent does with it still follows that agent's own permissions.");
    expect(got[0]![0]).toContain("remove the rule in the agent's Permissions");
    expect(got[0]![1]).toContain("Future requests skip approval only when every retained person has a matching rule.");
    expect(got[1]![0]).toContain("這只決定訊息能不能轉交");
    expect(got[1]![0]).toContain("移除規則");
  });
  it("the shared grantBoundary and grantAllOrigins are byte-for-byte the release's (older editors read them)", () => {
    const pick = (src: string) => [...src.matchAll(/(grantBoundary|grantAllOrigins): "((?:[^"\\]|\\.)*)"/g)].map((m) => m[0]);
    expect(pick(readFileSync(NEW_STRINGS, "utf8"))).toEqual(pick(readFileSync(OLD_STRINGS, "utf8")));
  });
  it("the harness sees the failure: the new words looked up in the release contact-auth-strings.js come back raw (the control)", () => {
    const dir = scratch(OLD_EDITOR, OLD_STRINGS);
    expect(read(dir, ["contactAuth.grantMoreTitle", "contactAuth.grantBoundaryMore"])).toEqual([["contactAuth.grantMoreTitle", "contactAuth.grantBoundaryMore"], ["contactAuth.grantMoreTitle", "contactAuth.grantBoundaryMore"]]);
  });
  it("the editor's new words are registered by the editor itself, not by contact-auth-strings.js", () => {
    const editor = readFileSync(NEW_EDITOR, "utf8");
    expect(editor).toMatch(/register\("cgrant", \{/);
    expect(readFileSync(NEW_STRINGS, "utf8")).not.toMatch(/grantMoreTitle|grantBoundaryMore|grantAllOriginsMore/);
  });
});
