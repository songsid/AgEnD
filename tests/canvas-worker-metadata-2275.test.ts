import { expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ imports: 0 }));
vi.mock("/assets/effect-display-metadata.js", () => {
  probe.imports++;
  return { effectTrialMessage: (message: any) => message.effectTrial, chatEffectIdentity: () => ({ scope: "operator" }) };
});
it("#2275 metadata has no import side effect off; opt-in loads it, off revokes reads without a fresh import", async () => {
  const { appStore } = await import("/assets/app-store.js"), flags = await import("/assets/feature-flags.js");
  appStore.set({ canvasWorker: false }); expect(await flags.loadCanvasWorkerMetadata()).toBeNull(); expect(probe.imports).toBe(0);
  expect(flags.readCanvasTrialMessage({ effectTrial: { title: "hidden" } })).toBeNull(); expect(probe.imports).toBe(0);
  appStore.set({ canvasWorker: true }); expect(await flags.loadCanvasWorkerMetadata()).not.toBeNull(); expect(probe.imports).toBe(1);
  expect(flags.readCanvasTrialMessage({ effectTrial: { title: "visible" } })).toEqual({ title: "visible" });
  appStore.set({ canvasWorker: false }); expect(await flags.loadCanvasWorkerMetadata()).toBeNull(); expect(flags.readCanvasTrialMessage({ effectTrial: {} })).toBeNull(); expect(probe.imports).toBe(1);
});
