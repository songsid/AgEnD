/**
 * alpha.3 (the user's button, hmsg-7c8fd0e5: "web-only also defaults to general"; leader xmsg-1793779851894): a
 * web-only setup's first agent is the fleet's General, as on the chat platforms — and a web-only `general` is never
 * half a General.
 *  - becomesGeneral / draftWebOnly: with no directory of the user's, the first agent is written ticked
 *    (general_topic: true, no topic); with a directory of the user's it is a worker, and the name `general` is refused
 *    there (#2744: the General never works in a project of the user's); a fleet that has a General: no;
 *  - the by-name rules (isGeneralInstance — the pause guard and the fleet's "is this a General" —, resolveToolSet, the
 *    daemon's and #3021's one-General count): `general` is the General unless unticked (general_topic: false), so the
 *    owner can untick it and tick another in Settings without leaving it half a General;
 *  - the CLI quickstart's web-only fleet: a `general` in its own workspace is ticked, one in a folder of the user's is
 *    written unticked.
 */
import { describe, expect, it } from "vitest";
import { agentConflict, becomesGeneral, draftWebOnly, defaultWorkingDirectory } from "../src/quickstart-api.js";
import { isGeneralInstance, generalByName } from "../src/general-instance.js";
import { resolveToolSet } from "../src/tool-permissions.js";
import { addsSecondGeneral, generalNames } from "../src/web-only-fleet.js";
import { newWebOnlyFleet } from "../src/quickstart.js";
import type { FleetConfig } from "../src/types.js";

const fleet = (instances: Record<string, unknown> = {}): FleetConfig => ({ defaults: {}, instances } as unknown as FleetConfig);

describe("alpha.3: the web-only setup's first agent is the General", () => {
  it("no directory of the user's → ticked (any name, as on a chat); a directory of the user's → a worker; a General already → no", () => {
    for (const name of ["general", "helper"]) {
      const d = draftWebOnly(fleet(), { instance_name: name, backend: "claude-code", working_directory: defaultWorkingDirectory(name) });
      expect(d.instances[name]).toMatchObject({ general_topic: true });
      expect((d.instances[name] as { topic_id?: unknown }).topic_id).toBeUndefined();
    }
    const worker = draftWebOnly(fleet(), { instance_name: "agent-1", backend: "claude-code", working_directory: "/home/you/projects/app" });
    expect(worker.instances["agent-1"]).not.toHaveProperty("general_topic");
    const second = draftWebOnly(fleet({ boss: { working_directory: "/w/b", general_topic: true } }), { instance_name: "helper", backend: "claude-code", working_directory: defaultWorkingDirectory("helper") });
    expect(second.instances.helper).not.toHaveProperty("general_topic");
    expect(becomesGeneral(fleet(), { web_only: true })).toBe(true);
  });
  it("the name general where it would not be the General is refused, web only as on a chat", () => {
    expect(agentConflict({ instance_name: "general", web_only: true, working_directory: "/home/you/projects/app" }, fleet())).toMatch(/works in its own folder/);
    expect(agentConflict({ instance_name: "general", web_only: true }, fleet({ boss: { working_directory: "/w/b", general_topic: true } }))).toMatch(/kept for the fleet's General/);
    expect(agentConflict({ instance_name: "general", web_only: true }, fleet())).toBeNull();
  });
});

describe("alpha.3: `general` is the General unless unticked — never half a General", () => {
  it("the pause guard / the fleet's rule, the tool profile and the daemon's rule agree", () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [[{}, true], [{ general_topic: true }, true], [{ general_topic: false }, false]];
    for (const [inst, want] of cases) {
      expect(isGeneralInstance(fleet({ general: inst }), "general"), JSON.stringify(inst)).toBe(want);
      expect(generalByName("general", inst as never)).toBe(want);
      expect(resolveToolSet(inst as never, "general") === "general").toBe(want);
    }
    expect(isGeneralInstance(fleet({ boss: { general_topic: true } }), "boss")).toBe(true);
    expect(resolveToolSet({ general_topic: false, tool_set: "full" } as never, "general")).toBe("full");
  });
  it("#3021's one-General count includes a `general` not unticked: ticking another is refused until it is unticked", () => {
    const named = fleet({ general: { working_directory: "/w/g" }, builder: { working_directory: "/w/b" } });
    expect(generalNames(named as never)).toEqual(["general"]);
    expect(addsSecondGeneral(named as never, { general_topic: true })).toBe(true);
    const unticked = fleet({ general: { working_directory: "/w/g", general_topic: false }, builder: { working_directory: "/w/b" } });
    expect(generalNames(unticked as never)).toEqual([]);
    expect(addsSecondGeneral(unticked as never, { general_topic: true })).toBe(false);
  });
  it("the CLI quickstart's web-only fleet: `general` in its own workspace ticked, in a folder of the user's unticked; another name as before", () => {
    expect(newWebOnlyFleet([], "claude-code", { name: "general", workingDirectory: "/w/general", ownWorkspace: true }).instances.general.general_topic).toBe(true);
    expect(newWebOnlyFleet([], "claude-code", { name: "general", workingDirectory: "/home/you/app", ownWorkspace: false }).instances.general.general_topic).toBe(false);
    expect(newWebOnlyFleet([], "claude-code", { name: "agent-1", workingDirectory: "/w/agent-1", ownWorkspace: true }).instances["agent-1"]).not.toHaveProperty("general_topic");
  });
});
