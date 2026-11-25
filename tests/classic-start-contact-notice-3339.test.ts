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
    logger: { warn() {} },
  }) as any;
  const respond = async (text: string) => { events.push(text); return "fake-message"; };
  return { state, events, respond };
}
async function pickRestricted(state: any, userId = "fake-admin") {
  const nonce = [...state.pendingClassicStarts.keys()].at(-1);
  const pending = state.pendingClassicStarts.get(nonce);
  await state.handleClassicModeSelection({
    callbackData: `classic-mode:${nonce}:restricted`,
    chatId: "fake-room", messageId: "menu", userId,
  });
  clearTimeout(pending?.timer);
}
for (const locale of ["en", "zh-TW"] as const) {
  const phrase = locale === "en" ? "only contact approval applies" : "只有聯絡申請需要核准";
  it(`${locale}: the Discord start choice discloses fallback before creating the restricted room`, async () => {
    setLocale(locale);
    const { state, events, respond } = rig();
    const respondButtons = async (text: string, choices: { id: string }[]) => {
      events.push(text);
      events.push(choices.map((choice) => choice.id).join(" "));
      return "menu";
    };
    await state.handleClassicStartSlashCore({ channelId: "fake-room", channelName: "fake-room", userId: "fake-admin", options: { backend: "codex" }, respond, respondButtons }, "fake-adapter");
    expect(events[0]).toContain(phrase);
    expect(events).not.toContain("registered");
    await pickRestricted(state);
    expect(events.filter((value) => value === "registered")).toHaveLength(1);
    expect(events.indexOf("registered")).toBeGreaterThan(events.findIndex((value) => String(value).includes(phrase)));
  });
  it(`${locale}: the backend chooser discloses fallback before creating the restricted room`, async () => {
    setLocale(locale);
    const { state, events, respond } = rig();
    const timer = setTimeout(() => {}, 60_000);
    const showMenu = async (text: string, choices: { id: string }[]) => {
      events.push(text);
      events.push(choices.map((choice) => choice.id).join(" "));
      return "menu";
    };
    try {
      state.pendingClassicStarts.set("fake-nonce", {
        channelId: "fake-room", channelName: "fake-room", userId: "fake-admin", adapterId: "fake-adapter",
        timer, complete: respond, phase: "backend", showMenu,
      });
      await state.finishClassicBackendSelection("fake-nonce", "codex");
      expect(events.some((value) => String(value).includes(phrase))).toBe(true);
      expect(events).not.toContain("registered");
      expect(state.pendingClassicStarts.has("fake-nonce")).toBe(false);
      await pickRestricted(state);
      expect(events.filter((value) => value === "registered")).toHaveLength(1);
    } finally { clearTimeout(timer); }
  });
}
