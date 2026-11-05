/** Disposable controller killed by crash.mts; never launched by a fleet. */
import { randomUUID } from "node:crypto";
import { createHubCliProvider } from "../../../src/hub/execution/cli-provider.js";
import type { HubCliBackend } from "../../../src/hub/execution/model-broker.js";
const backend = process.argv[2] as HubCliBackend, imageId = process.argv[3], contextId = randomUUID();
const provider = await createHubCliProvider({ backend, imageId, model: backend === "claude" ? "claude-sonnet-4-5" : "mock-model", modelBroker: async () => { throw Error("No model traffic before answer gateway"); } });
await provider.open({ contextId, question: "Synthetic controller crash probe", label: "External data; no local authority", signal: new AbortController().signal, beforeInput() {} });
process.stdout.write(JSON.stringify({ contextId }) + "\n");
