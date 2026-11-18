import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The opt-in real-CLI suite may use a loopback mock without borrowing the operator's login. */
export function codexE2eConfig(extra = "", env: NodeJS.ProcessEnv = process.env): string {
  const port = env.AGEND_CODEX_E2E_MOCK_PORT;
  if (port === undefined) return extra;
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("Invalid mock port");
  if (!env.AGEND_CODEX_E2E_AUTH) throw new Error("Mock e2e requires an explicit inert auth file");
  return [
    'model = "mock-model"', 'model_provider = "mock"', extra,
    '[model_providers.mock]', 'name = "mock"', `base_url = "http://127.0.0.1:${Number(port)}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', "",
  ].join("\n");
}

/** A short owned parent keeps the real app-server socket below SUN_LEN during isolated audits. */
export function codexE2eRoot(label: string): string {
  const parent = process.env.AGEND_CODEX_E2E_ROOT;
  return mkdtempSync(join(parent ?? tmpdir(), parent ? `ce-${label}-` : `agend-codex-e2e-${label}-`));
}
