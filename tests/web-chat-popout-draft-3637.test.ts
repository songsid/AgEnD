import { describe, expect, it, vi } from "vitest";
import { createChatStore } from "/ui/js/chat-store.js";
const make = () => createChatStore({ t: (s: string) => s, toast: vi.fn(), announce: vi.fn(), fetch: vi.fn() }) as any;
describe("a pop-out moves only a captured, still-current local composer", () => {
  it("only the store that issued the original ticket can consume it", () => {
    const a = make(), b = make(); a.setDraft("alpha", "same"); b.setDraft("alpha", "same");
    const draft = a.captureDraft("alpha"); expect(b.clearCapturedDraft(draft)).toBe(false);
    expect(a.clearCapturedDraft({ ...draft })).toBe(false); expect(a.clearCapturedDraft(draft)).toBe(true); expect(a.clearCapturedDraft(draft)).toBe(false);
  });
  it("imports text, files and this agent's reply without sending or uploading", () => {
    const a = make(), b = make(), file = new File(["fixture"], "note.txt", { type: "text/plain" });
    a.setDraft("alpha", "unsent draft"); a.addFiles("alpha", [file]); a.startReply("alpha", { boot: "boot", id: 12, text: "quoted" });
    const draft = a.captureDraft("alpha");
    expect(b.acceptDraft("alpha", draft.payload)).toBe(true);
    expect(b.state.drafts.alpha).toBe("unsent draft"); expect(b.state.pendingFiles.alpha).toEqual([file]); expect(b.state.replies.alpha.id).toBe(12);
    expect(a.draftCurrent(draft)).toBe(true); expect(a.clearCapturedDraft(draft)).toBe(true);
    expect(a.state.drafts.alpha).toBe(""); expect(a.state.pendingFiles.alpha).toEqual([]); expect(a.state.replies.alpha).toBeUndefined();
    expect(a.state.outgoing).toEqual({}); expect(b.state.outgoing).toEqual({});
  });
  it("keeps edits made during startup, even when typing returns to the same text", () => {
    const a = make(); a.setDraft("alpha", "first"); const draft = a.captureDraft("alpha");
    a.setDraft("alpha", "new"); a.setDraft("alpha", "first");
    expect(a.draftCurrent(draft)).toBe(false); expect(a.clearCapturedDraft(draft)).toBe(false); expect(a.state.drafts.alpha).toBe("first");
    expect(make().clearCapturedDraft(draft)).toBe(false);
  });
  it("refuses an occupied child and validates all attachments before changing anything", () => {
    const a = make(); a.setDraft("alpha", "child typed");
    expect(a.acceptDraft("alpha", { text: "incoming", files: [], reply: null })).toBe(false);
    a.setDraft("alpha", "");
    expect(a.acceptDraft("alpha", { text: "incoming", files: [{ name: "fake", size: 1 }], reply: null })).toBe(false);
    expect(a.acceptDraft("alpha", { text: "incoming", files: Array.from({ length: 6 }, () => new File(["x"], "x.txt")), reply: null })).toBe(false);
    expect(a.state.drafts.alpha).toBe(""); expect(a.state.pendingFiles.alpha).toBeUndefined();
    expect(a.acceptDraft("alpha", { text: "incoming", files: [], reply: { boot: "b", id: -1 } })).toBe(false);
  });
  it("never transfers outgoing work, credentials, another target, or an unbounded payload", () => {
    const a = make(); a.setDraft("beta", "other agent");
    expect(a.acceptDraft("alpha", { text: "x", files: [], reply: null, token: "not accepted" })).toBe(false);
    expect(a.acceptDraft("alpha", { text: "x".repeat(1_000_001), files: [], reply: null })).toBe(false);
    expect(a.state.drafts.beta).toBe("other agent");
    const snap = a.captureDraft("beta"); a.addToDraft("beta", "later"); expect(a.clearCapturedDraft(snap)).toBe(false);
  });
});
