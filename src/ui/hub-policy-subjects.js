/** Shared serialization for both allowed-list editors. Extra team display fields never enter authority. */
import { html, useEffect, useState } from "/assets/app-html.js";
import { subjectText } from "./hub-subject-picker.js";
const CAPS = ["ask_agents", "publish_agents", "pair_fleet"];
export const subjectKind = row => row.kind || (row.teamId ? "team" : row.person ? "person" : "group");
export const subjectId = row => subjectKind(row) === "team" ? row.teamId : (row.person || row.group).objectId;
export const subjectKey = row => `${subjectKind(row)}/${subjectId(row)}`;
export function policyRows(policy) {
 return [...policy.groups.map(row => ({ ...row, kind: "group", allow: [...row.allow] })), ...(policy.teams || []).map(row => ({ ...row, kind: "team", allow: [...row.allow] })), ...(policy.people || []).map(row => ({ ...row, kind: "person", allow: [...row.allow] }))];
}
export function draftPolicySubjects(base, state, rows) {
 const fields = row => ({ allow: CAPS.filter(cap => row.allow.includes(cap)), maxFleets: row.maxFleets });
 const groups = rows.filter(row => subjectKind(row) === "group").map(row => ({ group: { ...row.group }, dn: row.dn, ...fields(row) }));
 const teams = rows.filter(row => subjectKind(row) === "team").map(row => ({ teamId: row.teamId, name: row.name, ...fields(row) }));
 const people = rows.filter(row => subjectKind(row) === "person").map(row => ({ person: { ...row.person }, name: row.name, ...fields(row) }));
 return { ...base, state, groups, ...(teams.length || base.teams !== undefined ? { teams } : {}), ...(people.length || base.people !== undefined ? { people } : {}) };
}
export function pickedPolicyRow(kind, value, allow) {
 return { kind, ...(kind === "team" ? { teamId: value.id, name: value.name, memberCount: value.memberCount ?? value.members?.length ?? value.people, leadNames: value.leadNames || [value.leadName].filter(Boolean) }
  : kind === "person" ? { person: { ...value.person }, name: value.displayName || value.login } : { group: { realm: value.realm, objectId: value.objectId }, dn: value.dn }), allow: [...allow], maxFleets: 1 };
}
export function useAllowedTeams(client) {
 const [teams, setTeams] = useState([]);
 useEffect(() => { let live = true; if (typeof client.teams === "function") Promise.resolve().then(() => client.teams()).then(r => { if (live && r.ok) setTeams(r.teams || []); }, () => {}); return () => { live = false; }; }, [client]);
 return teams;
}
export function PolicySubjectLabel({ row, teams = [] }) {
 const kind = subjectKind(row);
 if (kind === "group") return html`<code class="hub-group-dn">${row.dn}</code>`;
 if (kind === "person") return html`<strong>${subjectText("personRow", row.name)}</strong>`;
 const current = teams.find(team => team.id === row.teamId) || row;
 const count = current.memberCount ?? current.members?.length ?? current.people;
 const leads = current.leadNames || [current.leadName].filter(Boolean);
 return html`<strong>${count === undefined || !leads.length ? `${current.name || row.name} · ${subjectText("team")}` : subjectText("teamRow", current.name || row.name, count, leads.join(", "))}</strong><small class="note">${subjectText("teamHint")}</small>`;
}
