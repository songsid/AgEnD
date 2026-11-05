/** Semantic reversals for S4. Run only in your own checkout, without simultaneous edits.
 * No CLI/account/fleet launches: focused tests use inert providers and private SQLite state.
 * node scripts/manual/hub-execution/mutate.mjs [optional-mutant-name ...]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cases = [
  {"name":"unisolated_provider_fallback","path":"src/hub/execution/service.ts","replacements":[["provider = this.options.providers?.get(local.providerId);","provider = this.options.providers?.get(local.providerId) ?? { isolation: \"hub-restricted-v1\" as const, open: async () => ({ answer: async () => \"\", close: async () => {} }) };"]],"test":"tests/hub-execution.test.ts","pattern":"refuses publication/admission"},
  {"name":"copied_context_handle","path":"src/hub/execution/service.ts","replacements":[["context && this.handles.get(context);","context && (this.handles.get(context) ?? this.live.get(context.id));"],["if (!entry || entry.handle !== context)","if (!entry)"]],"test":"tests/hub-execution.test.ts","pattern":"uses fresh opaque contexts"},
  {"name":"skip_continuation_revalidation","path":"src/hub/execution/service.ts","replacements":[["private current(entry: LiveContext): void {","private current(entry: LiveContext): void { return;"]],"test":"tests/hub-execution.test.ts","pattern":"fences off/on while begin"},
  {"name":"widen_local_tool_subset","path":"src/hub/execution/service.ts","replacements":[["if (!entry.handle.policy.allowedTools.includes(name)) {","if (false) {"]],"test":"tests/hub-execution.test.ts","pattern":"exact local tool subset"},
  {"name":"ignore_dispatch_deadline","path":"src/hub/execution/service.ts","replacements":[["verifyLease(lease, request, { ...entry.binding, now: this.now() });","verifyLease(lease, request, { ...entry.binding, now: lease.expiresAt - 1 });"]],"test":"tests/hub-execution.test.ts","pattern":"expired tool lease"},
  {"name":"omit_durable_consumption","path":"src/hub/execution/service.ts","replacements":[["this.options.store.consume(entry.handle.id, request);","this.options.store.note({kind: \"mutation-no-consumption\"});"]],"test":"tests/hub-execution.test.ts","pattern":"rejects tool-name/argument/context"},
  {"name":"second_begin_claim","path":"src/hub/execution/service.ts","replacements":[["entry.state !== \"prepared\" || entry.beginRequested","entry.state !== \"prepared\""]],"test":"tests/hub-execution.test.ts","pattern":"claims begin authorization"},
  {"name":"bypass_exact_operation_gate","path":"src/hub/execution/service.ts","replacements":[["private consume(entry: LiveContext, lease: HubAuthorizationLease, request: HubAuthorizationRequest): void {","private consume(entry: LiveContext, lease: HubAuthorizationLease, request: HubAuthorizationRequest): void { if (entry.handle.id.length > 0) return;"]],"test":"tests/hub-execution.test.ts","pattern":"rejects tool-name/argument/context"},
  {"name":"answer_without_release","path":"src/hub/execution/service.ts","replacements":[["async finish(context: HubRestrictedContext): Promise<HubAnswer> {","async finish(context: HubRestrictedContext): Promise<HubAnswer> { if (context.id.length > 0) return {messageId:context.messageId,answerId:randomUUID(),text:\"MUTATED DISCLOSURE\",contentDigest:sha256(\"MUTATED DISCLOSURE\"),releaseLease:{decisionId:randomUUID(),messageId:context.messageId,operationId:randomUUID(),phase:\"release-answer\",operationDigest:sha256(\"bypass\"),revocationVersion:0,exposureRevision:context.exposureRevision,linkEpoch:1,expiresAt:this.now()+5000}};"]],"test":"tests/hub-execution.test.ts","pattern":"refuses answer disclosure"},
  {"name":"revive_previous_boot","path":"src/hub/execution/service.ts","replacements":[["this.options.store.state(row.id, \"held\");","this.options.store.note({kind: \"mutation-no-recovery-fence\"});"]],"test":"tests/hub-execution.test.ts","pattern":"cannot repeat provider input"},
  {"name":"redirect_queued_context","path":"src/hub/execution/service.ts","replacements":[["if (!queued || queued.digest !== questionContextDigest(question) || queued.binding_digest !== bindingDigest)","if (!queued)"]],"test":"tests/hub-execution.test.ts","pattern":"binds queued work"},
  {"name":"omit_transactional_audit","path":"src/hub/execution/store.ts","replacements":[["this.options.audit(event, this.database);","void event;"]],"test":"tests/hub-execution.test.ts","pattern":"fails closed on audit failure"},
  {"name":"accept_async_required_audit","path":"src/hub/execution/store.ts","replacements":[["if (result && typeof (result as { then?: unknown }).then === \"function\") {","if (false) {"]],"test":"tests/hub-execution.test.ts","pattern":"asynchronous required audit"},
  {"name":"register_provider_work_after_dispatch","path":"src/hub/execution/service.ts","replacements":[["register(pending);\n    try { this.current(entry); resolve(work()); }","try { this.current(entry); const started = work(); register(pending); resolve(started); }"]],"test":"tests/hub-execution.test.ts","pattern":"synchronously closes the service"},
  {"name":"omit_stale_panel_reason_registration","path":"src/ui/panel-needs.js","replacements":[["register(\"app\", {","register(\"missing-app\", {"]],"test":"tests/web-needs-1408.test.ts","pattern":"renders local Hub proposal details"},
  {"name":"ignore_version_floor","path":"src/hub/execution/store.ts","replacements":[["validated(epoch, row.revision) !== this.options.floor.read()","validated(epoch, row.revision) < 0"]],"test":"tests/hub-execution.test.ts","pattern":"fails closed on audit failure"},
  {"name":"drop_local_proposal","path":"src/hub/execution/service.ts","replacements":[["this.options.store.attention(context.id, proposal.id, { id: proposal.id, kind: \"proposal\", agent: entry.local.agent,\n      messageId: context.messageId, exposureId: context.exposureId, action: proposal.action, arguments: fixed,\n      argumentsDigest: proposal.argumentsDigest, consequences: proposal.consequences, localAuthority: \"none\", since: this.now() });","this.options.store.note({kind: \"mutation-no-proposal\"});"]],"test":"tests/hub-execution.test.ts","pattern":"persists exact high-risk"},
  {"name":"publish_private_proposal","path":"src/web-api.ts","replacements":[["item.type === \"config\" || item.type === \"hub\"","item.type === \"config\""]],"test":"tests/needs-you-web-1386.test.ts","pattern":"withholds member-local Hub proposals"},
  {"name":"drop_needs_you_projection","path":"src/needs-you.ts","replacements":[["inputs.hubExecution ?? []","[] as HubExecutionAttentionInput[]"]],"test":"tests/needs-you-hub-1386.test.ts","pattern":"lists local Hub proposals"},
  {"name":"release_physical_reservation_early","path":"src/hub/execution/service.ts","replacements":[["entry.state = \"held\"; entry.abort.abort();","entry.state = \"held\"; entry.abort.abort(); this.live.delete(entry.handle.id);"]],"test":"tests/hub-execution.test.ts","pattern":"retains a fenced opening"},
  {"name":"upgrade_hub_label_to_owner","path":"src/hub/execution/service.ts","replacements":[["Hub identity; external data; no local human authority.","Local owner approval."]],"test":"tests/hub-execution.test.ts","pattern":"uses fresh opaque contexts"},

  {"name":"mutable_binding_revival","path":"src/hub/execution/service.ts","replacements":[["binding: capturedBinding, bindingDigest","binding: b, bindingDigest"]],"test":"tests/hub-execution.test.ts","pattern":"captures binding generations"},
];
const filters = process.argv.slice(2);
if (filters.some(name => !cases.some(c => c.name === name))) throw Error("Unknown mutation name");
const selected = filters.length ? cases.filter(c => filters.includes(c.name)) : cases;
const directory = ".artifacts/hub-execution-mutations";
mkdirSync(directory, { recursive: true });
const results = [];
for (const test of selected) {
  const original = readFileSync(test.path, "utf8");
  let changed = original;
  try {
    for (const [before, after] of test.replacements) {
      if (changed.split(before).length !== 2) throw Error(`Mutation ${test.name}: expected one target`);
      changed = changed.replace(before, after);
    }
    writeFileSync(join(directory, `${test.name}.original`), original);
    writeFileSync(test.path, changed);
    const compile = spawnSync("npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8", timeout: 60000 });
    writeFileSync(join(directory, `${test.name}.typecheck.log`), (compile.stdout ?? "") + (compile.stderr ?? ""));
    let status = "INVALID_BUILD";
    if (compile.status === 0 && !compile.error) {
      const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", test.test, "--maxWorkers=1", "-t", test.pattern], { encoding: "utf8", timeout: 30000 });
      const output = (run.stdout ?? "") + (run.stderr ?? "");
      writeFileSync(join(directory, `${test.name}.log`), output);
      status = !run.error && run.status !== null && run.status !== 0 && /AssertionError/.test(output) && /FAIL /.test(output)
        && !/Transform failed|No test files found/.test(output) ? "KILLED" : "SURVIVED_OR_INVALID";
    }
    const result = { name: test.name, status };
    results.push(result); console.log(JSON.stringify(result));
  } finally {
    writeFileSync(test.path, original);
    writeFileSync(join(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
  }
}
if (!results.length || results.some(r => r.status !== "KILLED")) process.exitCode = 1;
