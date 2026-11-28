/**
 * M-3908 (the user look at #4573's comment status): a failed delivery says why, as the other failures do — the delivery outbox's
 * category of the recorded error (the instance stayed unavailable until the notice expired, several tries did not get through, the
 * submission failed), never the recorded text; 「還有 N 張卡」 opens the rest of the unread strip; status lines and comment bodies keep
 * zh words whole. Measured in Chromium by scripts/manual/comment-status-nits-m3908/capture.mts (docs/evidence/comment-status-nits-m3908).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryOutbox, noticeFailure } from "../src/delivery-outbox.js";
import { wakeViews } from "../src/web-api.js";
import type { EntryWake } from "../src/scheduler/task-board.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "m3908-")); dirs.push(d); return d; };
const read = (f: string) => readFileSync(f, "utf8");

describe("M-3908 1. a failed delivery says why", () => {
  it("the category of a recorded error: expired, attempts, other — never the text", () => {
    expect(noticeFailure("delivery TTL expired before target became available")).toBe("expired");
    expect(noticeFailure("delivery TTL expired: target could not be woken: pane gone")).toBe("expired");
    expect(noticeFailure("delivery submission attempt limit reached")).toBe("attempts");
    expect(noticeFailure("Windows runtime does not support terminal input or steering")).toBe("other");
    expect(noticeFailure(null)).toBe("other");
  });

  it("the real outbox: a notice that expired, one that failed before it began, and one still queued", () => {
    const outbox = new DeliveryOutbox(join(tmp(), "outbox.db"), "boot-1");
    try {
      const [expired, failed, queued] = ["task-board:dev-a:1:1:cards=u1", "task-board:dev-b:1:2:cards=u2", "task-board:dev-c:1:3:cards=u3"];
      // dev-a's notice waits past any notice's age (a year on, so a system notice's longer life has passed too): it expires.
      outbox.admitSystemNotice("dev-a", expired, "[Task board] one", new Date());
      expect(outbox.expireStale(Date.now() + 365 * 86_400_000, 30_000)).toBe(1);
      outbox.admitSystemNotice("dev-b", failed, "[Task board] two", new Date());
      outbox.admitSystemNotice("dev-c", queued, "[Task board] three", new Date());
      const id = (outbox as unknown as { db: { prepare(s: string): { get(k: string): { delivery_id: string } } } }).db.prepare("SELECT delivery_id FROM deliveries WHERE source_key=?").get(failed).delivery_id;
      expect(outbox.failBeforeBegin(id, "target pane is gone")).toBe(true);
      const p = outbox.noticeProgress([expired, failed, queued]);
      expect(p.get(expired)).toMatchObject({ state: "failed", failure: "expired" });
      expect(p.get(failed)).toMatchObject({ state: "failed", failure: "other" });
      expect(p.get(queued)!.state).toBe("queued");
      expect(p.get(queued)).not.toHaveProperty("failure");
      expect(JSON.stringify([...p.values()])).not.toMatch(/TTL|pane is gone|Task board/);
    } finally { outbox.close(); }
  });

  it("the card read carries the category on a failed wake only", () => {
    const at = new Date().toISOString();
    const w = (key: string): EntryWake => ({ to: "dev-a", why: "assignee", key, at });
    const progress = new Map([
      ["f", { target: "dev-a", state: "failed", createdAt: at, finishedAt: at, consumedAt: null, failure: "attempts" }],
      ["d", { target: "dev-a", state: "delivered", createdAt: at, finishedAt: at, consumedAt: null }],
    ] as const) as unknown as Parameters<typeof wakeViews>[1];
    const [failed, delivered] = wakeViews([w("f"), w("d")], progress, Date.now());
    expect(failed).toMatchObject({ state: "failed", failure: "attempts" });
    expect(delivered).not.toHaveProperty("failure");
  });

  it("the page says it in EN and zh; an older server's failure (no category) keeps the plain line", () => {
    const src = read("src/ui/fleet-task-wake.js");
    for (const [k, en, zh] of [
      ["fail.expired", "Could not deliver to {0}: it stayed unavailable until the notice expired", "沒有送達 {0}：它一直無法接收，通知已過期"],
      ["fail.attempts", "Could not deliver to {0}: several tries did not get through", "沒有送達 {0}：試了幾次都沒送進去"],
      ["fail.other", "Could not deliver to {0}: sending it into {0}'s session failed", "沒有送達 {0}：傳進 {0} 的對話時失敗"],
    ]) { expect(src).toContain(`"${k}": "${en}"`); expect(src).toContain(`"${k}": "${zh}"`); }
    expect(src).toContain('failed: "Could not deliver to {0}"');
    expect(src).toContain('failed: "沒有送達 {0}"');
    expect(src).toMatch(/FAILURES\.includes\(w\.failure\) \? t\(`taskwake\.fail\.\$\{w\.failure\}`, to\) : t\("taskwake\.failed", to\)/);
  });
});

describe("M-3908 2–3. the strip's overflow and the phone layout", () => {
  it("「還有 N 張卡」 is a button that opens the rest (aria-expanded), and folds back with 收合", () => {
    const src = read("src/ui/fleet-task-unread.js");
    expect(src).toContain('seeMore: "還有 {0} 張卡", showFewer: "收合"');
    expect(src).toContain('seeMore: "{0} more cards", showFewer: "Show fewer"');
    expect(src).toMatch(/<button type="button" class="tb-link" aria-expanded=\$\{all \? "true" : "false"\} onClick=\$\{\(\) => setAll\(!all\)\}>/);
    expect(src).toContain("const shown = all ? codes : codes.slice(0, SHOWN);");
    expect(read("src/ui/shared/task-board.css")).toContain(".tb-unread-more .tb-link { display: inline-flex; align-items: center; min-height: var(--tap); }");
  });

  it("status lines and comment bodies keep zh words whole", () => {
    const css = read("src/ui/shared/task-board.css");
    expect(css).toContain(".tl-wake > span, .tl-wake .tb-link { min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }");
    expect(css).toContain(".tl-comment .tl-body { word-break: keep-all; overflow-wrap: anywhere; text-wrap: pretty; }");
  });
});
