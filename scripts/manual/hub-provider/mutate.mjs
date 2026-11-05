/** Compiling security reversals. Own checkout only; no simultaneous source edits or tests. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const cases = [
  {
    "name": "network_none",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "h.NetworkMode !== \"none\"",
        "false"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "weaker actual NetworkMode"
  },
  {
    "name": "read_only_root",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "h.ReadonlyRootfs !== true",
        "false"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "weaker actual ReadonlyRootfs"
  },
  {
    "name": "drop_capabilities",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "!caps.includes(\"ALL\")",
        "false"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "weaker actual CapDrop"
  },
  {
    "name": "refuse_host_mount",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "(Array.isArray(h.Binds) && h.Binds.length)",
        "false"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "weaker actual Binds"
  },
  {
    "name": "fixed_broker_destination",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "\"https://api.openai.com/v1/responses\"",
        "\"https://outside.test/v1/responses\""
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "fixed HTTPS API endpoints"
  },
  {
    "name": "no_redirects",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "redirect: \"error\"",
        "redirect: \"follow\""
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "fixed HTTPS API endpoints"
  },
  {
    "name": "only_two_tools",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "const wireTools = nested ? [{ type: \"namespace\", name: \"mcp__hub_documents\", description: \"Owner-approved document reads.\", tools: safeTools }] : safeTools;",
        "const wireTools = tools;"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "rebuilds"
  },
  {
    "name": "whole_reply_gate",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "if (Buffer.byteLength(reply.body) > MODEL_WIRE_LIMIT)",
        "if (reply.body.length >= 0) return reply; if (Buffer.byteLength(reply.body) > MODEL_WIRE_LIMIT)"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "forced Codex"
  },
  {
    "name": "complete_stream",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "if (!completed) throw new HubProtocolError(\"uncertain\");",
        "if (false) throw new HubProtocolError(\"uncertain\");"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "complete bounded"
  },
  {
    "name": "no_media_fetch",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "if (typeof o.type === \"string\" && !historyTypes.has(o.type))",
        "if (false)"
      ]
    ],
    "test": "tests/hub-cli-broker.test.ts",
    "pattern": "media fetch input"
  },
  {
    "name": "strict_document_arguments",
    "path": "src/hub/execution/model-broker.ts",
    "replacements": [
      [
        "z.strictObject({ documentId:",
        "z.object({ documentId:"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "extra-path"
  },
  {
    "name": "before_input_guard",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "input.beforeInput();",
        "void input.beforeInput;"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "checks current authority"
  },
  {
    "name": "exact_input_receipt",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "if (!includesPrompt(backend === \"claude\" ? request.messages : request.input, prompt))",
        "if (false)"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "wrong-question"
  },
  {
    "name": "cleanup_before_answer",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "await close(); return text;",
        "return text;"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "exact CLI consumption"
  },
  {
    "name": "successful_native_exit",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "if (await exit !== 0)",
        "if ((await exit) === 999)"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "exits unsuccessfully"
  },
  {
    "name": "wall_deadline",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "setTimeout(onAbort, 120_000)",
        "setTimeout(onAbort, 1_200_000)"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "silent startup"
  },
  {
    "name": "physical_limit",
    "path": "src/hub/execution/cli-provider.ts",
    "replacements": [
      [
        "active >= 8",
        "active >= 9"
      ]
    ],
    "test": "tests/hub-cli-provider.test.ts",
    "pattern": "ninth overlapping"
  },
  {
    "name": "fresh_input_lease",
    "path": "src/hub/execution/service.ts",
    "replacements": [
      [
        "this.current(entry); verifyLease(lease, request, { ...entry.binding, now: this.now() }); checkedInput = true;",
        "this.current(entry); checkedInput = true;"
      ]
    ],
    "test": "tests/hub-execution.test.ts",
    "pattern": "expired-before-input"
  },
  {
    "name": "one_use_input_guard",
    "path": "src/hub/execution/service.ts",
    "replacements": [
      [
        "if (checkedInput) throw new HubProtocolError(\"uncertain\");",
        "if (false) throw new HubProtocolError(\"uncertain\");"
      ]
    ],
    "test": "tests/hub-execution.test.ts",
    "pattern": "reused-check"
  },
  {
    "name": "mandatory_input_guard",
    "path": "src/hub/execution/service.ts",
    "replacements": [
      [
        "if (!checkedInput) throw new HubProtocolError(\"uncertain\");",
        "if (false) throw new HubProtocolError(\"uncertain\");"
      ]
    ],
    "test": "tests/hub-execution.test.ts",
    "pattern": "missing-check"
  }
];
cases.push({name:"drain_failed_cleanup",path:"src/hub/execution/cli-provider.ts",replacements:[["await Promise.allSettled([...work]);","void work;"]],test:"tests/hub-cli-provider.test.ts",pattern:"physical broker work through a failed"});
cases.push({name:"lone_cr_sse_bypass",path:"src/hub/execution/model-broker.ts",replacements:[["if (/\\r(?!\\n)/.test(reply.body)) throw new HubProtocolError(\"invalid\");","void reply;"]],test:"tests/hub-cli-broker.test.ts",pattern:"lone CR and mixed CR"});
cases.push({name:"drop_failed_cleanup_owner",path:"src/hub/execution/cli-provider.ts",replacements:[["if (!failed) { active--; sessions.delete(close); }","active--; sessions.delete(close);"]],test:"tests/hub-cli-provider.test.ts",pattern:"retains failed cleanup ownership"});
cases.push({name:"cache_failed_cleanup_forever",path:"src/hub/execution/cli-provider.ts",replacements:[["error => { closed = undefined; reject(error); }","error => { reject(error); }"]],test:"tests/hub-cli-provider.test.ts",pattern:"retains failed cleanup ownership"});
cases.push({"name": "setup_engine_boundary", "path": "src/hub/execution/cli-provider.ts", "replacements": [["if (!/^linux\\/(?:amd64|x86_64)$/.test(engine))", "if (false)"]], "test": "tests/hub-cli-provider.test.ts", "pattern": "engine safely"});
cases.push({"name": "setup_image_reason", "path": "src/hub/execution/cli-provider.ts", "replacements": [["catch { throw new HubProviderSetupError(\"image-mismatch\"); }", "catch { throw new HubProtocolError(\"incompatible\"); }"]], "test": "tests/hub-cli-provider.test.ts", "pattern": "missing image safely"});
cases.push({"name": "setup_credential_check", "path": "src/hub/execution/model-broker.ts", "replacements": [["if (!Object.values(keys).some(key => typeof key === \"string\" && key.trim())\n    || Object.values(keys).some(key => typeof key !== \"string\" || !key.trim() || /[\\r\\n]/.test(key)))", "if (false)"]], "test": "tests/hub-cli-broker.test.ts", "pattern": "before a network request"});
cases.push({"name": "setup_bounded_diagnostic", "path": "src/hub/execution/service.ts", "replacements": [["isHubProviderSetupReason(reason) ? reason : undefined", "typeof reason === \"string\" ? reason as HubProviderSetupReason : undefined"]], "test": "tests/hub-execution.test.ts", "pattern": "setup diagnostics bounded"});
cases.push({"name": "setup_unpublished_projection", "path": "src/hub/member/exposure-api.ts", "replacements": [["const enforceable = !providerReason && !!a.providerId", "const enforceable = !!a.providerId"]], "test": "tests/hub-exposure-api-s3c.test.ts", "pattern": "before a first publish"});
cases.push({"name": "setup_ui_reason_allowlist", "path": "src/ui/hub-provider-guidance.js", "replacements": [["keys.get(reason) ?? null", "keys.get(reason) ?? reason"]], "test": "tests/hub-ui-s3.test.ts", "pattern": "actionable fixed provider guidance"});
const filters = process.argv.slice(2);
if (filters.some(name => !cases.some(c => c.name === name))) throw Error("Unknown mutation name");
const selected = filters.length ? cases.filter(c => filters.includes(c.name)) : cases;
const directory = ".artifacts/hub-provider-mutations";
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
