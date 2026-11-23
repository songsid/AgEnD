import { describe, expect, it } from "vitest";
import { loadFleetConfigSource } from "../src/config.js";

const load = (backend = "claude-code") => loadFleetConfigSource(`
defaults: {backend: ${backend}, model: shared-model}
instances:
  follows: {working_directory: /tmp}
  claude: {working_directory: /tmp, backend: claude-code}
  codex: {working_directory: /tmp, backend: codex}
  grok: {working_directory: /tmp, backend: grok}
  muse: {working_directory: /tmp, backend: muse}
  own: {working_directory: /tmp, backend: muse, model: own-model}
  inherit: {working_directory: /tmp, model: null}
`);

describe("backend-scoped shared model", () => {
  it("only passes the shared model to the matching backend; explicit models still win", () => {
    const { instances: a } = load();
    expect(a.follows.model).toBe("shared-model");
    expect(a.claude.model).toBe("shared-model");
    expect([a.codex.model, a.grok.model, a.muse.model]).toEqual([undefined, undefined, undefined]);
    expect(a.own.model).toBe("own-model");
  });
  it("re-evaluates inheritance on backend changes and treats null as following", () => {
    const { instances: a } = load("codex");
    expect(a.follows.backend).toBe("codex");
    expect(a.follows.model).toBe("shared-model");
    expect(a.codex.model).toBe("shared-model");
    expect(a.claude.model).toBeUndefined();
    expect(a.inherit.model).toBe("shared-model");
  });
});

// The public resolver must not put a scoped-out fleet model back after loading.
import { FleetManager } from "../src/fleet-manager.js";
it("reports CLI default for nonmatching backends rather than reintroducing the fleet model", () => {
  const fm = new FleetManager("/tmp");
  fm.fleetConfig = load();
  expect(fm.resolveInstanceModel("grok").source).not.toBe("fleet-default");
  expect(fm.resolveInstanceModel("grok").model).not.toBe("shared-model");
});

it("preserves the Windows CLI-default sentinel without inheriting the host model", () => {
  const config = loadFleetConfigSource(JSON.stringify({ defaults: { backend: "claude-code", model: "host-model" }, instances: {
    empty: { runtime: "windows", working_directory: "W:/Example", model: "" },
    unset: { runtime: "windows", working_directory: "W:/Example" },
    own: { runtime: "windows", working_directory: "W:/Example", model: "native-model" },
  } }));
  expect(config.instances.empty.model).toBe("");
  expect(config.instances.unset.model).toBe("");
  expect(config.instances.own.model).toBe("native-model");
});
