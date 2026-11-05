/**
 * Human-facing cross-instance notices hide hmsg-/xmsg- ids, verification_id parentheticals, and
 * forwards: [...] lists. The agent payload (content + forwards meta) stays byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hideInternalMessageIds,
  senderTopicNotice,
  targetTopicNotice,
} from "../src/cross-instance-notice.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { setLocale } from "../src/locale.js";

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

const HMSG = "hmsg-a6a0c22a-1111-2222-3333-444444444444";
const XMSG = "xmsg-1793841918832-mjcguh";
const SHA = "e5788cbf3e03ffa12e7dabec57674a7f3355b004";
const URL = "https://github.com/songsid/AgEnD/pull/3049";

describe("hideInternalMessageIds", () => {
  it.each([
    [`please check verification_id ${HMSG} thanks`, "please check thanks"],
    [`please check verification_id: ${HMSG} thanks`, "please check thanks"],
    [`message_id ${XMSG} in the envelope`, "in the envelope"],
    [`message_id: ${XMSG} in the envelope`, "in the envelope"],
    [`bare ${XMSG} and ${HMSG} stay gone`, "bare and stay gone"],
    [`forwards: [${HMSG}, ${XMSG}] after that`, "after that"],
    [`see (${HMSG}) now`, "see now"],
    [`keep (${"verification_id"} ${HMSG}) out`, "keep out"],
    [`hello, ${XMSG}.`, "hello."],
  ] as const)("en: %s", (raw, want) => {
    expect(hideInternalMessageIds(raw)).toBe(want);
  });

  it.each([
    [`請核對 verification_id ${HMSG}，謝謝`, "請核對，謝謝"],
    [`請核對 verification_id: ${HMSG}，謝謝`, "請核對，謝謝"],
    [`信封 message_id ${XMSG} 還在`, "信封 還在"],
    [`裡面有 ${XMSG} 和 ${HMSG}`, "裡面有 和"],
    [`forwards: [${HMSG}] 之後`, "之後"],
    [`看（verification_id ${HMSG}）就好`, "看就好"],
    [`完成，${XMSG}。`, "完成。"],
  ] as const)("zh: %s", (raw, want) => {
    expect(hideInternalMessageIds(raw)).toBe(want);
  });

  it("keeps SHAs, PR numbers and URLs", () => {
    const raw = `Review ${URL} at ${SHA} (#3049) verification_id ${HMSG}`;
    expect(hideInternalMessageIds(raw)).toBe(`Review ${URL} at ${SHA} (#3049)`);
  });
});

describe("topic notices hide ids, not the label", () => {
  const label = "alice → bob";
  it("full task/query and sender notices drop each id shape", () => {
    const message = `Do the review ${URL} ${SHA} (#3049). verification_id ${HMSG} message_id ${XMSG} forwards: [${HMSG}] (verification_id ${HMSG})`;
    const input = { label, message, requestKind: "task" };
    const want = `${label}:\nDo the review ${URL} ${SHA} (#3049).`;
    expect(senderTopicNotice("full", input)).toBe(want);
    expect(targetTopicNotice("full", input)).toBe(want);
    expect(senderTopicNotice("full", input) ?? "").not.toContain("hmsg-");
    expect(senderTopicNotice("full", input) ?? "").not.toContain("xmsg-");
    expect(senderTopicNotice("full", input) ?? "").not.toContain("forwards:");
    expect(senderTopicNotice("full", input) ?? "").not.toContain("verification_id");
  });

  it("summary uses the cleaned task summary in en and zh", () => {
    expect(senderTopicNotice("summary", {
      label, message: `body ${HMSG}`, taskSummary: `Ship #9 verification_id ${HMSG}`,
    })).toBe(`${label}: Ship #9`);
    expect(targetTopicNotice("summary", {
      label, message: `請處理 ${XMSG}`, taskSummary: `核對 PR #9，${XMSG}`, requestKind: "query",
    })).toBe(`${label}: 核對 PR #9`);
  });
});

describe("agent payload stays byte-identical", () => {
  async function send(message: string, extra?: Record<string, unknown>) {
    const posts: string[] = [];
    const mirror: string[] = [];
    const admitted: Array<{ payload: { content: string; meta: Record<string, string> } }> = [];
    const web: string[] = [];
    const ctx = {
      fleetConfig: {
        channel: { type: "telegram", group_id: "-100777" },
        defaults: {},
        instances: {
          alice: { working_directory: "/w/a", topic_id: 11 },
          bob: { working_directory: "/w/b", topic_id: 22 },
        },
      },
      adapter: {
        sendText: async (_chatId: string, text: string) => {
          posts.push(text);
          return { messageId: "m", chatId: "-100777" };
        },
      },
      instanceIpcClients: new Map([["bob", { connected: true }]]),
      sessionRegistry: new Map(),
      lifecycle: { daemons: new Map() },
      getInstanceStatus: () => "running",
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      admitDurableDelivery: (record: { payload: { content: string; meta: Record<string, string> } }) => {
        admitted.push(record);
        return { deliveryId: "d1", state: "queued", duplicate: false };
      },
      queueMirrorMessage: (line: string) => { mirror.push(line); },
      emitSseEvent: (_event: string, data: { text?: string; role?: string }) => {
        if (data?.role === "status" && data.text) web.push(data.text);
      },
    };
    let error: unknown;
    await outboundHandlers.get("send_to_instance")!(
      ctx as never,
      { instance_name: "bob", message, request_kind: "task", ...extra } as never,
      (_result, err) => { error = err; },
      { instanceName: "alice" } as never,
    );
    expect(error).toBeUndefined();
    await new Promise(r => setImmediate(r));
    return { posts, mirror, admitted, web, message };
  }

  it("topics, mirror and web hide ids; content and forwards meta are unchanged", async () => {
    const forwards = [XMSG];
    const message = `Please verify ${HMSG} and ${XMSG} forwards: [${HMSG}] (verification_id ${HMSG}) ${URL} ${SHA} (#3049)`;
    const r = await send(message, { forwards });
    expect(r.admitted).toHaveLength(1);
    expect(r.admitted[0]!.payload.content).toBe(message);
    expect(r.admitted[0]!.payload.meta.forwards).toBe(JSON.stringify(forwards));
    for (const line of [...r.posts, ...r.mirror, ...r.web]) {
      expect(line).not.toContain("hmsg-");
      expect(line).not.toContain("xmsg-");
      expect(line).not.toContain("forwards:");
      expect(line).not.toContain("verification_id");
      expect(line).toContain(URL);
      expect(line).toContain(SHA);
      expect(line).toContain("#3049");
    }
  });
});
