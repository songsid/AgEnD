import { afterEach, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
const people = [{ platform: "discord", adapterId: "demo", userId: "fake-alice", label: "Alice" }, { platform: "discord", adapterId: "demo", userId: "fake-bob", label: "Bob" }];
const pages: AppPage[] = [];
afterEach(async () => { for (const p of pages.splice(0)) { await p.unmount(); p.restore(); } delete (globalThis as any).fetch; });
const key = (p: any) => JSON.stringify([p.platform, p.userId]);
const button = (root: any, text: string) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === text);
it("known multi-person origins start unchecked; presets and one explicit selection become one scoped grant request", async () => {
  const p = page(); pages.push(p);
  const save = vi.fn(async () => true), close = vi.fn();
  const { ContactGrantEditor } = await import("/ui/js/contact-grant-editor.js") as any;
  await p.mount(h(ContactGrantEditor, { people, source: "Room", target: "Worker", verb: "request_information", onSave: save, onClose: close }));
  const boxes = p.root.querySelectorAll('input[type="checkbox"]');
  expect(boxes.map((b: any) => b.checked)).toEqual([false, false]);
  expect(button(p.root, "Approve and allow from now on").disabled).toBe(true);
  const select = p.root.querySelector("select") as any;
  expect(select.value).toBe("7"); select.value = "30"; fire(select, "change"); await settle();
  const untilOf = () => { const [d, h, m] = [...p.root.querySelectorAll(".contact-until select")].map((e: any) => e.value); return new Date(`${d}T${h}:${m}`); };
  expect(untilOf().getTime() - Date.now()).toBeGreaterThan(29 * 86400000);
  expect(p.root.querySelector(".contact-grant-pick")?.textContent).toBe("Tick at least one person to save a rule.");
  boxes[1].checked = true; fire(boxes[1], "change"); await settle();
  fire(button(p.root, "Approve and allow from now on"), "click"); await settle();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ personKeys: [key(people[1])], remainingUses: null, verbs: ["request_information"] }));
  expect(close).toHaveBeenCalledOnce();
});
it("unknown origins offer only approve-once/decline and explain why a standing grant is unavailable", async () => {
  const p = page(); pages.push(p);
  const { TicketCard } = await import("/ui/js/contact-authorizations.js") as any;
  const { appStore } = await import("/assets/app-store.js") as any; appStore.set({ instances: [] });
  await p.mount(h(TicketCard, { ticket: { id: "Rdemo", revision: 1, state: "pending", canDecide: true, source: "room", target: "worker", verb: "send_to_instance", origin: { kind: "unknown", people: [], chain: [] } } }));
  expect(button(p.root, "Allow this person to contact this agent…").disabled).toBe(true);
  expect(p.root.textContent).toContain("complete origin is unknown");
  expect(button(p.root, "Approve once").disabled).toBe(false); expect(button(p.root, "Decline").disabled).toBe(false);
});
it("single-person default is seven days/unlimited and Cancel writes nothing; editing keeps person/source/target fixed", async () => {
  const p = page(); pages.push(p);
  const save = vi.fn(async () => true), close = vi.fn();
  const { ContactGrantEditor } = await import("/ui/js/contact-grant-editor.js") as any;
  await p.mount(h(ContactGrantEditor, { people: [people[0]], source: "Room", target: "Worker", verb: "send_to_instance", onSave: save, onClose: close }));
  expect(p.root.querySelector('input[type="checkbox"]').checked).toBe(true);
  const delta = (() => { const [d, h, m] = [...p.root.querySelectorAll(".contact-until select")].map((e: any) => e.value); return new Date(`${d}T${h}:${m}`); })().getTime() - Date.now();
  expect(delta).toBeGreaterThan(6.99 * 86400000); expect(delta).toBeLessThanOrEqual(7 * 86400000);
  fire(button(p.root, "Cancel"), "click"); await settle(); expect(save).not.toHaveBeenCalled();
  await p.unmount();
  await p.mount(h(ContactGrantEditor, { people: [people[0]], source: "Room", target: "Worker", grant: { person: people[0], verbs: ["send_to_instance"], expiresAt: new Date(Date.now() + 86400000).toISOString(), remainingUses: null }, onSave: save, onClose: close }));
  expect(p.root.querySelector('input[type="checkbox"]').disabled).toBe(true);
  const types = p.root.querySelectorAll('input[type="checkbox"]'); types[2].checked = true; fire(types[2], "change"); await settle();
  fire(button(p.root, "Save rule"), "click"); await settle();
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ personKeys: [key(people[0])], verbs: ["send_to_instance", "delegate_task"] }));
});

it("zh-TW editor has a complete title, branded platform and locale-formatted expiry", async () => {
  const p = page(); pages.push(p);
  const i18n = await import("/assets/app-i18n.js") as any;
  i18n.setLang("zh-TW", { store: false });
  try {
    const { ContactGrantEditor } = await import("/ui/js/contact-grant-editor.js") as any;
    await p.mount(h(ContactGrantEditor, { people: [people[0]], source: "Demo room", target: "Demo worker", verb: "send_to_instance", onSave: vi.fn(), onClose: vi.fn() }));
    expect(p.root.querySelector("dialog h2").textContent).toBe("允許這個人聯絡此 Agent");
    expect(p.root.textContent).toContain("Alice · Discord");
    expect(p.root.textContent).toContain("從 Demo room 給 Demo worker");
    expect(p.root.querySelector(".contact-grant-expiry").textContent).toMatch(/到 \d{4}年\d+月\d+日/);
  } finally { i18n.setLang("en", { store: false }); }
});
