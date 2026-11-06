/**
 * #3181 (main → alpha sync, Prism P2): the per-agent Codex speed (M-2446) is a launch flag of the Linux/WSL
 * CodexBackend. A Windows agent runs codex through the native exec/pane paths, which have no speed option, and the
 * native settings patch refuses `backend_options`. So Settings → an agent offers Speed for a Linux/WSL codex agent only:
 * a Windows codex agent (exec or pane) is shown no Speed field, and so cannot stage one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

let p: AppPage;
const realFetch = (globalThis as any).fetch;
beforeAll(() => { p = page({ url: "http://127.0.0.1:19281/settings/agents" }); (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null }); });
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
afterEach(async () => { await p.unmount(); });

async function editor(inst: Record<string, unknown>) {
  const { AgentDialog } = await import("/ui/js/settings-dialogs.js");
  const fleet = { defaults: {}, instances: { coder: inst } };
  const ctx = { fleet, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(), channelType: () => "telegram",
    shortName: (n: string, i: any) => (i && i.display_name) || n };
  await p.unmount();
  await p.mount(h(AgentDialog, { name: "coder", inst, ctx, onClose: () => {} }));
  await settle(8);
  return (sel: string) => p.root.querySelector(sel) as any;
}

describe("#3181 Codex speed in Settings: Linux/WSL agents only", () => {
  it("a Linux/WSL codex agent is offered Speed (the control)", async () => {
    const $ = await editor({ backend: "codex", working_directory: "/w/c" });
    expect($(".codex-speed")).not.toBeNull();
    expect($("#ag-speed")).not.toBeNull();
  });
  it.each(["exec", "pane"])("a Windows codex agent (%s) is shown no Speed field", async (adapter) => {
    const $ = await editor({ backend: "codex", runtime: "windows", native_adapter: adapter, native_sandbox: "read-only", working_directory: "C:\\work\\c" });
    expect($("#ag-model")).not.toBeNull();   // the dialog drew its fields
    expect($(".codex-speed")).toBeNull();
    expect($("#ag-speed")).toBeNull();
  });
});
