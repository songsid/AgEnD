import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { codexE2eConfig } from "./helpers/codex-e2e-profile.js";

describe("isolated Codex e2e profile", () => {
  it("keeps the quoted status setting at the root and uses only the loopback provider", () => {
    const config = parse(codexE2eConfig('"tui"."status_line" = ["model-with-reasoning"]', {
      AGEND_CODEX_E2E_MOCK_PORT: "18778", AGEND_CODEX_E2E_AUTH: "/audit/inert-auth.json",
    })) as any;
    expect(config.tui.status_line).toEqual(["model-with-reasoning"]);
    expect(config.model_providers.mock).toMatchObject({ base_url: "http://127.0.0.1:18778/v1", requires_openai_auth: false });
  });
  it("does not fall back to the operator's login in mock mode", () => {
    expect(() => codexE2eConfig("", { AGEND_CODEX_E2E_MOCK_PORT: "18778" })).toThrow("explicit inert auth");
  });
  it.each(["0", "65536", "example.test", "18778\nmodel_provider=\"openai\""])("refuses invalid mock port %s", port => {
    expect(() => codexE2eConfig("", { AGEND_CODEX_E2E_MOCK_PORT: port, AGEND_CODEX_E2E_AUTH: "/audit/inert-auth.json" })).toThrow("mock port");
  });
});
