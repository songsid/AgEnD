/** Read-only real Docker setup checks. No containers, questions, CLI sessions or model requests.
 * IMAGE_ID=sha256:<reviewed local image> OUT=<artifacts> npx tsx scripts/manual/hub-provider/setup-preflight.mts
 * An unavailable/unsupported engine is a failed positive control, never a platform qualification.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHubCliProvider } from "../../../src/hub/execution/cli-provider.js";
import { createHubModelBroker } from "../../../src/hub/execution/model-broker.js";
import { hubProviderSetupReason } from "../../../src/hub/execution/provider-setup.js";
const imageId = process.env.IMAGE_ID!, out = process.env.OUT!;
assert(/^sha256:[a-f0-9]{64}$/.test(imageId) && out); mkdirSync(out, { recursive: true });
let modelCalls = 0;
const modelBroker = async () => { modelCalls++; throw Error("No model call is allowed in setup acceptance"); };
const rows: unknown[] = [];
for (const backend of ["claude", "codex"] as const) {
  const options = { backend, imageId, model: "inert-local-model", modelBroker };
  const provider = await createHubCliProvider(options);
  assert.equal(provider.isolation, "hub-restricted-v1"); await provider.close();
  rows.push({ backend, case: "reviewed-image-positive", ok: true });
  for (const [name, changes, reason] of [
    ["missing-socket", { dockerSocket: "/run/agend-hub-guidance-missing.sock" }, "engine-unavailable"],
    ["unselected-image", { imageId: "" }, "image-unconfigured"],
    ["missing-or-different-image", { imageId: "sha256:" + "b".repeat(64) }, "image-mismatch"],
  ] as const) {
    const failure = await createHubCliProvider({ ...options, ...changes }).then(p => { void p.close(); throw Error("unexpected provider"); }, e => e);
    assert.equal(hubProviderSetupReason(failure), reason); rows.push({ backend, case: name, reason, ok: true });
  }
  let failure: unknown; try { createHubModelBroker({ [backend]: "" }); } catch (e) { failure = e; }
  assert.equal(hubProviderSetupReason(failure), "credential-unconfigured");
  rows.push({ backend, case: "unconfigured-credential", reason: "credential-unconfigured", ok: true });
}
assert.equal(modelCalls, 0);
writeFileSync(join(out, "setup-preflight.json"), JSON.stringify({ imageId, rows, modelCalls, limits: "Read-only Docker factory preflight only; unsupported engine is covered by inert tests. No new platform, CLI, subscription or API-account qualification." }, null, 2));
console.log(`PASS ${rows.length} real setup preflight cases; no model calls or question containers`);
