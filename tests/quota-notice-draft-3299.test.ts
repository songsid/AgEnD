import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Run the actual component and useDraft with controllable hook lifetimes. Remount
// models leaving Settings, ctx.reload(), then returning with the retained edits.
function mount(ctx: any) {
  const slots: any[] = []; let cursor = 0, effects: Array<() => void> = [];
  const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: [...strings], values });
  const hook = (build: () => any) => { const i = cursor++; if (!(i in slots)) slots[i] = build(); return i; };
  const useMemo = (build: () => any, deps: any[]) => { const i = cursor++, prev = slots[i]; if (!prev || deps.some((v, n) => v !== prev.deps[n])) slots[i] = { value: build(), deps }; return slots[i].value; };
  const useState = (init: any) => { const i = hook(() => typeof init === "function" ? init() : init); return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; };
  const useEffect = (fn: () => void, deps: any[]) => { const i = cursor++, prev = slots[i]; if (!prev || deps.some((v, n) => v !== prev[n])) effects.push(fn); slots[i] = deps; };
  const source = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/export /g, "");
  const vm = { ctx, html, useMemo, useState, useEffect, lang: () => "en", sameValue: (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b), result: null as any };
  const renderCode = source("settings-draft.js") + "\n" + source("settings-quota-notice.js") + "\nresult = QuotaNoticeSettings({ctx});";
  // Each render has the same hooks but new lexical bindings, as a component call.
  const render = () => { cursor = 0; effects = []; runInNewContext("{\n" + renderCode + "\n}", vm); effects.forEach(fn => fn()); };
  const control = (id: string): any => {
    const search = (node: any): any => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.map(search).find(Boolean);
      if (!node.strings) return;
      const markup = node.strings.map((s: string, i: number) => s + (i < node.values.length ? `__slot${i}__` : "")).join("");
      const tag = markup.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0];
      if (tag) { const value = (name: string) => { const n = tag.match(new RegExp(`${name}=__slot(\\d+)__`)); return n ? node.values[Number(n[1])] : undefined; }; return { value: value("value"), edit: value("onInput") || value("onChange") }; }
      return node.values.map(search).find(Boolean);
    }; return search(vm.result);
  };
  render();
  return { value: (id: string) => control(id).value, edit: (id: string, value: string) => { control(id).edit({ target: { value } }); render(); } };
}
function fixture() {
  const staged = new Map();
  const ctx: any = { schema: { impacts: { "instance.quota_notice": "now" } }, drafts: new Map(),
    fleet: { defaults: { quota_notice: { thresholds: [10], periods: ["weekly"] } }, instances: { worker: { backend: "codex" }, retired: {} } },
    classic: { channels: {} }, stage: (key: string, value: any) => staged.set(key, value), unstage: (key: string) => staged.delete(key) };
  return { ctx, staged };
}
describe("quota notice field drafts across Settings reload", () => {
  it("keeps only edited fields, overlays new and refreshed rules, and ignores removed agents", () => {
    const { ctx, staged } = fixture(); const first = mount(ctx);
    first.edit("qn-thresholds", "25");
    first.edit("qn-scope", "agent:worker"); first.edit("qn-thresholds", "5");
    first.edit("qn-scope", "agent:retired"); first.edit("qn-enabled", "off");
    delete ctx.fleet.instances.retired;
    ctx.fleet.instances.newAgent = { quota_notice: { enabled: false } };
    ctx.fleet.instances.worker.quota_notice = { enabled: false, periods: ["daily"] };
    ctx.fleet.defaults.quota_notice.periods = ["monthly"];
    // The panel discards staged requests on reload; the surviving draft rebuilds them.
    staged.clear();
    const next = mount(ctx);
    expect(next.value("qn-thresholds")).toBe("25");
    expect(next.value("qn-periods")).toBe("monthly");
    expect(staged.get("quota:defaults").request.body.quota_notice).toMatchObject({ thresholds: [25], periods: ["monthly"] });
    expect(staged.has("quota:agent:newAgent")).toBe(false);
    expect(staged.has("quota:agent:retired")).toBe(false);
    expect(Object.keys(ctx.drafts.get("quota-notices")).some(key => key.includes("retired"))).toBe(false);
    next.edit("qn-scope", "agent:newAgent"); expect(next.value("qn-enabled")).toBe("off");
    next.edit("qn-scope", "agent:worker"); expect(next.value("qn-thresholds")).toBe("5"); expect(next.value("qn-enabled")).toBe("off"); expect(next.value("qn-periods")).toBe("daily");
    expect(staged.get("quota:agent:worker").request.body.quota_notice).toEqual({ enabled: false, thresholds: [5], periods: ["daily"] });
  });
  it("never stages deletion of an untouched refreshed worker rule", () => {
    const { ctx, staged } = fixture(); const first = mount(ctx); first.edit("qn-thresholds", "25");
    ctx.fleet.instances.worker.quota_notice = { enabled: false }; staged.clear();
    const next = mount(ctx); next.edit("qn-scope", "agent:worker");
    expect(next.value("qn-enabled")).toBe("off"); expect(staged.has("quota:agent:worker")).toBe(false);
  });
});
