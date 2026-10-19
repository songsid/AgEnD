/**
 * #2168 (user, 2.3.0-beta.9): Settings → Agents → Delete + Apply did nothing — "unsupported_sensitive_effect". An agent's
 * deletion is held for a fleet admin's confirmation, and its confirmation summary walked every field of the removed
 * config: a free-text string that is not a public key, an unknown object or a string list refused the whole deletion
 * before anything was proposed. Pinned here:
 * - a deleted agent is one summary line, whatever its config holds — on Settings' DELETE and on the chat's Delete;
 * - a change that keeps the agent is still classified field by field (the refusal stays where it protects something);
 * - confirmed, Settings' DELETE removes it through removeInstance (the delete_instance path), exactly once;
 * - the Apply banner and rows say a refusal in words, never the bare code.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom } from "./helpers/mini-dom.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsExecution, noteSettingsWrite } from "../src/settings-transaction.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";

// What refused it: free text, a display name, an unknown object, a string list.
const AGENT = { working_directory: "/w/indexer", backend: "claude-code", description: "Indexes the docs nightly", display_name: "Indexer ✨",
  custom_note: { owner: "demo team" }, custom_labels: ["alpha", "beta"] };
const config = () => ({ defaults: {}, instances: { keep: { working_directory: "/w/keep" }, indexer: structuredClone(AGENT) } });

describe("a deleted agent is one line in its confirmation, whatever its config holds", () => {
  it.each([["Settings' DELETE", "DELETE", "/api/settings/fleet/instances/indexer", {}], ["the chat's Delete", "POST", "/ui/instances/indexer/delete", { confirm: "delete indexer" }]])(
    "%s: held for confirmation, summarised as deleted, none of its fields", (_name, method, path, body) => {
      const effect = prepareSettingsEffect(method, path, body, { config: config() as any, classic: {} });
      expect(effect.diff, "held for a fleet admin's confirmation").not.toBeNull();
      expect(effect.diff!.summary.slice(1)).toEqual(["fleet.instances.indexer: deleted"]);
      expect(effect.diff!.summary.join("\n")).not.toMatch(/custom|description|display|alpha/);
    });
  it("a change that keeps the agent is still walked field by field: an unknown free-text field is refused as before", () => {
    expect(() => prepareSettingsEffect("PATCH", "/api/settings/fleet/instances/indexer", { custom_secretish: "x" }, { config: config() as any, classic: {} }))
      .toThrow(expect.objectContaining({ message: "unsupported_sensitive_effect" }));
  });
});

const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function harness(withRemove = true) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-2168-")); roots.push(root);
  const path = join(root, "fleet.yaml"), cfg: any = config();
  writeFileSync(path, yaml.dump(cfg));
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), cfg); writeFileSync(path, yaml.dump(cfg)); });
  const remove = vi.fn(async (name: string, _auth: unknown, execution?: SettingsExecution) => {
    const persist = () => { delete cfg.instances[name]; save(); };
    if (execution) execution.mutate(persist); else persist();
  });
  const ctx: any = { fleetConfig: cfg, dataDir: root, configPath: path, webToken: "t".repeat(48), webSessions: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, getRawFleetConfig: () => cfg, saveFleetConfig: save,
    lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() }, ...(withRemove ? { removeInstance: remove } : {}) };
  const baseline = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => cfg, current: () => null });
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const gate = new SettingsHttpConfirmation(store, { principal: () => ({ id: "browser", label: "browser", source: "web_session", current: () => true }),
    baseline: () => baseline.read(), snapshot: () => baseline.snapshot() });
  const request = (method: string, target: string) => new Promise<any>((resolve, reject) => {
    const req: any = new EventEmitter(); req.method = method; req.url = target; req.headers = { cookie: "opaque", "idempotency-key": `${method} ${target}` }; req.destroy = vi.fn();
    const res: any = { destroyed: false, headersSent: false, setHeader: vi.fn(), once: vi.fn(), writeHead(status: number) { this.status = status; this.headersSent = true; },
      end(text: string) { resolve({ status: this.status, body: JSON.parse(text) }); } };
    try { expect(gate.handle(req, res, new URL(target, "http://localhost"), (rq, rs, u) => handleSettingsRequest(rq, rs, u, ctx))).toBe(true);
      queueMicrotask(() => req.emit("end")); } catch (e) { reject(e); }
  });
  return { cfg, path, save, remove, store, request };
}

describe("confirmed, Settings' DELETE removes the agent the way delete_instance does", () => {
  it("held (202), nothing touched; confirmed: removeInstance once, with the confirmation's execution — gone from the config and from fleet.yaml", async () => {
    const h = harness(), held = await h.request("DELETE", "/api/settings/fleet/instances/indexer");
    expect(held.status).toBe(202);
    expect([h.remove.mock.calls.length, h.save.mock.calls.length, Object.keys(h.cfg.instances)]).toEqual([0, 0, ["keep", "indexer"]]);
    const outcome = await h.store.decide(held.body.pending_change.id, "confirm", { label: "F", current: () => true });
    expect(outcome.state).toBe("applied");
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.remove.mock.calls[0]![0]).toBe("indexer");
    expect(h.remove.mock.calls[0]![2], "the confirmation's execution").toBeInstanceOf(SettingsExecution);
    expect(Object.keys(h.cfg.instances)).toEqual(["keep"]);
    expect(Object.keys((yaml.load(readFileSync(h.path, "utf8")) as any).instances)).toEqual(["keep"]);
  });
  it("a context without removeInstance (CRUD only) still deletes the entry", async () => {
    const h = harness(false), held = await h.request("DELETE", "/api/settings/fleet/instances/indexer");
    expect((await h.store.decide(held.body.pending_change.id, "confirm", { label: "F", current: () => true })).state).toBe("applied");
    expect(Object.keys(h.cfg.instances)).toEqual(["keep"]);
  });
});

describe("a refusal is said in words", () => {
  const SRC = readFileSync(join(process.cwd(), "src", "ui", "panel-settings.js"), "utf8");
  const STR = readFileSync(join(process.cwd(), "src", "ui", "settings-strings.js"), "utf8");
  const codes = JSON.parse(SRC.match(/const APPLY_ERRORS = new Set\((\[[^\]]*\])\)/)![1]!.replace(/\s+/g, " ")) as string[];
  it("every listed code has its sentence in English and in zh-TW, and the unlisted fallback keeps the code", () => {
    expect(codes.length).toBeGreaterThan(5);
    for (const c of [...codes.map((x) => `applyError_${x}`), "applyErrorOther"]) expect(STR.split(`    ${c}: "`).length - 1, c).toBe(2);
    expect(STR).toContain('applyError_unsupported_sensitive_effect: "it changes a setting the confirmation cannot show safely, so nothing was changed"');
    expect(STR).toContain('applyErrorOther: "the server refused it ({0})"');
  });
  let S: any, i18n: any;
  beforeAll(async () => {
    const base = installDom({ storage: { agend_tour_done: "1" } });
    // @ts-expect-error — a JS module of the app, with no types
    S = await import("../src/ui/panel-settings.js");
    i18n = await import("/assets/app-i18n.js");
    base.restore();
  });
  it("applyErrorText: a listed code in words, in either language; any other keeps the code in brackets", () => {
    i18n.setLang("en");
    expect(S.applyErrorText("unsupported_sensitive_effect")).toBe("it changes a setting the confirmation cannot show safely, so nothing was changed");
    expect(S.applyErrorText("session_required")).toBe("your sign-in ended; sign in again and apply");
    expect(S.applyErrorText("instance not found")).toBe("the server refused it (instance not found)");
    i18n.setLang("zh-TW");
    expect(S.applyErrorText("unsupported_sensitive_effect")).toBe("它改到的設定無法在確認中安全顯示，所以什麼都沒有改");
    expect(S.applyErrorText("x_y")).toBe("伺服器拒絕了它（x_y）");
    i18n.setLang("en");
  });
  it("the banner and a failed row use it, never the bare code", () => {
    expect(SRC).toContain('tn("applyStepFailed", applyErrorText(op.error))');
    expect(SRC).toContain('s.error ? applyErrorText(s.error) : tn("applyFailed")');
    expect(SRC).not.toMatch(/tn\("applyStepFailed", op\.error\)|\(s\.error \|\| tn\("applyFailed"\)\)/);
  });
});
