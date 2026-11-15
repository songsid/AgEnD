/** Both production editors and shared picker on an inert client; no browser/network claim. */
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
let editors: any, steps: any, rows: any, clients: any, picker: any;
const mounted: AppPage[] = [];
const person = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" }, teamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const policy = () => ({ realm: "example", generation: "gen-1", revision: 1, state: "enabled", groups: [], denies: [{ person, deny: ["publish_agents"] }],
 teams: [{ teamId, name: "Product team", allow: ["ask_agents", "pair_fleet"], maxFleets: 4 }], people: [{ person, name: "Riley", allow: ["ask_agents"], maxFleets: 0 }] });
beforeAll(async () => {
 const p = page({ storage: { agend_lang: "en", agend_tour_done: "1" } });
 clients = await import("/ui/js/hub-client.js"); editors = await import("/ui/js/hub-group-policy.js"); steps = await import("/ui/js/hub-join-steps.js"); rows = await import("/ui/js/hub-policy-subjects.js"); picker = await import("/ui/js/hub-subject-picker.js"); p.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } clients.setHubClient(null); });
const until = async (f: () => unknown) => { for (let n = 0; n < 120 && !f(); n++) await settle(10); };
function fake() {
 const preview = vi.fn(async (_draft: unknown) => ({ ok: true, previewDigest: "d".repeat(64), impact: { teamMembers: 2, losingActions: [], losingPublication: [], suspendedOnSave: [], grandfathered: [], held: [], adminLosesChat: false } }));
 return { web: true, groupPolicyV1: true, onSignedOut: () => () => {}, groupPolicy: async () => ({ ok: true, supported: true, binding: "ready", policy: policy(), paused: [] }), previewGroupPolicy: preview,
 saveGroupPolicy: vi.fn(async () => ({ ok: true })), teamsLive: () => true, teams: async () => ({ ok: true, teams: [{ id: teamId, name: "Product team", memberCount: 2, leads: ["example/lead"], leadNames: ["Alex"] }] }),
 searchAllowedPeople: async () => ({ ok: true, people: [{ person, displayName: "Riley", login: "riley" }], truncated: false }), resolveGroup: async () => ({ ok: false }), searchGroups: async () => ({ ok: true, groups: [], truncated: false }) };
}
it("round-trips teams and people through both editor serializers without display metadata", () => {
 const p = policy(), all = rows.policyRows(p);
 expect(editors.draftPolicy(p, p.state, all)).toEqual(p); expect(steps.proposedPolicy(p, all)).toEqual(p);
 expect(steps.step2Done(p, [])).toBe(true);
});
it.each(["full", "manage"])("%s editor shows and preserves every selected subject and the server's team count", async which => {
 const c = fake(); clients.setHubClient(c); const p = page({ storage: { agend_lang: "en", agend_tour_done: "1" } }); mounted.push(p);
 await p.mount(h(which === "full" ? editors.HubGroupPolicyPage : steps.JoinStep2, { client: c })); await settle(40);
 expect(p.document.body.textContent).toContain("Product team"); expect(p.document.body.textContent).toContain("Riley"); expect(p.document.body.textContent).toContain("Alex");
 const number = p.document.querySelector('input[type="number"]') as any; expect(number).toBeTruthy(); number.value = "6"; fire(number, "input");
 await until(() => c.previewGroupPolicy.mock.calls.length > 0);
 const draft = c.previewGroupPolicy.mock.calls.at(-1)?.[0]; expect(draft).toMatchObject({ groups: [], teams: [{ teamId, maxFleets: 6 }], people: [{ person, name: "Riley" }], denies: policy().denies });
 expect(p.document.body.textContent).toContain("Team members checked: 2");
});
it("uses one picker for a team summary without exposing or requiring its roster", async () => {
 const c = fake(), picked = vi.fn(), p = page({ storage: { agend_lang: "en" } }); mounted.push(p);
 await p.mount(h(picker.SubjectPicker, { client: c, onPick: picked }));
 const kind = p.document.querySelector("select[data-subject-kind]") as any; kind.value = "team"; fire(kind, "change");
 await until(() => !!p.document.querySelector("select[data-grant-team]"));
 const team = p.document.querySelector("select[data-grant-team]") as any; team.value = teamId; fire(team, "change");
 expect(picked).toHaveBeenCalledWith("team", expect.objectContaining({ memberCount: 2, leadNames: ["Alex"] }));
});
