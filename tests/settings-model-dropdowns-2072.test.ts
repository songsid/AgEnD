/**
 * #2072 part 3: every backend and model field in web Settings is a dropdown, fed from the host's availability
 * snapshot (/ui/backends) and the cached catalog of that backend for that instance's account (/ui/models). The current
 * value is always listed — marked when the CLI does not list it — and "Other…" types a name it does not list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { backendChoices, modelChoices, OTHER_MODEL } from "/ui/js/settings-catalog.js";

const words = { notInstalled: "not installed", notSignedIn: "not signed in", tooOld: (v: string) => `needs ${v}`, unchecked: "unchecked", removed: (v: string) => `${v} removed` };

describe("the backend options", () => {
  const rows = [{ name: "claude-code", state: "usable" }, { name: "codex", state: "not_signed_in" }, { name: "kiro-cli", state: "too_old", minVersion: "2.21.0" },
    { name: "grok", state: "not_installed" }, { name: "opencode", state: "unknown" }];
  const known = ["claude-code", "codex", "kiro-cli", "grok", "opencode"];
  it("every backend, an unusable one disabled with why, not-checked-yet selectable", () => {
    expect(backendChoices(known, rows, "claude-code", words)).toEqual([
      { value: "claude-code", label: "claude-code", disabled: false },
      { value: "codex", label: "codex — not signed in", disabled: true },
      { value: "kiro-cli", label: "kiro-cli — needs 2.21.0", disabled: true },
      { value: "grok", label: "grok — not installed", disabled: true },
      { value: "opencode", label: "opencode — unchecked", disabled: false },
    ]);
  });
  it("the current value is never disabled (fail open), and a removed one stays first", () => {
    expect(backendChoices(known, rows, "grok", words).find((o: any) => o.value === "grok")).toEqual({ value: "grok", label: "grok — not installed", disabled: false });
    expect(backendChoices(known, rows, "gemini-cli", words)[0]).toEqual({ value: "gemini-cli", label: "gemini-cli removed", disabled: false });
  });
  it("an older server's rows (installed / unknown, no state) still read right", () => {
    expect(backendChoices(["codex", "grok"], [{ name: "codex", installed: true }, { name: "grok", installed: false }], "codex", words))
      .toEqual([{ value: "codex", label: "codex", disabled: false }, { value: "grok", label: "grok — not installed", disabled: true }]);
  });
});

describe("the model options", () => {
  const catalog = [{ id: "opus", label: "opus" }, { id: "claude-opus-5-5", label: "claude-opus-5-5", description: "Opus 5.5" }];
  const w = { notListed: "not listed", other: "Other…" };
  it("inherit first, the catalog, then Other…", () => {
    expect(modelChoices(catalog, "", w, "inherit")).toEqual([
      { value: "", label: "inherit" }, { value: "opus", label: "opus" }, { value: "claude-opus-5-5", label: "claude-opus-5-5 — Opus 5.5" }, { value: OTHER_MODEL, label: "Other…" },
    ]);
  });
  it("a current model the catalog does not list is shown, marked, before the catalog; a listed one is not repeated", () => {
    expect(modelChoices(catalog, "claude-legacy-9", w, "inherit").slice(0, 2)).toEqual([{ value: "", label: "inherit" }, { value: "claude-legacy-9", label: "claude-legacy-9 — not listed" }]);
    expect(modelChoices(catalog, "opus", w).filter((o: any) => o.value === "opus")).toHaveLength(1);
    expect(modelChoices([], "custom-x", w)).toEqual([{ value: "custom-x", label: "custom-x — not listed" }, { value: OTHER_MODEL, label: "Other…" }]);
  });
});

describe("the pickers on a page", () => {
  let p: AppPage, D: any, P: any, C: any, requests: string[] = [];
  const answer: Record<string, unknown> = {
    "/ui/backends": { backends: [{ name: "claude-code", state: "usable" }, { name: "codex", state: "not_signed_in" }] },
    "/ui/models?backend=claude-code&instance=w": { models: [{ id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet" }] },
  };
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19283/settings/agents" });
    (globalThis as any).fetch = async (url: string) => { requests.push(url); return { ok: url in answer, status: url in answer ? 200 : 404, json: async () => answer[url] }; };
    D = await import("/ui/js/settings-dialogs.js"); P = await import("/assets/app-html.js"); C = await import("/ui/js/settings-catalog.js");
  });
  afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => { await p.unmount(); requests = []; C.forgetCatalogs(); });

  it("a model field lists the instance's catalog, keeps the current model, and Other… opens a box", async () => {
    let value = "claude-legacy-9";
    const Host = () => { const [v, setV] = P.useState(value); value = v; return P.h(D.ModelSelect, { id: "m", value: v, onChange: setV, backend: "claude-code", instance: "w", inherit: "inherit" }); };
    await p.mount(h(Host, {})); await settle(8);
    const select = p.root.querySelector("#m")!;
    expect([...select.querySelectorAll("option")].map((o: any) => o.textContent)).toEqual(["inherit", expect.stringContaining("claude-legacy-9"), "opus", "sonnet", expect.any(String)]);
    expect(requests).toContain("/ui/models?backend=claude-code&instance=w");
    select.value = "sonnet"; fire(select, "change"); await settle();
    expect(value).toBe("sonnet");
    select.value = OTHER_MODEL; fire(select, "change"); await settle();
    // Choosing "Other…" alone changes nothing: the box opens holding the current model (#2098 review P3-1).
    expect(value).toBe("sonnet");
    const box = p.root.querySelector(".model-pick input")!;
    expect(box).not.toBeNull();
    expect(box.value).toBe("sonnet");
    box.value = "my-model"; fire(box, "input"); await settle();
    expect(value).toBe("my-model");
  });
  it("a backend field disables what this host cannot run, with why, and never the current backend", async () => {
    await p.mount(h(D.BackendSelect, { id: "b", value: "claude-code", onChange: () => {} })); await settle(8);
    const options = [...p.root.querySelector("#b")!.querySelectorAll("option")] as any[];
    const codex = options.find(o => o.value === "codex")!;
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain("codex — ");
    expect(options.find(o => o.value === "claude-code")!.disabled).toBe(false);
  });
});
