import { afterEach, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

afterEach(() => setLocale("en"));
function rig() {
  const events: string[] = [];
  const state = Object.assign(Object.create(FleetManager.prototype), {
    validateClassicStart: () => undefined,
    getMissingBackendWarning: () => undefined,
    handleClassicStart: async () => { events.push("registered"); return "Started"; },
    pendingClassicStarts: new Map(),
  }) as any;
  const respond = async (text: string) => { events.push(text); return "fake-message"; };
  return { state, events, respond };
}
for (const locale of ["en", "zh-TW"] as const) {
  const phrase = locale === "en" ? "only contact approval applies" : "只有聯絡申請需要核准";
  it(`${locale}: the Discord start choice discloses fallback before creating the restricted room`, async () => {
    setLocale(locale);
    const { state, events, respond } = rig();
    await state.handleClassicStartSlashCore({ channelId: "fake-room", userId: "fake-admin", options: { backend: "codex" }, respond }, "fake-adapter");
    expect(events[0]).toContain(phrase);
    expect(events.indexOf("registered")).toBeGreaterThan(0);
    expect(events.filter(value => value === "registered")).toHaveLength(1);
  });
  it(`${locale}: the backend chooser discloses fallback before creating the restricted room`, async () => {
    setLocale(locale);
    const { state, events, respond } = rig();
    const timer = setTimeout(() => {}, 60_000);
    try {
      state.pendingClassicStarts.set("fake-nonce", { channelId: "fake-room", userId: "fake-admin", adapterId: "fake-adapter", timer, complete: respond });
      await state.finishClassicBackendSelection("fake-nonce", "codex");
      expect(events[0]).toContain(phrase);
      expect(events.indexOf("registered")).toBeGreaterThan(0);
      expect(state.pendingClassicStarts.has("fake-nonce")).toBe(false);
    } finally { clearTimeout(timer); }
  });
}
