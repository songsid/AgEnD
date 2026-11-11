/**
 * AGEND-158 PR 3: the model list Web Settings shows — claude: the account's own models only (no aliases), a `[1m]` only
 * where the model reports 1M+ and has no 1M by default, in its own group; the documentation's ids marked unverified when
 * there is no account list; other backends grouped (common / more); antigravity's effort
 * levels merged into one entry per model — and a saved value that an older list showed still shows. Pure data and rendered dropdown; no CLI, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { handleWebRequest } from "../src/web-api.js";
import { parseAntigravityModelsOutput } from "../src/backend/antigravity.js";
import { agyModelFamily } from "../src/backend/effort-metadata.js";
import { resolveAgyLaunch } from "../src/backend/launch-effort.js";
import { claudeNativeOneMillion, claudeOneMillionOffered } from "../src/backend/claude-context.js";
import { mergeAntigravityLevels, shapeDocumentedClaudeModels, shapeWebModelCatalog } from "../src/web-model-groups.js";
import { groupModelOptions, modelChoices, OTHER_MODEL } from "/ui/js/settings-catalog.js";

const realFetch = globalThis.fetch;   // the page tests below replace and then delete it
const AGY = parseAntigravityModelsOutput(readFileSync(join(import.meta.dirname, "fixtures", "agy-1.3.5-audit", "agy-models.stdout.txt"), "utf-8"));
const M = 1_000_000;
const STATIC = [{ id: "default", label: "default" }, { id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" }, { id: "Fable", label: "Fable" }];
const API = [
  { id: "claude-opus-5-5", label: "claude-opus-5-5", maxInputTokens: M },
  { id: "claude-opus-5-5[1m]", label: "claude-opus-5-5[1m]", maxInputTokens: M },        // 1M by default: no suffix
  { id: "claude-opus-4-6", label: "claude-opus-4-6", maxInputTokens: M },
  { id: "claude-opus-4-6[1m]", label: "claude-opus-4-6[1m]", maxInputTokens: M },        // opt-in 1M: offered
  { id: "claude-opus-4-5-20251101", label: "claude-opus-4-5-20251101", maxInputTokens: 200_000 },
  { id: "claude-opus-4-5-20251101[1m]", label: "claude-opus-4-5-20251101[1m]", maxInputTokens: 200_000 },   // the API refuses it
  { id: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001", maxInputTokens: 200_000 },
  { id: "claude-haiku-4-5-20251001[1m]", label: "claude-haiku-4-5-20251001[1m]", maxInputTokens: 200_000 },
  { id: "claude-old-x", label: "claude-old-x" },
  { id: "claude-old-x[1m]", label: "claude-old-x[1m]" },                                 // no window reported: not listed
];
const ids = (list: Array<{ id: string }>) => list.map(m => m.id);

describe("claude: the account's own model list, and the [1m] variants that can work", () => {
  const ACCOUNT = ["claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-old-x"];
  it("no aliases and no CLI list; the account's models carry no group, the [1m] that can work come last in their own", () => {
    const shaped = shapeWebModelCatalog("claude-code", STATIC, API);
    expect(ids(shaped)).toEqual([...ACCOUNT, "claude-opus-4-6[1m]"]);
    expect(shaped.filter(m => m.group).map(m => [m.id, m.group])).toEqual([["claude-opus-4-6[1m]", "oneMillion"]]);
    expect(shaped[0]).toMatchObject({ maxInputTokens: M });   // the catalog's own fields are kept
  });
  it("pinned: a model reporting 1M gets its [1m]; a 200K model, a native-1M model and one reporting nothing do not", () => {
    const shaped = ids(shapeWebModelCatalog("claude-code", STATIC, API));
    expect(shaped).toContain("claude-opus-4-6[1m]");                                              // reports 1,000,000, opt-in
    for (const gone of ["claude-opus-4-5-20251101[1m]", "claude-haiku-4-5-20251001[1m]",       // report 200K
      "claude-opus-5-5[1m]",                                                                       // 1M by default
      "claude-old-x[1m]"]) expect(shaped, gone).not.toContain(gone);                              // no window reported
  });
  it("an older daemon's cache (a [1m] after every model, with the model's window) is cleaned the same way", () => {
    const stale = ACCOUNT.flatMap(id => [{ id, label: id, maxInputTokens: id.includes("4-5") ? 200_000 : M }, { id: `${id}[1m]`, label: `${id}[1m]`, maxInputTokens: id.includes("4-5") ? 200_000 : M }]);
    expect(ids(shapeWebModelCatalog("claude-code", STATIC, stale)).filter(id => id.endsWith("[1m]"))).toEqual(["claude-opus-4-6[1m]", "claude-old-x[1m]"]);
  });
  it("a model both lists name is listed once; without an account catalog there is nothing (the caller falls back to the documentation)", () => {
    expect(ids(shapeWebModelCatalog("claude-code", [{ id: "claude-opus-5-5", label: "x" }], [{ id: "claude-opus-5-5", label: "y" }]))).toEqual(["claude-opus-5-5"]);
    expect(shapeWebModelCatalog("claude-code", STATIC)).toEqual([]);
  });
  it("the documented fallback: only the explicit claude-* ids, marked unverified; no alias", () => {
    const shaped = shapeDocumentedClaudeModels([{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }, { id: "opus", label: "Claude Opus" }, { id: "opusplan", label: "Opus Plan" }]);
    expect(shaped).toEqual([{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "unverified" }]);
    expect(shapeDocumentedClaudeModels([{ id: "opus", label: "Claude Opus" }])).toEqual([]);
  });
});

describe("the [1m] rule (the probe, for Telegram's /model → more models, and Web Settings' 1M group)", () => {
  it("native 1M: Fable, Sonnet 5+, Haiku 5.5+, Opus 4.7+; the rest are not; a series the table does not know is not", () => {
    for (const id of ["Fable", "claude-fable-5-2", "claude-opus-5-5", "claude-opus-4-7", "claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-7[1m]"]) expect(claudeNativeOneMillion(id), id).toBe(true);
    for (const id of ["claude-opus-4-6", "claude-opus-4-5-20251101", "claude-sonnet-4-6", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-haiku-5", "opus", "claude-unknown"]) expect(claudeNativeOneMillion(id), id).toBe(false);
  });
  it("offered: reported 1M+, not native; a missing, 200K or malformed window is not", () => {
    expect(claudeOneMillionOffered("claude-opus-4-6", M)).toBe(true);
    expect(claudeOneMillionOffered("claude-opus-4-6", 2 * M)).toBe(true);
    expect(claudeOneMillionOffered("claude-opus-5-5", M)).toBe(false);
    for (const tokens of [200_000, 0, undefined, null, "1000000", NaN]) expect(claudeOneMillionOffered("claude-opus-4-6", tokens)).toBe(false);
  });
  it("a new series the table does not know that reports 1M still gets a [1m] (the table needs the new series added)", () => {
    expect(claudeNativeOneMillion("claude-mythos-1")).toBe(false);
    expect(claudeOneMillionOffered("claude-mythos-1", M)).toBe(true);
  });
});

describe("grouping: common (the quick picks), more (the account catalog) — a backend that has both", () => {
  it("a backend with both tiers: the quick tier first, then the account catalog", () => {
    const shaped = shapeWebModelCatalog("grok", [{ id: "q", label: "q" }], [{ id: "a", label: "a" }, { id: "q", label: "again" }]);
    expect(shaped).toEqual([{ id: "q", label: "q", group: "common" }, { id: "a", label: "a", group: "more" }]);
  });
  it("a backend with one tier (codex, grok, …) stays a flat list", () => {
    expect(shapeWebModelCatalog("codex", [{ id: "gpt-5", label: "gpt-5" }])).toEqual([{ id: "gpt-5", label: "gpt-5" }]);
  });
});

describe("antigravity: one entry per model, the level is the effort dropdown's", () => {
  const shaped = shapeWebModelCatalog("antigravity", AGY);
  it("the audited 1.3.5 catalog's ten slugs are four models", () => {
    expect(shaped.map(m => m.label)).toEqual(["Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B (Medium)"]);
  });
  it("an entry's value is the medium slug (a real catalog slug); it stands for every level of the model", () => {
    expect(shaped[0]).toMatchObject({ id: "gemini-3.8-flash-medium" });
    expect(shaped[0]!.aliases).toEqual(expect.arrayContaining(["gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"]));
    expect(shaped.find(m => m.id === "gpt-oss-120b-medium")!.aliases).toBeUndefined();   // one level only: nothing to merge
  });
  it("without a medium slug the first one the catalog lists for the model stands for it; the order of the catalog is kept", () => {
    const merged = mergeAntigravityLevels([{ id: "a-low", label: "A (Low)" }, { id: "x", label: "X" }, { id: "a-high", label: "A (High)" }]);
    expect(merged.map(m => m.id)).toEqual(["a-low", "x"]);
    expect(merged[0]!.label).toBe("A");
  });
  it("another backend's catalog is never merged", () => {
    expect(ids(shapeWebModelCatalog("codex", [{ id: "m-low", label: "m" }, { id: "m-high", label: "m" }]))).toEqual(["m-low", "m-high"]);
  });
});

describe("what the dropdown does with it", () => {
  const w = { notListed: "not listed", other: "Other…" };
  const agy = shapeWebModelCatalog("antigravity", AGY);
  it("a saved level of a merged model shows as that model, and is not rewritten", () => {
    const options = modelChoices(agy, "gemini-3.8-flash-high", w, "inherit");
    expect(options.find((o: any) => o.label === "Gemini 3.8 Flash")).toMatchObject({ value: "gemini-3.8-flash-high" });
    expect(options.some((o: any) => /not listed/.test(o.label))).toBe(false);
    for (const saved of ["gemini-3.8-flash-low", "gemini-3.8-flash", "gemini-3.8-flash-medium"]) {
      expect(modelChoices(agy, saved, w).filter((o: any) => o.value === saved)).toHaveLength(1);
    }
  });
  it("choosing a merged model writes a real slug; its effort is then the effort dropdown's, resolved at launch", () => {
    const options = modelChoices(agy, "claude-opus-5-5-high", w);
    const written = (options.find((o: any) => o.label === "Gemini 3.8 Flash") as any).value;
    expect(written).toBe("gemini-3.8-flash-medium");
    expect(agyModelFamily(written, AGY)!.variants.get("high")).toBe("gemini-3.8-flash-high");
    // effort high on the written model launches the high variant, with no --effort next to a variant slug
    expect(resolveAgyLaunch(written, "high", AGY)).toMatchObject({ model: "gemini-3.8-flash-high", effort: null });
    // a saved low stays low when effort is unset
    expect(resolveAgyLaunch("gemini-3.8-flash-low", null, AGY)).toMatchObject({ model: "gemini-3.8-flash-low", effort: null });
  });
  it("an alias or [1m] that Claude's list does not carry still shows as the current value, marked", () => {
    const shaped = shapeWebModelCatalog("claude-code", STATIC, API);
    for (const saved of ["opus", "sonnet[1m]", "claude-opus-4-5-20251101[1m]", "Fable"]) {
      const options = modelChoices(shaped, saved, w, "inherit");
      expect(options[1]).toEqual({ value: saved, label: `${saved} — not listed` });   // kept, marked, not rewritten
      expect(options.filter((o: any) => o.value === saved)).toHaveLength(1);
    }
  });
  it("groups: runs in order, the unlisted/inherit/Other options outside them; fewer than two is the flat list — except a lone unverified one", () => {
    const two = shapeWebModelCatalog("grok", [{ id: "q", label: "q" }], [{ id: "a", label: "a" }]);
    const runs = groupModelOptions(modelChoices(two, "gone", w, "inherit"));
    expect(runs.map((r: any) => r.group)).toEqual([null, "common", "more", null]);
    expect(runs[0].options.map((o: any) => o.value)).toEqual(["", "gone"]);
    expect(runs[3].options.map((o: any) => o.value)).toEqual([OTHER_MODEL]);
    const flat = modelChoices(STATIC, "", w, "inherit");
    expect(groupModelOptions(flat)).toEqual([{ group: null, options: flat }]);
    const one = modelChoices(two.filter(m => m.group !== "more"), "", w);
    expect(groupModelOptions(one)).toEqual([{ group: null, options: one }]);
    // the documentation-only list is one group, and its heading is the information: it stays
    const doc = modelChoices(shapeDocumentedClaudeModels([{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]), "opus", w, "inherit");
    expect(groupModelOptions(doc).map((r: any) => r.group)).toEqual([null, "unverified", null]);
    // claude: the account's models in the flat run, the 1M ones under their own heading (even with no other group), Other… after
    const claude = groupModelOptions(modelChoices(shapeWebModelCatalog("claude-code", STATIC, API), "opus", w, "inherit"));
    expect(claude.map((r: any) => r.group)).toEqual([null, "oneMillion", null]);
    expect(claude[1].options.map((o: any) => o.value)).toEqual(["claude-opus-4-6[1m]"]);
    // a claude account with no model that can take [1m]: no group at all
    const none = modelChoices(shapeWebModelCatalog("claude-code", STATIC, API.filter(m => !m.id.includes("4-6"))), "", w, "inherit");
    expect(groupModelOptions(none)).toEqual([{ group: null, options: none }]);
  });
  it("a list from a daemon without groups (an older daemon, a Windows computer's own) is the flat list it was", () => {
    expect(modelChoices([{ id: "a", label: "a" }, { id: "b", label: "b", description: "B" }], "", w, "inherit")).toEqual([
      { value: "", label: "inherit" }, { value: "a", label: "a" }, { value: "b", label: "b — B" }, { value: OTHER_MODEL, label: "Other…" }]);
  });
});

describe("the dropdown on a page", () => {
  let p: AppPage, D: any, P: any, C: any;
  const answer: Record<string, unknown> = {
    "/ui/models?backend=claude-code&instance=w": { models: shapeWebModelCatalog("claude-code", STATIC, API) },
    "/ui/models?backend=claude-code&instance=doc": { models: shapeDocumentedClaudeModels([{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }, { id: "opus", label: "Claude Opus" }]), source: "official-catalog" },
    "/ui/models?backend=grok&instance=g": { models: shapeWebModelCatalog("grok", [{ id: "q", label: "q" }], [{ id: "a", label: "a" }]) },
    "/ui/models?backend=antigravity&instance=a": { models: shapeWebModelCatalog("antigravity", AGY) },
    "/ui/models?backend=claude-code&instance=old": { models: STATIC },
  };
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19283/settings/agents" });
    (globalThis as any).fetch = async (url: string) => ({ ok: url in answer, status: url in answer ? 200 : 404, json: async () => answer[url] });
    D = await import("/ui/js/settings-dialogs.js"); P = await import("/assets/app-html.js"); C = await import("/ui/js/settings-catalog.js");
  });
  afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => { await p.unmount(); C.forgetCatalogs(); (await import("/ui/js/model-picker.js")).forgetModelPickerCatalogs(); });
  const mount = async (props: Record<string, unknown>, initial: string) => {
    let value = initial;
    const Host = () => { const [v, setV] = P.useState(value); value = v; return P.h(D.ModelSelect, { id: "m", value: v, onChange: setV, inherit: "inherit", ...props }); };
    await p.mount(h(Host, {})); await settle(8);
    return { select: p.root.querySelector("#m")!, value: () => value };
  };

  it("claude: the account's models, then the 1M ones under their own heading; an alias is typed under Other…", async () => {
    const { select, value } = await mount({ backend: "claude-code", instance: "w" }, "sonnet[1m]");
    const groups = [...select.querySelectorAll("optgroup")] as any[];
    expect(groups.map(g => g.getAttribute("label"))).toEqual(["1M context (plan-dependent)"]);
    expect([...groups[0].querySelectorAll("option")].map((o: any) => o.value)).toEqual(["claude-opus-4-6[1m]"]);
    const values = [...select.querySelectorAll("option")].map((o: any) => o.value);
    expect(values).toEqual(["", "sonnet[1m]", "claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-old-x", "claude-opus-4-6[1m]", OTHER_MODEL]);
    expect(values.some((v: string) => /^(default|opus|sonnet|haiku|opusplan|Fable)$/.test(v))).toBe(false);
    expect(select.value).toBe("sonnet[1m]");               // the saved value stays selected, not rewritten
    select.value = OTHER_MODEL; fire(select, "change"); await settle();
    expect(value()).toBe("sonnet[1m]");                      // Other… alone changes nothing; the box opens with it
    expect(p.root.querySelector(".model-pick input")!.value).toBe("sonnet[1m]");
  });
  it("claude without an account list: the documentation's ids under their own heading, which stays with one group", async () => {
    const { select } = await mount({ backend: "claude-code", instance: "doc" }, "");
    const groups = [...select.querySelectorAll("optgroup")] as any[];
    expect(groups.map(g => g.getAttribute("label"))).toEqual(["Not checked against this account"]);
    expect([...groups[0].querySelectorAll("option")].map((o: any) => o.value)).toEqual(["claude-sonnet-5-5"]);
  });
  it("another backend with both tiers: Common, More models", async () => {
    const { select } = await mount({ backend: "grok", instance: "g" }, "q");
    expect([...select.querySelectorAll("optgroup")].map((g: any) => g.getAttribute("label"))).toEqual(["Common", "More models"]);
  });
  it("antigravity: four entries, and choosing one writes its slug", async () => {
    const { select, value } = await mount({ backend: "antigravity", instance: "a" }, "claude-opus-5-5-high");
    expect(select.querySelectorAll("optgroup")).toHaveLength(0);
    const labels = [...select.querySelectorAll("option")].map((o: any) => o.textContent);
    expect(labels).toEqual(["inherit", "Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B (Medium)", "Other…"]);
    expect(select.value).toBe("claude-opus-5-5-high");   // the saved level still shows as its model
    select.value = "gemini-3.8-flash-medium"; fire(select, "change"); await settle();
    expect(value()).toBe("gemini-3.8-flash-medium");
  });
  it("SKEW: a list without groups (an old daemon) renders flat, as before", async () => {
    const { select } = await mount({ backend: "claude-code", instance: "old" }, "");
    expect(select.querySelectorAll("optgroup")).toHaveLength(0);
    expect([...select.querySelectorAll("option")].map((o: any) => o.textContent)).toEqual(["inherit", "default", "sonnet", "opus", "Fable", "Other…"]);   // the unshaped list an old daemon answers
  });
});

describe("the routes answer the shaped catalog", () => {
  function get(path: string, ctxExtra: Record<string, unknown>) {
    const token = "c".repeat(48);
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
    let body = "";
    let finish!: () => void;
    const finished = new Promise<void>(r => { finish = r; });
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, getHeader() { return undefined; },
      writeHead: vi.fn((): void => { res.headersSent = true; }), end: vi.fn((t = ""): void => { body = String(t); res.writableEnded = true; finish(); }), write() { return true; } });
    handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: token, logger: { info() {}, debug() {}, error() {}, warn() {} }, ...ctxExtra } as never);
    return { finished, json: () => JSON.parse(body || "null") };
  }
  it("GET /ui/models: the fleet's web catalog", async () => {
    const web = vi.fn(() => shapeWebModelCatalog("claude-code", STATIC, API));
    const r = get("/ui/models?backend=claude-code&instance=w", { modelCatalogForWeb: web, modelCatalogFor: () => { throw new Error("the unshaped one is not asked"); } });
    await r.finished;
    expect(web).toHaveBeenCalledWith("claude-code", "w");
    expect(ids(r.json().models)).toEqual(["claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-old-x", "claude-opus-4-6[1m]"]);
    expect(r.json().models.find((m: any) => m.id === "claude-opus-4-6[1m]").group).toBe("oneMillion");
  });
  it("claude with no account list: the documented ids, unverified, no alias — also when only the static aliases were cached", async () => {
    for (const cached of [[], STATIC]) {
      const r = get("/ui/models?backend=claude-code", { modelCatalogFor: () => cached, backendAvailabilityRows: () => [{ backend: "claude-code", version: "2.1.299" }] });
      await r.finished;
      expect(r.json().source).toBe("official-catalog");
      expect(r.json().models.length).toBeGreaterThan(0);
      expect(r.json().models.every((m: any) => m.id.startsWith("claude-") && m.group === "unverified")).toBe(true);
    }
  });
  it("claude with a credential profile and no account list: the same documented fallback as without a profile", async () => {
    const rows = () => [{ backend: "claude-code", version: "2.1.299" }];
    const web = vi.fn(() => []);
    const without = get("/ui/models?backend=claude-code&instance=w", { modelCatalogForWeb: web, backendAvailabilityRows: rows });
    await without.finished;
    const withProfile = get("/ui/models?backend=claude-code&instance=w&profile=work", { modelCatalogForWeb: web, backendAvailabilityRows: rows });
    await withProfile.finished;
    expect(web).toHaveBeenLastCalledWith("claude-code", "w", { profile: "work" });
    expect(withProfile.json()).toEqual(without.json());
    expect(withProfile.json()).toMatchObject({ source: "official-catalog" });
    expect(withProfile.json().models.length).toBeGreaterThan(0);
    // another backend with a profile and nothing cached is still the empty list
    const other = get("/ui/models?backend=grok&profile=work", { modelCatalogForWeb: () => [] });
    await other.finished;
    expect(other.json()).toEqual({ backend: "grok", models: [] });
  });
  it("a context with only the plain catalog (and the CLI-cache fallback) is shaped the same way", async () => {
    const a = get("/ui/models?backend=antigravity&instance=a", { modelCatalogFor: () => AGY });
    await a.finished;
    expect(a.json().models.map((m: any) => m.label)).toEqual(["Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B (Medium)"]);
    const b = get("/ui/models?backend=antigravity&instance=a", { modelCatalogFor: () => [], cliModelCatalogFor: async () => AGY });
    await b.finished;
    expect(b.json()).toMatchObject({ source: "cli-cache" });
    expect(b.json().models).toHaveLength(4);
  });
});

describe("POST /ui/models/refresh answers the shaped catalog too", () => {
  const servers: Server[] = [];
  afterAll(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
  async function post(ctxExtra: Record<string, unknown>, body: unknown) {
    const token = "a".repeat(48);
    const ctx: any = { webToken: token, logger: { info() {}, error() {}, warn() {}, debug() {} }, ...ctxExtra };
    const server = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/ui/models/refresh`, { method: "POST", headers: { "Content-Type": "application/json", "x-agend-token": token }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  }
  const rows = () => [{ backend: "claude-code", version: "2.1.299" }];
  it("claude: the refreshed account list with only the [1m] that can work, in the 1M group (pinned)", async () => {
    const r = await post({ refreshModelCatalogFor: async () => ({ models: [...STATIC, ...API], refreshed: true }), modelCatalogForWeb: () => shapeWebModelCatalog("claude-code", STATIC, API) }, { backend: "claude-code", instance: "w" });
    expect(r.json.refreshed).toBe(true);
    expect(ids(r.json.models)).toEqual(["claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-old-x", "claude-opus-4-6[1m]"]);
    expect(r.json.models.find((m: any) => m.id === "claude-opus-4-6[1m]").group).toBe("oneMillion");
    for (const gone of ["claude-opus-4-5-20251101[1m]", "claude-haiku-4-5-20251001[1m]", "claude-opus-5-5[1m]"]) expect(ids(r.json.models)).not.toContain(gone);
  });
  it("claude with no account list after the refresh: the documentation's ids (unverified), as GET answers — not an empty list", async () => {
    for (const profile of [undefined, "work"]) {
      const r = await post({ refreshModelCatalogFor: async () => ({ models: [...STATIC], refreshed: false }), modelCatalogForWeb: () => [], backendAvailabilityRows: rows }, { backend: "claude-code", instance: "w", ...(profile ? { profile } : {}) });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ refreshed: false, source: "official-catalog" });
      expect(r.json.models.length).toBeGreaterThan(0);
      expect(r.json.models.every((m: any) => m.id.startsWith("claude-") && m.group === "unverified")).toBe(true);
    }
  });
  it("another backend with an empty list stays empty", async () => {
    const r = await post({ refreshModelCatalogFor: async () => ({ models: [], refreshed: false }), modelCatalogForWeb: () => [] }, { backend: "grok", instance: "w" });
    expect(r.json).toMatchObject({ refreshed: false, models: [] });
    expect(r.json.source).toBeUndefined();
  });
});
