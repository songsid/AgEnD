// Real CLI acceptance adapter: actual shared usage cache and reminder service, inert usage source and outbound sink.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { QuotaNotices } from "../../../src/usage/quota-notices.js";
import { quotaNoticeRule } from "../../../src/quota-notice-config.js";
import { getUsageSnapshot, onUsageSnapshot, setUsageFetcherForTests } from "../../../src/usage/usage-api.js";

const root = process.env.RIG_ROOT!;
const policy = { target: "general", locale: "en", subscriptions: ["one", "two"].map(() => ({ account: "codex:host:fixture", providerId: "codex:fixture", rule: quotaNoticeRule(undefined, "codex") })) };
const service = new QuotaNotices({ file: join(root, "quota-notices.json"), policy: () => policy,
  send: (target, text) => { appendFileSync(join(root, "dispatch.jsonl"), JSON.stringify({ target, text }) + "\n"); return true; },
  warn: error => { appendFileSync(join(root, "errors.log"), String(error) + "\n"); },
});
let settled: Promise<void> = Promise.resolve();
const unsubscribe = onUsageSnapshot(p => { settled = service.observe(p); });
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [{ id: "codex:fixture", name: "Codex (fixture)", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 92, windowMs: 7 * 86_400_000, resetsAt: new Date(Number(process.env.RIG_RESET)).toISOString() }] }] }));
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", async line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  if (m.method === "initialize") return void send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "quota", version: "1" } } });
  if (m.method === "tools/list") return void send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "get_usage", description: "Read fixture account usage", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
  if (m.method === "tools/call") {
    const payload = await getUsageSnapshot(); await settled;
    appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ method: m.params.name, pid: process.pid }) + "\n");
    return void send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } });
});
process.stdin.on("end", () => { unsubscribe(); void service.stop(); });
