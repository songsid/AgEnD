/** Real native CLI overlap, death and wall-time bounds. No public network or real credentials. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "../../../src/child-process.js";
import { createHubCliProvider } from "../../../src/hub/execution/cli-provider.js";
import type { HubCliBackend } from "../../../src/hub/execution/model-broker.js";
import { executionFixture } from "./fixture.mjs";
import { approvedCall, finalOutput, mockReply } from "./mock-api.mjs";
const run = promisify(execFile), imageId = process.env.IMAGE_ID ?? readFileSync(".artifacts/hub-s4b-work/image-config-id", "utf8").trim();
const out = process.env.OUT ?? ".artifacts/hub-s4b-work/lifecycle"; mkdirSync(out, { recursive: true });
const results: unknown[] = [];
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function gone(context: string) {
  const ids = (await run("docker", ["ps", "-a", "--filter", `label=org.agend.hub.context=${context}`, "--format", "{{.ID}}"], { timeout: 10_000 })).stdout.trim(); assert.equal(ids, "");
}
for (const backend of ["claude", "codex"] as HubCliBackend[]) {
  const tags = [randomUUID(), randomUUID()], count = [0, 0], bodies: unknown[] = [], together = defer(); let waiting = 0;
  const provider = await createHubCliProvider({ backend, imageId, model: backend === "claude" ? "claude-sonnet-4-5" : "mock-model", modelBroker: async (_b, body) => {
    const text = JSON.stringify(body), i = tags.findIndex(t => text.includes(t)); assert(i >= 0); assert(!text.includes(tags[1 - i])); bodies.push(body); count[i]++;
    if (count[i] === 1) { if (++waiting === 2) together.resolve(); await together.promise; }
    return mockReply(backend, count[i] === 1 ? approvedCall(backend, "read", { documentId: "approved-note" }) : finalOutput(`ANSWER_${tags[i]}`), count[i]);
  } });
  const fixtures = tags.map(t => executionFixture(out, provider, t));
  try {
    const contexts = await Promise.all(fixtures.map((f, i) => f.begin(f.question(`Question ${tags[i]}: read only approved-note.`))));
    const answers = await Promise.all(fixtures.map((f, i) => f.service.finish(contexts[i])));
    for (let i = 0; i < 2; i++) { assert.equal(answers[i].text, `ANSWER_${tags[i]}`); assert.equal(count[i], 2); await gone(contexts[i].id); }
    writeFileSync(`${out}/${backend}-overlap.json`, JSON.stringify({ tags, bodies, operations: fixtures.map(f => f.operations) }, null, 2));
    results.push({ backend, scenario: "overlap", ok: true }); console.log(`PASS ${backend} concurrent fresh native questions`);
  } finally { await Promise.all(fixtures.map(f => f.close())); await provider.close(); }
}
// Both real two-minute deadlines run together. All model traffic is held in an abort-aware fake API.
await Promise.all((["claude", "codex"] as HubCliBackend[]).flatMap(backend => ["native-death", "wall-deadline"].map(async scenario => {
  const entered = defer(); let calls = 0;
  const provider = await createHubCliProvider({ backend, imageId, model: backend === "claude" ? "claude-sonnet-4-5" : "mock-model", modelBroker: async (_b, _body, signal) => {
    calls++; entered.resolve(); return await new Promise<never>((_, reject) => { signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }); });
  } });
  const f = executionFixture(out, provider, `${backend}-${scenario}`), start = Date.now();
  try {
    const q = f.question(`${backend}-${scenario}: wait for approved read only.`), context = await f.begin(q);
    const finishing = f.service.finish(context), refused = assert.rejects(finishing); await entered.promise;
    if (scenario === "native-death") {
      const id = (await run("docker", ["ps", "--filter", `label=org.agend.hub.context=${context.id}`, "--format", "{{.ID}}"], { timeout: 10_000 })).stdout.trim(); assert(id);
      const kill = "const f=require('node:fs');let n=0;for(const p of f.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const s=f.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[0];if(s.includes('/claude-code-linux-x64/claude')||s.endsWith('/codex')){process.kill(Number(p),'SIGKILL');n++}}catch{}}if(!n)process.exit(2);console.log('KILLED_NATIVE_'+n);";
      await run("docker", ["exec", id, "/usr/local/bin/node", "-e", kill], { timeout: 10_000 });
    }
    await refused; const elapsed = Date.now() - start; assert.equal(calls, 1); await gone(context.id);
    assert(!f.operations.some(r => r.phase === "release-answer"));
    if (scenario === "wall-deadline") { assert(elapsed >= 115_000); assert(elapsed < 140_000); }
    results.push({ backend, scenario, elapsed, ok: true }); console.log(`PASS ${backend} ${scenario} (${elapsed}ms)`);
  } finally { await f.close(); await provider.close(); }
})));
assert.equal(results.length, 6); writeFileSync(`${out}/result.json`, JSON.stringify({ imageId, results }, null, 2));
