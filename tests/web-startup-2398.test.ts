import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

let mounted: AppPage | null = null;
afterEach(async () => {
  if (mounted) { await mounted.unmount(); mounted.restore(); mounted = null; }
  (await import("/assets/app-i18n.js")).setLang("en");
});

describe("startup presentation in the connected dashboard", () => {
  it("the shared banner follows live counts, translates, and disappears at readiness", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet" }); mounted = pg;
    const { applyStatus } = await import("/assets/app-store.js");
    const { StartupLine } = await import("/assets/app-shell.js");
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("en");
    applyStatus({ instances: [], startup: { phase: "starting", ready: 1, total: 3, failed: 0 } });
    await pg.mount(h(StartupLine, {})); await settle();
    expect(pg.root.textContent).toContain("Fleet starting 1/3");
    applyStatus({ instances: [], startup: { phase: "starting", ready: 2, total: 3, failed: 0 } }); await settle();
    expect(pg.root.textContent).toContain("Fleet starting 2/3");
    setLang("zh-TW");
    applyStatus({ instances: [], startup: { phase: "starting", ready: 2, total: 3, failed: 0 } }); await settle();
    expect(pg.root.textContent).toContain("啟動中 2/3");
    applyStatus({ instances: [], startup: null }); await settle();
    expect(pg.root.querySelector(".fleet-starting")).toBeNull();
  });

  it("queued/starting override stale stopped/idle labels across nav, header and Org chart", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet" }); mounted = pg;
    const { dotState, dotLabel, statusFacet } = await import("/assets/instance-nav.js");
    const { statusLabel, statusClass } = await import("/assets/app-shell.js");
    // @ts-expect-error — browser JS
    const { orgState } = await import("../src/ui/fleet-org.js");
    (await import("/assets/app-i18n.js")).setLang("en");
    for (const phase of ["queued", "starting"]) {
      const row = { name: "worker", status: "stopped", startup_phase: phase };
      expect(dotState(row, "idle", null)).toBe(phase);
      expect(dotLabel(phase)).toBe(phase);
      expect(statusLabel(row, "idle", null)).toBe(phase);
      expect(statusClass(row, "idle", null)).toBe(phase === "starting" ? "busy" : "off");
      expect(statusFacet(row, "idle", null)).toBe("starting");
      expect(orgState(row, "idle", null, 0)).toBe(phase);
    }
    expect(dotState({ status: "running" }, "working", null)).toBe("working");
    expect(orgState({ status: "running" }, "idle", null, 0)).toBe("idle");
    expect(statusLabel({ status: "running" }, "idle", null)).toBe("idle");
  });
});
