import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebChatHistory } from "../src/web-chat-history.js";
import { FleetManager } from "../src/fleet-manager.js";
import { WebChatDiskStore, WEB_CHAT_FILE } from "../src/web-chat-store.js";
import { effectTrialOffer } from "../src/web-effect-trials.js";
import { installDom } from "./helpers/mini-dom.js";
const offer = (patch: Record<string, unknown> = {}) => ({ v: 1, offer: "a".repeat(32), id: "b".repeat(32), title: "Fixture", expiresAt: 600000, ...patch });
const message = (patch: Record<string, unknown> = {}) => ({ boot: "aa", id: 1, instance: "own", sender: "agend", role: "status", text: "Host notice", ts: "2026-10-17T00:00:00Z", effectTrial: offer(), ...patch });
let check: any, messageOffer: any, createThread: any, t: any, setLang: any;
beforeAll(async () => {
  ({ checkEffectTrialOffer: check, effectTrialMessage: messageOffer } = await import("/ui/js/effect-trial-offer.js"));
  ({ createThread } = await import("/ui/js/chat-thread.js"));
  await import("/ui/js/chat-strings.js");
  ({ t, setLang } = await import("/assets/app-i18n.js"));
});
afterEach(() => vi.restoreAllMocks());

describe("closed volatile offer projection", () => {
  it("history keeps only checked host status metadata, copied and frozen", () => {
    const input = offer(), h = new WebChatHistory(), entry = h.recordEffectTrial("own", input, message().ts)!;
    expect(entry.effectTrial).toEqual(input); expect(entry.effectTrial).not.toBe(input); expect(Object.isFrozen(entry.effectTrial)).toBe(true);
    input.title = "Changed"; expect(entry.effectTrial?.title).toBe("Fixture");
    expect(h.list("own")[0]?.effectTrial).toEqual(entry.effectTrial);
    expect(h.replayFor({ boot: h.boot, id: 0 })[0]?.effectTrial).toEqual(entry.effectTrial);
    expect(h.list("other")).toEqual([]); expect(h.buttonStates()).toEqual([]);
  });
  it("the generic record path strips even exact host-looking sender/role metadata", () => {
    expect(new WebChatHistory().record(message()).effectTrial).toBeUndefined();
    for (const [instance, data] of [["", offer()], ["x".repeat(129), offer()], ["own", { ...offer(), extra: true }]] as const) expect(new WebChatHistory().recordEffectTrial(instance, data, message().ts)).toBeNull();
  });
  it.each([{ role: "agent" }, { role: "user" }, { role: "other" }, { sender: "own" }, { sender: "agend-other" }, { instance: "" }, { instance: "x".repeat(129) }])("does not promote text or another path: %j", patch => {
    expect(new WebChatHistory().record(message(patch)).effectTrial).toBeUndefined();
    expect(messageOffer(message(patch))).toBeNull();
  });
  it("real Fleet SSE projection carries display metadata but creates no agent-reply pulse", async () => {
    const writes: string[] = [], h = new WebChatHistory({ boot: "ab" });
    const fm: any = Object.assign(Object.create(FleetManager.prototype), { webChatHistory: h, sseClients: new Set([{ destroyed: false, writableEnded: false, write: (s: string) => { writes.push(s); return true; } }]), logger: { debug() {} } });
    fm.emitSseEvent("message", message());
    expect(h.list("own")[0]?.effectTrial).toBeUndefined(); expect(writes.join("")).not.toContain('"effectTrial"');
    expect(fm.publishEffectTrial("own", offer())).toBe(true);
    expect(h.list("own")[1]?.effectTrial).toEqual(offer());
    expect(writes.join("")).toContain('"effectTrial"'); expect(writes.join("")).not.toContain("agent_reply_live");
    fm.emitSseEvent("message", message({ role: "agent" }));
    expect(h.list("own")[2]?.effectTrial).toBeUndefined(); expect(writes.join("")).toContain("agent_reply_live");
  });
  it("real disk persistence omits offer and restore never revives poisoned interactive metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-trial-history-"));
    try {
      const store = new WebChatDiskStore({ home, ownerOf: () => "dir:/private", logger: { warn() {} }, debounceMs: 1 });
      const h = new WebChatHistory({ boot: "aa", store }); h.record(message()); h.recordEffectTrial("own", offer(), message().ts); await store.flush();
      const disk = readFileSync(join(home, "workspaces", "own", WEB_CHAT_FILE), "utf8");
      for (const value of ["effectTrial", "expiresAt", "a".repeat(32), "b".repeat(32)]) expect(disk).not.toContain(value);
      const rows = store.load("own")! as Record<string, unknown>[]; expect(rows).toHaveLength(1); rows[0]!.effectTrial = offer();
      const next = new WebChatHistory({ boot: "bb" }); expect(next.restore("own", rows)).toBe(1);
      expect(next.list("own")[0]?.effectTrial).toBeUndefined(); expect(next.list("own")[0]?.text).toBe("Host notice");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  const validTitles = ["Fixture", "👨‍👩‍👧".repeat(40), "x\u0301".normalize("NFC").repeat(40), "<img src=x onerror=alert(1)> & \"test\""];
  it.each(validTitles)("server and browser accept exact normalized graphemes: %s", title => {
    const value = offer({ title }); expect(effectTrialOffer(value)).not.toBeNull(); expect(check(value)).toEqual(effectTrialOffer(value));
    expect(Object.isFrozen(check(value))).toBe(true); expect(check(value)).not.toBe(value);
  });
  it.each([
    { v: 2 }, { offer: "A".repeat(32) }, { id: 1 }, { extra: true }, { title: "" }, { title: "x".repeat(41) },
    { title: "👨‍👩‍👧".repeat(41) }, { title: "q" + "\u0301".repeat(400) }, { title: "e\u0301" }, { title: " title" },
    { title: "a\nb" }, { title: "a\u202eb" }, { title: "\u2800" }, { expiresAt: -1 }, { expiresAt: Infinity }, { expiresAt: "1" },
  ])("server and browser refuse %j", patch => { const value = offer(patch); expect(effectTrialOffer(value)).toBeNull(); expect(check(value)).toBeNull(); });
  it("never reads accessors; rejects symbols, nonenumerable keys, exotic prototypes and revocation", () => {
    let reads = 0;
    for (const key of Object.keys(offer())) {
      const x = offer(); Object.defineProperty(x, key, { enumerable: true, get() { reads++; throw Error("getter"); } });
      expect(effectTrialOffer(x)).toBeNull(); expect(check(x)).toBeNull();
    }
    expect(reads).toBe(0);
    for (const x of [Object.assign(offer(), { [Symbol()]: 1 }), Object.create(offer()), Object.assign(Object.create({}), offer()), [], null, 1, "x"]) { expect(effectTrialOffer(x)).toBeNull(); expect(check(x)).toBeNull(); }
    const nonenum = offer(); Object.defineProperty(nonenum, "id", { enumerable: false }); expect(check(nonenum)).toBeNull(); expect(effectTrialOffer(nonenum)).toBeNull();
    const { proxy, revoke } = Proxy.revocable(offer(), {}); revoke(); expect(check(proxy)).toBeNull(); expect(effectTrialOffer(proxy)).toBeNull();
    const nullProto = Object.assign(Object.create(null), offer()); expect(check(nullProto)).toEqual(offer());
  });
});

describe("the real thread's inert protected offer card", () => {
  function fixture(lang = "en", publicLink = false, extra = {}) {
    const dom = installDom({}), doc = dom.document, list = doc.createElement("div"), scroller = doc.createElement("div");
    if (publicLink) doc.body.setAttribute("data-public-link", "1"); scroller.append(list); doc.body.append(scroller); setLang(lang);
    const start = vi.fn(), th = createThread(list, scroller, { t, tf: t, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {}, setPreviewOptIn() {}, copyText: async () => true, download() {}, onEffectTrial: start, serverNow: () => 0, ...extra });
    return { dom, list, th, start };
  }
  it.each([["en", "Effect trial", "Sign in as an admin outside the public link to Try."], ["zh-TW", "效果試播", "請在公開連結以外的儀表板以管理員登入後試播。"]])("escaped display in %s, no runnable UI", (lang, label, hint) => {
    const f = fixture(lang); try {
      f.th.render([message({ effectTrial: offer({ title: '<b>x</b> & "quoted"' }), text: "not card content" })]);
      const card = f.list.querySelector(".effect-trial-offer")!; expect(card.getAttribute("data-trust")).toBe("thread-control");
      expect(card.textContent).toBe(`${label}: <b>x</b> & "quoted"${hint}`); expect(card.querySelector("b")).toBeNull();
      expect(card.querySelector("button,a,iframe,canvas,input")).toBeNull(); expect(card.innerHTML).not.toContain("data-act");
      expect(card.innerHTML).not.toContain("a".repeat(32)); expect(card.innerHTML).not.toContain("b".repeat(32));
      f.th.onClick({ target: card }); expect(f.start).not.toHaveBeenCalled();
    } finally { f.th.dispose(); f.dom.restore(); }
  });
  it("public link also gets only an inert local-admin explanation", () => {
    const f = fixture("en", true); try { f.th.render([message()]); expect(f.list.querySelector(".effect-trial-offer")!.textContent).toContain("Sign in as an admin outside the public link"); expect(f.list.querySelector("button,iframe")).toBeNull(); } finally { f.th.dispose(); f.dom.restore(); }
  });
  it("only the current real host button accepts a trusted click; DOM carries a message key, not the offer", () => {
    const start = vi.fn(), row = message(), f = fixture("en", false, { canTryEffect: () => true, startEffectTrial: start });
    try {
      f.th.render([row]); const button = f.list.querySelector("button.effect-trial-start")!;
      expect(button.getAttribute("data-arg")).toBe("aa-1"); for (const key of ["a".repeat(32), "b".repeat(32)]) expect(button.outerHTML).not.toContain(key);
      f.th.onClick({ target: button }); f.th.onClick({ target: button, isTrusted: false }); expect(start).not.toHaveBeenCalled();
      const forged = f.list.ownerDocument.createElement("button"); forged.className = "btn btn-sm effect-trial-start"; forged.setAttribute("data-act", "effectTrial"); forged.setAttribute("data-arg", "aa-1"); button.parentElement!.append(forged);
      f.th.onClick({ target: forged, isTrusted: true }); expect(start).not.toHaveBeenCalled();
      f.th.onClick({ target: button, isTrusted: true, defaultPrevented: true }); expect(start).not.toHaveBeenCalled();
      f.th.onClick({ target: button, isTrusted: true }); expect(start).toHaveBeenCalledExactlyOnceWith(row);
      f.th.render([message({ effectTrial: offer({ title: "New" }) })]); f.th.onClick({ target: button, isTrusted: true }); expect(start).toHaveBeenCalledOnce();
    } finally { f.th.dispose(); f.dom.restore(); }
  });
  it.each([
    ["localAdmin", "Sign in as an admin outside the public link to Try.", "Sign in here"],
    ["busy", "Stop the current trial before starting another.", "Stop current trial"],
    ["effectsOff", "Turn on effects to Try.", "Open playback settings"],
    ["reducedMotion", "Effects follow this device’s reduced-motion setting.", "Play effects anyway"],
  ])("one unmet %s condition has one host action; it can never start from the fix click", (reason, hint, label) => {
    const fix = vi.fn(), start = vi.fn(), row = message(), f = fixture("en", false, { effectTrialStatus: () => reason, fixEffectTrial: fix, canTryEffect: () => false, startEffectTrial: start });
    try { f.th.render([row]); const card = f.list.querySelector(".effect-trial-offer")!, button = card.querySelector("button")!;
      expect(card.textContent).toContain(hint); expect(button.textContent).toBe(label); expect(card.textContent).not.toContain("custom CSS"); expect(card.querySelectorAll("button")).toHaveLength(1);
      f.th.onClick({ target: button, isTrusted: false }); expect(fix).not.toHaveBeenCalled(); f.th.onClick({ target: button, isTrusted: true }); expect(fix).toHaveBeenCalledExactlyOnceWith(row, reason); expect(start).not.toHaveBeenCalled();
    } finally { f.th.dispose(); f.dom.restore(); }
  });
  it("session verification is an inert checking state, not a premature sign-in refusal", () => {
    const f = fixture("en", false, { effectTrialStatus: () => "checking", fixEffectTrial: vi.fn() });
    try { f.th.render([message()]); expect(f.list.textContent).toContain("Checking this session…"); expect(f.list.querySelector("button")).toBeNull(); } finally { f.th.dispose(); f.dom.restore(); }
  });
  it("growing the chunked thread through a click chip preserves exact Trial ownership and expiry", () => {
    vi.useFakeTimers(); let now = 0; const start = vi.fn(), row = message({ effectTrial: offer({ expiresAt: 10 }) });
    const f = fixture("en", false, { canTryEffect: () => true, startEffectTrial: start, serverNow: () => now });
    try {
      const buttons = { id: "c".repeat(32), state: "open", labels: ["Reply"] };
      const reply = message({ id: 2, sender: "own", role: "agent", text: "Old reply", effectTrial: undefined, buttons });
      const middle = Array.from({ length: 34 }, (_, i) => message({ id: i + 3, sender: "own", role: "agent", text: `Row ${i}`, effectTrial: undefined }));
      const click = message({ id: 37, sender: "person", role: "user", effectTrial: undefined, click: { label: "Reply", of: buttons.id } });
      f.th.render([row, reply, ...middle, click]); expect(f.list.querySelector(".effect-trial-offer")).toBeNull();
      const chip = f.list.querySelector(".click-chip")!; expect(chip.getAttribute("data-trust")).toBe("thread-control");
      f.th.onClick({ target: chip.querySelector("button"), isTrusted: true });
      expect(f.list.textContent).toContain("Old reply"); const button = f.list.querySelector("button.effect-trial-start")!; expect(button).not.toBeNull();
      f.th.onClick({ target: button, isTrusted: true }); expect(start).toHaveBeenCalledExactlyOnceWith(row);
      const forged = f.list.ownerDocument.createElement("button"); forged.className = button.className; forged.setAttribute("data-act", "effectTrial"); forged.setAttribute("data-arg", "aa-1"); button.parentElement!.append(forged); f.th.onClick({ target: forged, isTrusted: true }); expect(start).toHaveBeenCalledOnce();
      now = 10; vi.advanceTimersByTime(10); expect(f.list.querySelector("button.effect-trial-start")).toBeNull();
      expect(f.list.textContent).toContain("This trial offer has expired."); f.th.onClick({ target: button, isTrusted: true }); expect(start).toHaveBeenCalledOnce();
    } finally { f.th.dispose(); f.dom.restore(); vi.useRealTimers(); }
  });
  it("public link is inert even if a caller wrongly supplies an available display hint", () => {
    const start = vi.fn(), f = fixture("en", true, { canTryEffect: () => true, startEffectTrial: start });
    try { f.th.render([message()]); expect(f.list.querySelector("button")).toBeNull(); expect(start).not.toHaveBeenCalled(); } finally { f.th.dispose(); f.dom.restore(); }
  });
  it("a volatile card expires in place and cannot start from an old button, without another server event", () => {
    vi.useFakeTimers(); let now = 0; const start = vi.fn(), f = fixture("en", false, { canTryEffect: () => true, startEffectTrial: start, serverNow: () => now });
    try {
      f.th.render([message({ effectTrial: offer({ expiresAt: 10 }) })]); const old = f.list.querySelector("button.effect-trial-start")!; expect(old).not.toBeNull(); now = 10; vi.advanceTimersByTime(10);
      expect(f.list.querySelector("button.effect-trial-start")).toBeNull(); expect(f.list.textContent).toContain("This trial offer has expired."); f.th.onClick({ target: old, isTrusted: true }); expect(start).not.toHaveBeenCalled();
    } finally { f.th.dispose(); f.dom.restore(); vi.useRealTimers(); }
  });
  it.each([{ role: "agent" }, { role: "user" }, { sender: "own" }, { effectTrial: offer({ extra: true }) }, { effectTrial: undefined }])("invalid metadata/path remains ordinary text: %j", patch => {
    const f = fixture(); try { f.th.render([message(patch)]); expect(f.list.querySelector(".effect-trial-offer")).toBeNull(); expect(f.list.textContent).toContain("Host notice"); } finally { f.th.dispose(); f.dom.restore(); }
  });
});
