/**
 * #3756 (M-3002): the live activity block was drawn UNDER the agent's reply for about one /ui/steps round trip, then
 * jumped above it. The reply's row comes over the SSE message stream; the steps that name it come with the next steps
 * read. Until that read, the turn's work is still the live group, and composeRows always put the live group last.
 * Now the live group goes before the first agent row newer than its start that no group claims, so the reply lands
 * under the block and the block stays put when it becomes the reply's (`id`) group. Unchanged (the end): a person's
 * message newer than the start comes first, a row with no time, and a reply call that named a row which is not there.
 * Here: the pure functions, with steps and ledger rows written by hand (times in ms).
 */
import { describe, expect, it } from "vitest";
import type { LogStep } from "../src/log-steps.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps, composeRows } from "../src/ui/chat-activity-groups.js";

const at = (ms: number) => new Date(ms).toISOString();
const user = (id: string, ts: number, messageId: string): LogStep => ({ id, turn: "t1", ts, kind: "user", anchor: { messageId } } as LogStep);
const tool = (id: string, ts: number, name = "Bash"): LogStep => ({ id, turn: "t1", ts, kind: "tool", tool: name, cat: "run", status: "done", subject: id } as LogStep);
const reply = (id: string, ts: number, messageId?: string, text = "Done."): LogStep =>
  ({ id, turn: "t1", ts, kind: "tool", tool: "mcp__agend__reply", status: "done", anchor: { replyText: text, ...(messageId ? { messageId } : {}) } } as LogStep);
const end = (ts: number): LogStep => ({ id: "e", turn: "t1", ts, kind: "turn_end" } as LogStep);

const userRow = { boot: "b", id: 1, role: "user", text: "please look", anchor: "web-u1", ts: at(999) };
const agentRow = (id: number, ts: string, anchor: string, text = "Done.") => ({ boot: "b", id, role: "agent", text, anchor, ts });
/** `user act:<level>:<items> agent` — the order a page draws. */
const shape = (rows: Array<Record<string, any>>) => rows.map((x) => (x.role === "activity" ? `act:${x.group.level}:${x.group.items.length}` : x.role)).join(" ");
const compose = (rows: Array<Record<string, any>>, steps: LogStep[], now = 1e12) => composeRows(rows, groupSteps(rows, steps, { now, complete: true }));

describe("#3756: the live block sits above the reply that arrived before the steps read", () => {
  const working = [user("u", 1000, "web-u1"), tool("a", 1100, "Read"), tool("b", 1200)];        // the read before the reply call
  const done = [...working, reply("r", 1250, "web-r1"), end(1300)];                             // the read after it

  it("the reply's row first: user · live · agent; then the read: user · id · agent — the same key, no reorder", () => {
    const rows = [userRow, agentRow(2, at(1260), "web-r1")];
    const before = compose(rows, working);
    expect(shape(before)).toBe("user act:live:2 agent");
    const after = compose(rows, done);
    expect(shape(after)).toBe("user act:id:2 agent");
    expect(after[1].id).toBe(before[1].id);
    // control: with no reply row yet, the live block is at the end, as before
    expect(shape(compose([userRow], working))).toBe("user act:live:2");
  });

  it("a message the person sends during the turn keeps it at the end (it may start another turn)", () => {
    const followUp = { boot: "b", id: 3, role: "user", text: "also check b", anchor: "web-u2", ts: at(1150) };
    expect(shape(compose([userRow, followUp, agentRow(4, at(1260), "web-r1")], working))).toBe("user user agent act:live:2");
    // control: the turn's own prompt row, even stamped after the work began, does not count as a later message
    const lateStamp = { ...userRow, ts: at(1050) };
    expect(shape(compose([lateStamp, agentRow(2, at(1260), "web-r1")], working))).toBe("user act:live:2 agent");
  });

  it("a second segment: it goes above the second reply's row, never above the first reply's (claimed) row", () => {
    // The first reply's row is stamped after its call (the live segment's start): newer than `from`, but claimed by id.
    const steps = [user("u", 1000, "web-u1"), tool("a", 1100, "Read"), reply("r1", 1200, "web-r1", "Looking."), tool("b", 1300)];
    const rows = [userRow, agentRow(2, at(1210), "web-r1", "Looking."), agentRow(3, at(1400), "web-r2")];
    expect(shape(compose(rows, steps))).toBe("user act:id:1 agent act:live:1 agent");
    const later = [...steps, reply("r2", 1350, "web-r2"), end(1450)];
    const after = compose(rows, later);
    expect(shape(after)).toBe("user act:id:1 agent act:id:1 agent");
    expect(after[3].id).toBe(compose(rows, steps)[3].id);
    // control: with the second reply's row not there yet, the live segment is at the end
    expect(shape(compose(rows.slice(0, 2), steps))).toBe("user act:id:1 agent act:live:1");
  });

  it("an agent row with no time: passed over (the end, as before)", () => {
    expect(shape(compose([userRow, agentRow(2, "", "web-r1")], working))).toBe("user agent act:live:2");
    expect(shape(compose([userRow, agentRow(2, "not a date", "web-r1")], working))).toBe("user agent act:live:2");
    // an older agent row (before the turn began) is not a reply of this turn either
    const older = agentRow(0, at(500), "web-old", "Earlier.");
    expect(shape(compose([older, userRow], working))).toBe("agent user act:live:2");
  });

  it("R4: a reply call that named its row's id waits for that row only — never above another agent's row", () => {
    const steps = [user("u", 1000, "web-u1"), tool("a", 1100), reply("r", 1200, "web-mine")];
    const other = agentRow(2, at(1210), "web-other", "something else entirely");
    const g = groupSteps([userRow, other], steps, { now: 1300, complete: true });
    expect([g.live?.level, g.live?.waitsFor]).toEqual(["live", "web-mine"]);
    expect(shape(composeRows([userRow, other], g))).toBe("user agent act:live:1");
  });

  it("R4: another turn's reply, after that turn's own prompt, is never the row a live group goes above", () => {
    // Turn A is in flight (only its steps are held); turn B's prompt and reply rows are already in the ledger.
    const rowB = { boot: "b", id: 4, role: "agent", text: "Done.", ts: at(1220), anchor: "web-B" };
    const promptB = { boot: "b", id: 3, role: "user", text: "q2", ts: at(1210), anchor: "web-u2" };
    expect(shape(compose([userRow, promptB, rowB], working, 1300))).toBe("user user agent act:live:2");
  });
});
