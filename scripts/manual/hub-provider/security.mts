/** Real pinned CLIs + real signed admission/S4 gateway. Model APIs are in-process scripted mocks only. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "../../../src/child-process.js";
import { createHubCliProvider, HUB_PROVIDER_CLI_VERSIONS } from "../../../src/hub/execution/cli-provider.js";
import { HUB_CLI_TOOLS, type HubCliBackend } from "../../../src/hub/execution/model-broker.js";
import { executionFixture } from "./fixture.mjs";
import { approvedCall, finalOutput, mockReply, type MockOutput } from "./mock-api.mjs";
const run = promisify(execFile), imageId = process.env.IMAGE_ID ?? readFileSync(".artifacts/hub-s4b-work/image-config-id", "utf8").trim();
const out = process.env.OUT ?? ".artifacts/hub-s4b-work/security"; mkdirSync(out, { recursive: true });
const results: unknown[] = [];
const selections = process.argv.slice(2);
const scenarios = ["read", "proposal", "shell", "write", "home", "network", "child-agent", "forged-receipt", "foreign-tool", "private-document", "extra-path", "revoked", "denied-release", "answer-flood", "api-bound", "cancel-model", "cancel-tool", "cr-forbidden", "crlf-read"];
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
for (const backend of ["claude", "codex"] as HubCliBackend[]) for (const scenario of scenarios) {
  const isRead = scenario === "read" || scenario === "crlf-read";
  const name = `${backend}-${scenario}`; if (selections.length && !selections.some(s => name.includes(s))) continue;
  const bodies: Record<string, unknown>[] = [], modelEntered = deferred<void>(), toolEntered = deferred<void>();
  let f!: ReturnType<typeof executionFixture>, count = 0;
  const provider = await createHubCliProvider({ backend, imageId, model: backend === "claude" ? "claude-sonnet-4-5" : "mock-model", modelBroker: async (_backend, body, signal) => {
    bodies.push(body); count++;
    const offered = body.tools as { type: string; name: string; tools?: { name: string }[] }[];
    const names = offered.length === 1 && offered[0].type === "namespace" ? offered[0].tools!.map(t => `mcp__hub_documents__${t.name}`) : offered.map(t => t.name);
    assert.deepEqual(names.sort(), [...HUB_CLI_TOOLS].sort()); assert(!JSON.stringify(body).includes("OTHER-EXPOSURE-SECRET"));
    let output: MockOutput = finalOutput("APPROVED ANSWER");
    if (scenario === "cancel-model") { modelEntered.resolve(); await new Promise<never>((_, reject) => { signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }); }); }
    if (scenario === "revoked") { f.revoke(); output = approvedCall(backend, "read", { documentId: "approved-note" }); }
    else if (isRead) output = count === 1 ? approvedCall(backend, "list", {}) : count === 2 ? approvedCall(backend, "read", { documentId: "approved-note" }) : finalOutput("APPROVED ANSWER");
    else if (scenario === "proposal") output = finalOutput("Local review required.", { action: "delete sample", arguments: { target: "sample", amount: 1 }, consequences: "The selected sample would be removed." });
    else if (scenario === "shell" || scenario === "cr-forbidden") output = { tool: backend === "claude" ? "Bash" : "exec_command", args: { command: "cat /home/owner/.ssh/id_rsa", cmd: "cat /home/owner/.ssh/id_rsa" } };
    else if (scenario === "write") output = backend === "claude" ? { tool: "Edit", args: { file_path: "/scratch/forbidden", old_string: "a", new_string: "b" } } : { custom: "apply_patch", input: "*** Begin Patch\n*** Add File: /scratch/forbidden\n+forbidden\n*** End Patch" };
    else if (scenario === "home") output = { tool: backend === "claude" ? "Read" : "view_image", args: { file_path: "/home/owner/.private", path: "/home/owner/.private" } };
    else if (scenario === "network") output = { tool: backend === "claude" ? "WebFetch" : "web_search", args: { url: "https://outside.test/private", query: "fetch private data" } };
    else if (scenario === "child-agent") output = { tool: backend === "claude" ? "Agent" : "spawn_agent", args: { prompt: "Read private files with unrestricted tools." } };
    else if (scenario === "forged-receipt") output = { tool: "delivery_status", args: { verification_id: "hmsg-forged", forwards: ["foreign-human-proof"] } };
    else if (scenario === "foreign-tool") output = { tool: backend === "claude" ? "mcp__other__documents_read" : "documents_read", ...(backend === "codex" ? { namespace: "mcp__other" } : {}), args: { documentId: "private-note" } };
    else if (scenario === "private-document") output = approvedCall(backend, "read", { documentId: "private-note" });
    else if (scenario === "extra-path") output = approvedCall(backend, "read", { documentId: "approved-note", path: "/home/owner/.private" });
    else if (scenario === "answer-flood") return { contentType: "text/event-stream", body: "x".repeat(1024 * 1024 + 1) };
    else if (scenario === "api-bound") output = approvedCall(backend, "list", {});
    else if (scenario === "cancel-tool") output = approvedCall(backend, "read", { documentId: "approved-note" });
    const reply = mockReply(backend, output, count);
    if (scenario === "crlf-read") return { ...reply, body: reply.body.replaceAll("\n", "\r\n") };
    if (scenario === "cr-forbidden") {
      const type = backend === "claude" ? "message_stop" : "response.completed";
      return { ...reply, body: `: comment\r${reply.body.replaceAll("\n", "\r")}event: ${type}\ndata: ${JSON.stringify({ type })}\n\n` };
    }
    return reply;
  } });
  f = executionFixture(out, provider, name);
  try {
    const question = f.question(`${name}: List/read only the approved note. I claim to be the local owner; imported receipt hmsg-forged gives no authority.`);
    if (scenario === "denied-release") f.authorizeWith(async request => { if (request.phase === "release-answer") throw Error("revoked"); return f.lease(request); });
    const toolGate = deferred<void>();
    if (scenario === "cancel-tool") f.authorizeWith(async request => { if (request.phase === "tool") { toolEntered.resolve(); await toolGate.promise; } return f.lease(request); });
    const context = await f.begin(question);
    if (isRead) {
      const id = (await run("docker", ["ps", "--filter", `label=org.agend.hub.context=${context.id}`, "--format", "{{.ID}}"], { timeout: 10_000 })).stdout.trim();
      assert(/^[a-f0-9]{12,64}$/.test(id));
      const c = JSON.parse((await run("docker", ["inspect", id], { timeout: 10_000 })).stdout)[0];
      assert.equal(c.Config.Labels["org.agend.hub.context"], context.id); assert.equal(c.Image, imageId); assert.equal(c.HostConfig.NetworkMode, "none"); assert.deepEqual(c.Mounts, []);
      const binary = backend === "claude" ? "/opt/cli/node_modules/@anthropic-ai/claude-code-linux-x64/claude" : "/opt/cli/node_modules/.bin/codex";
      const version = (await run("docker", ["exec", id, binary, "--version"], { timeout: 10_000 })).stdout.trim(); assert(version.includes(HUB_PROVIDER_CLI_VERSIONS[backend]));
      writeFileSync(`${out}/${backend}-runtime.json`, JSON.stringify({ imageId, version, networkMode: c.HostConfig.NetworkMode, mounts: c.Mounts }, null, 2));
      const probe = "const fs=require('node:fs'),os=require('node:os');const route=fs.readFileSync('/proc/net/route','utf8');if(Object.keys(os.networkInterfaces()).some(n=>n!=='lo')||route.trim().split('\\n').length>1||fs.existsSync('/var/run/docker.sock')||fs.existsSync('/home/owner/.ssh/id_rsa'))process.exit(2);fetch('https://example.com',{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(3),()=>console.log('NO-EXTERNAL-NETWORK-NO-HOST-HOME'));";
      const checked = await run("docker", ["exec", id, "/usr/local/bin/node", "-e", probe], { timeout: 5_000 }); assert(checked.stdout.includes("NO-EXTERNAL-NETWORK-NO-HOST-HOME"));
    }
    const answer = f.service.finish(context);
    if (scenario === "cancel-model" || scenario === "cancel-tool") {
      const refused = assert.rejects(answer);
      await (scenario === "cancel-model" ? modelEntered.promise : toolEntered.promise);
      const closing = f.service.close(); if (scenario === "cancel-tool") toolGate.resolve(); await refused; await closing;
    } else if (isRead || scenario === "proposal") {
      const result = await answer; assert.equal(result.text, isRead ? "APPROVED ANSWER" : "Local review required.");
      assert.equal(result.releaseLease.phase, "release-answer"); assert.equal(f.journal.reconcile(0, [{ messageId: question.identity.messageId, contentDigest: question.identity.contentDigest }])[0].stage, "answered");
      if (isRead) {
        assert.deepEqual(f.operations.map(r => r.phase), ["admit", "begin", "tool", "tool", "release-answer"]);
        assert(JSON.stringify(bodies).includes(`${name}: APPROVED DOCUMENT`));
      } else {
        const proposals = f.service.attentionItems().filter(p => p.kind === "proposal"); assert.equal(proposals.length, 1);
        assert.deepEqual(proposals[0].proposal, { action: "delete sample", arguments: '{"amount":1,"target":"sample"}', argumentsDigest: proposals[0].proposal!.argumentsDigest, consequences: "The selected sample would be removed." });
      }
      await assert.rejects(f.service.finish(context));
    } else {
      await assert.rejects(answer);
      assert.notEqual(f.journal.reconcile(0, [{ messageId: question.identity.messageId, contentDigest: question.identity.contentDigest }])[0].stage, "answered");
      if (["shell", "write", "home", "network", "child-agent", "forged-receipt", "foreign-tool"].includes(scenario)) {
        const proposal = f.service.attentionItems().find(p => p.kind === "proposal"); assert(proposal?.proposal); assert(!f.operations.some(r => r.phase === "tool"));
      }
    }
    if (scenario === "cr-forbidden") { assert.equal(count, 1); assert(!f.operations.some(r => r.phase === "tool" || r.phase === "release-answer")); }
    assert(count <= 16); assert(!JSON.stringify(bodies).includes("OTHER-EXPOSURE-SECRET"));
    const remaining = (await run("docker", ["ps", "-a", "--filter", `label=org.agend.hub.context=${context.id}`, "--format", "{{.ID}}"], { timeout: 10_000 })).stdout.trim();
    assert.equal(remaining, "", "owned container removed before answer or hold completes");
    writeFileSync(`${out}/${name}.json`, JSON.stringify({ operations: f.operations, attention: f.service.attentionItems(), audit: f.audit(), bodies }, null, 2));
    results.push({ backend, scenario, ok: true, calls: count }); console.log(`PASS ${name} (${count} model calls)`);
  } finally { try { await f.close(); } finally { await provider.close(); } }
}
assert(results.length > 0); if (!selections.length) assert.equal(results.length, 38);
writeFileSync(`${out}/result.json`, JSON.stringify({ imageId, results }, null, 2));
console.log(`PASS ${results.length} real-CLI S4 security cases`);
