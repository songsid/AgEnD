/**
 * Hub rooms, seam 1 (docs/design/hub-rooms-split.md), served in memory with canned data: the contract's worked example.
 * Track U builds against it until the rooms server (track R) replaces it. Screens and words: docs/design/hub-rooms-ux.md.
 *
 * The seed (the split's ask, in the spec's own names):
 * - 研一主管週會: 王經理 (me, manager), 陳主任, 吳小安; 12 agents in every presence state; the room assistant.
 *   An @all with 6 answers, 1 still working (project-helper) and 5 that reply later (paused, offline, reply-later;
 *   answerLater() brings one), and an assistant
 *   summary of the answers. One invitation waits for its owner (the room's own list).
 * - 研發例會: I am a member (not a manager) and members may not @all (allMention off).
 * - 去年專案: archived (read-only).
 * - Direct chats (「對話」, the list's 「Agent」 group): project-helper (林小華) with a short history, report-bot (offline),
 *   and 「Hub 助理」 (the assistant). One invitation to my own agent waits for me (GET /hub/v1/invitations).
 *
 * Fields beyond the split's table, added on the U side and told to R:
 * - list item: `agent` { exposureId, owner: { name }, presence, presenceNote? } on a direct chat; `assistant: true` and
 *   its `presence` on the Hub assistant's; `mentioned` (an @ to me is unread); `archived`;
 * - events (Lumen): message.updated carries `parent` { id, ask } when a reply changes its question's counts;
 *   room.changed { roomId, removed: true } when I am no longer a member; member.changed { roomId };
 * - the list answer: `me` { canCreateRooms, assistant }, `invitations` (pending count);
 * - U2 (dev-claude2): room `invited[]` rows carry `owner: { name }` and `state: "pending" | "expired"`; my leaving as the
 *   only manager is 409 last-manager; the U2 block near the end serves pickers, roles, invitations, the agent's rooms, admin rooms;
 * - room detail: `me` { id, role } (the panel marks 「你」); an agent member's `canAsk` (dev-claude2);
 * - a Message echoes the `idempotencyKey` it was sent with; `warning: "assistant-unavailable"` (Ridge) when an @ of the
 *   assistant was stored but the assistant cannot answer now (setAssistant("paused")). Refusals: all-mention-off (403),
 *   not-member (403), archived (409).
 *
 * `handle()` answers one request ({ status, body }) or null for a path it does not serve. Adapters: `fetch` (unit tests,
 * with `EventSource` for the stream) and `route(page)` (Playwright: smokes and pictures).
 */
export type Presence = "online" | "idle" | "working" | "paused" | "offline" | "later";
export interface FixtureMember {
  id: string; kind: "person" | "agent" | "assistant" | "later"; name: string; owner?: { name: string };
  role: "manager" | "member"; presence: Presence; presenceNote?: string;
  /** dev-claude2: an agent this person may also ask one-to-one (「和它一對一對話」, spec §5). */
  canAsk?: boolean;
  /** dev-claude2 (R #3866): false for a person added from a group or team before their first Hub sign-in. */
  signedIn?: boolean;
}
export interface FixtureMessage {
  id: string; roomId: string; at: number; author: { kind: "person" | "agent" | "assistant" | "system"; id: string; name: string; owner?: { name: string } };
  text: string; mentions: string[]; replyTo?: string; files?: Array<{ id: string; name: string; size: number; mime: string; url: string }>;
  ask?: { total: number; answered: number; working: number; later: number };
  answerTo?: string; stage?: "queued" | "working" | "answered" | "not-answered"; idempotencyKey?: string;
  /** Ridge: a soft warning on a stored message (HTTP 200) — never a resend. */
  warning?: "assistant-unavailable";
}
export interface FixtureRoom {
  id: string; kind: "direct" | "group"; name: string; members: FixtureMember[]; messages: FixtureMessage[];
  settings: { allMention: boolean; historyForNew: "since-join" | "all" }; archived: boolean; readUpTo: string | null;
  assistant: boolean; invited: Array<{ id: string; exposureId: string; name: string; owner: { name: string }; at: number; state: "pending" | "expired" }>;
}
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Listener = (event: { data: string }) => void;

export const FIXTURE_ME = { id: "person-wang", name: "王經理", login: "wang" };   // login: the session's, as the Hub answers it (S-145 keys favourites by it)
const T0 = Date.UTC(2026, 10, 13, 2, 0, 0);
const minutes = (n: number) => T0 + n * 60_000;

const AGENTS: Array<[string, string, Presence, string?]> = [
  ["project-helper", "林小華", "working"], ["spec-writer", "陳主任", "idle"], ["release-notes", "吳小安", "idle"],
  ["test-runner", "林小華", "idle"], ["doc-search", "陳主任", "idle"], ["budget-check", "吳小安", "working"],
  ["design-review", "林小華", "idle"], ["schedule-bot", "陳主任", "paused", "額度用完"], ["infra-watch", "吳小安", "paused", "等待登入"],
  ["report-bot", "吳小安", "offline"], ["old-helper", "林小華", "offline", "需要更新 AgEnD"], ["desk-notes", "陳主任", "later"],
];

/** A fresh fixture (each test or smoke owns its own; nothing is shared). */
export function createHubRoomsFixture({ now = () => minutes(120), csrf = "fixture-csrf", features = ["rooms-v1", "attachments-v1"], teamLead = false } = {}) {
  let seq = 0;
  const nextId = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;
  const agentMembers: FixtureMember[] = AGENTS.map(([name, owner, presence, note], i) => ({ id: `exp-${String(i + 1).padStart(2, "0")}`, kind: presence === "later" ? "later" : "agent",
    name, owner: { name: owner }, role: "member", presence, ...(note ? { presenceNote: note } : {}),
    // I may ask 林小華's agents one-to-one (project-helper's chat below is one of them) and report-bot (its chat too).
    ...(owner === "林小華" || name === "report-bot" ? { canAsk: true } : {}) }));
  const people: FixtureMember[] = [
    { id: FIXTURE_ME.id, kind: "person", name: FIXTURE_ME.name, role: "manager", presence: "online" },
    { id: "person-chen", kind: "person", name: "陳主任", role: "member", presence: "online" },
    { id: "person-wu", kind: "person", name: "吳小安", role: "member", presence: "offline" },
  ];
  const assistant: FixtureMember = { id: "assistant", kind: "assistant", name: "房間助理", role: "member", presence: "idle" };
  const author = (m: FixtureMember) => ({ kind: m.kind === "later" ? "agent" as const : m.kind, id: m.id, name: m.name, ...(m.owner ? { owner: m.owner } : {}) });

  // 研一主管週會: people talk, an @all with answers (9 answered, 1 working, 2 later), the assistant's summary.
  const group: FixtureRoom = { id: "room-weekly", kind: "group", name: "研一主管週會", members: [...people, ...agentMembers, assistant], messages: [],
    settings: { allMention: true, historyForNew: "since-join" }, archived: false, readUpTo: null, assistant: true,
    // U2: one pending invitation and one that lapsed after 7 days (the manager can 重新邀請 it).
    invited: [{ id: "inv-0001", exposureId: "exp-90", name: "audit-helper", owner: { name: "周小明" }, at: minutes(10), state: "pending" },
      { id: "inv-0002", exposureId: "exp-91", name: "old-audit", owner: { name: "林小華" }, at: minutes(-7 * 24 * 60 - 60), state: "expired" }] };
  const say = (room: FixtureRoom, who: FixtureMember | { kind: "system"; id: string; name: string }, at: number, text: string, extra: Partial<FixtureMessage> = {}) => {
    const m: FixtureMessage = { id: nextId("msg"), roomId: room.id, at, author: "role" in who ? author(who) : who, text, mentions: [], ...extra };
    room.messages.push(m); return m;
  };
  const system = { kind: "system" as const, id: "system", name: "" };
  say(group, system, minutes(0), "王經理 建立了這個房間。");
  say(group, people[1]!, minutes(5), "這週的進度先各自看一下，十點前整理。");
  say(group, people[0]!, minutes(8), "好，我請大家的 Agent 先回報。");
  const all = say(group, people[0]!, minutes(9), "@所有 Agent 請各自用三行回報這週的進度與風險。", { mentions: ["all"] });
  // One rule with send (spec 1.7): 待命 and 處理中 get the question now; 暫停, 離線 and 上線時回答 answer later (Fable via Muse).
  const answering = agentMembers.filter(a => a.presence === "idle" || a.presence === "working");
  answering.forEach((a, i) => {
    if (a.name === "project-helper") return;                            // still working on it
    say(group, a, minutes(10 + i), `${a.name}：進度 ${60 + i * 3}%；風險：${i % 2 ? "測試資料不足" : "無"}；下週：整理文件。`, { replyTo: all.id, answerTo: all.id, stage: "answered" });
  });
  for (const a of agentMembers.filter(x => x.presence === "paused" || x.presence === "offline" || x.presence === "later"))
    say(group, a, minutes(25), "", { replyTo: all.id, answerTo: all.id, stage: "queued" });
  const answers = group.messages.filter(x => x.answerTo === all.id);
  all.ask = { total: 12, answered: answers.filter(x => x.stage === "answered").length, working: 1, later: answers.filter(x => x.stage === "queued").length };
  const askSummary = say(group, people[0]!, minutes(30), "@房間助理 整理上面的回答", { mentions: ["assistant"] });
  say(group, assistant, minutes(31), "**本週摘要**\n- 9 個 Agent 回報，平均進度約 72%。\n- 風險：測試資料不足（4 個）。\n- 還在處理：project-helper；稍後回覆：2 個。",
    { replyTo: askSummary.id, answerTo: askSummary.id, stage: "answered" });
  say(group, people[1]!, minutes(40), "@project-helper 剛剛那一點再說清楚", { mentions: ["exp-01"], ask: { total: 1, answered: 0, working: 1, later: 0 } });
  group.readUpTo = group.messages[group.messages.length - 3]!.id;            // 2 unread, one of them @-free

  const direct = (id: string, agent: FixtureMember, lines: Array<[number, string, string]>, extra: Partial<FixtureRoom> = {}): FixtureRoom => {
    const room: FixtureRoom = { id, kind: "direct", name: agent.name, members: [people[0]!, agent], messages: [],
      settings: { allMention: false, historyForNew: "all" }, archived: false, readUpTo: null, assistant: agent.kind === "assistant", invited: [], ...extra };
    let last = "";
    for (const [at, who, text] of lines) { const m = say(room, who === "me" ? people[0]! : agent, minutes(at), text, who === "me" ? {} : { answerTo: last, stage: "answered" }); last = m.id; }
    room.readUpTo = room.messages.at(-1)?.id ?? null;
    return room;
  };
  const helper = direct("room-helper", agentMembers[0]!, [[50, "me", "幫我看一下這份需求的風險。"], [52, "agent", "主要有三點：時程、測試資料、權限。"]]);
  const report = direct("room-report", agentMembers[9]!, [[20, "me", "上週的報表在哪裡？"]]);
  report.messages[0]!.stage = "queued";
  // Stored as the server stores it: an English fallback name; the page names it by its flag in the viewer's words (Ridge).
  const hubAssistant = direct("room-assistant", { ...assistant, name: "Hub assistant" }, []);
  // 研發例會: I am only a member here, and members may not @all.
  const meeting: FixtureRoom = { id: "room-rd", kind: "group", name: "研發例會", members: [{ ...people[0]!, role: "member" }, { ...people[1]!, role: "manager" }, ...agentMembers.slice(0, 4)],
    messages: [], settings: { allMention: false, historyForNew: "since-join" }, archived: false, readUpTo: null, assistant: false, invited: [] };
  say(meeting, system, minutes(1), "陳主任 建立了這個房間。");
  say(meeting, people[1]!, minutes(60), "下週例會改到週三。");
  meeting.readUpTo = meeting.messages.at(-1)!.id;
  // 去年專案: archived (read-only, still readable).
  const archived: FixtureRoom = { id: "room-archived", kind: "group", name: "去年專案", members: [people[0]!, people[2]!, agentMembers[2]!], messages: [],
    settings: { allMention: true, historyForNew: "all" }, archived: true, readUpTo: null, assistant: false, invited: [] };
  say(archived, people[2]!, minutes(-3000), "結案報告已上傳。");
  archived.readUpTo = archived.messages.at(-1)!.id;
  const rooms: FixtureRoom[] = [group, meeting, archived, helper, report, hubAssistant];
  const invitations = [{ id: "inv-in-0001", room: { id: "room-other", name: "產品規劃", people: 4 }, agent: { exposureId: "exp-mine-1", name: "my-notes" }, by: { name: "陳主任" }, at: minutes(100) }];
  const teams = [{ id: "team-1", name: "研一", department: "group-rd1", departmentName: "研發一部", revision: 1, lead: teamLead ? FIXTURE_ME.id : "person-chen", leadName: teamLead ? FIXTURE_ME.name : "陳主任", members: teamLead ? [FIXTURE_ME.id, "person-wu"] : ["person-chen", "person-wu"], canManage: true, isLead: teamLead, leadEligible: true }];
  const teamView = (team: typeof teams[number]) => ({ ...team, memberInfo: team.members.map(id => ({ id, name: [...people, NEW_PERSON].find(p => p.id === id)?.name || id, login: id === FIXTURE_ME.id ? FIXTURE_ME.login : id.replace("person-", ""), department: "", signedIn: id !== "person-new", agents: id === FIXTURE_ME.id ? [{ id: "exp-mine-1", name: "my-notes" }] : [] })), impact: { grants: [], roomCreator: creators.teams.includes(team.id) } });
  let creators = { people: [FIXTURE_ME.id], teams: [] as string[] };

  const sources = new Set<{ emit(name: string, data: unknown): void }>();
  const emit = (name: string, data: unknown) => { for (const s of sources) s.emit(name, data); };
  const unread = (r: FixtureRoom) => {
    const from = r.readUpTo ? r.messages.findIndex(m => m.id === r.readUpTo) + 1 : 0;
    return r.messages.slice(from).filter(m => m.author.id !== FIXTURE_ME.id && m.author.kind !== "system" && (m.text || m.stage !== "queued"));
  };
  const presenceOf = (r: FixtureRoom) => r.members.filter(m => m.kind !== "person");
  const listItem = (r: FixtureRoom) => {
    const last = [...r.messages].reverse().find(m => m.text);
    const agents = presenceOf(r), agent = r.kind === "direct" ? agents[0] : undefined;
    return { id: r.id, kind: r.kind, name: r.name, people: r.members.filter(m => m.kind === "person").length, agents: agents.filter(a => a.kind !== "assistant").length,
      online: r.members.filter(m => ["online", "idle", "working"].includes(m.presence)).length, unread: unread(r).length,
      lastAt: last?.at ?? 0, lastText: last?.text.slice(0, 120) ?? "", lastAuthor: last?.author.name ?? "",
      mentioned: unread(r).some(m => m.mentions.includes(FIXTURE_ME.id)), ...(r.archived ? { archived: true } : {}),
      ...(agent ? agent.kind === "assistant" ? { assistant: true, presence: agent.presence } : { agent: { exposureId: agent.id, owner: agent.owner, presence: agent.presence, ...(agent.presenceNote ? { presenceNote: agent.presenceNote } : {}) } } : {}) };
  };
  const roomOf = (id: string) => rooms.find(r => r.id === id);
  const fail = (status: number, code: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { code, ...extra } });
  // U2 (R #3866): AD groups. 研發一部 reads whole (20 direct members, 張新人 among them has never signed in), 研發二部 the
  // directory cannot read whole (503 group-unavailable), 全公司 is too big for a room (over 100 → 409 people-limit).
  const GROUPS: Record<string, { name: string; people: number }> = { "group-rd1": { name: "研發一部", people: 20 }, "group-rd2": { name: "研發二部", people: 8 }, "group-all": { name: "全公司", people: 132 } };
  const NEW_PERSON: FixtureMember = { id: "person-new", kind: "person", name: "張新人", role: "member", presence: "offline", signedIn: false };
  /** A room write's people check: the deduplicated union (the room's people, chosen people, teams' members, groups' heads). */
  const peopleCheck = (current: string[], chosen: { people?: unknown; teams?: unknown; groups?: unknown }): Reply | null => {
    const list = (v: unknown) => Array.isArray(v) ? v.map(String) : [];
    const broken = list(chosen.groups).find(g => g === "group-rd2" || !GROUPS[g]);
    if (broken) return fail(503, "group-unavailable", { group: broken });
    const ids = new Set([...current, ...list(chosen.people), ...list(chosen.teams).flatMap(t => teams.find(x => x.id === t)?.members ?? [])]);
    const heads = ids.size + list(chosen.groups).reduce((n, g) => n + GROUPS[g]!.people, 0);
    return heads > 100 ? fail(409, "people-limit", { people: heads, limit: 100 }) : null;
  };

  function handle(req: { method: string; path: string; headers?: Record<string, string>; body?: any }): Reply | null {
    const url = new URL(req.path, "https://hub.fixture.test"), p = url.pathname, method = req.method.toUpperCase();
    if (method !== "GET" && p.startsWith("/hub/v1/") && p !== "/hub/v1/session" && (req.headers?.["x-agend-hub-csrf"] ?? req.headers?.["X-AgEnD-Hub-CSRF"]) !== csrf) return fail(403, "csrf");
    if (p === "/hub/v1/session" && method === "GET")
      return { status: 200, body: { signedIn: true, csrf, person: { id: FIXTURE_ME.id, name: FIXTURE_ME.name }, displayName: FIXTURE_ME.name, login: FIXTURE_ME.login, admin: true, features } };
    if (p === "/hub/v1/rooms" && method === "GET")
      return { status: 200, body: { rooms: rooms.map(listItem).sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastAt - a.lastAt),
        me: { canCreateRooms: creators.people.includes(FIXTURE_ME.id), assistant: true }, invitations: invitations.length } };   // U2: me.assistant — the Hub offers the room assistant
    if (p === "/hub/v1/rooms" && method === "POST") {
      const b = req.body ?? {};
      if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 60) return fail(400, "invalid");
      const refused = peopleCheck([FIXTURE_ME.id], b);   // U2: no room is written when refused
      if (refused) return refused;
      const room: FixtureRoom = { id: nextId("room"), kind: "group", name: b.name.trim(), members: [people[0]!], messages: [], settings: { allMention: true, historyForNew: "since-join" },
        archived: false, readUpTo: null, assistant: b.assistant === true, invited: [] };
      if (b.assistant === true) room.members.push(assistant);
      say(room, system, now(), `${FIXTURE_ME.name} 建立了這個房間。`);
      rooms.push(room); emit("room.changed", { roomId: room.id, room: listItem(room) });
      return { status: 200, body: { room: listItem(room) } };
    }
    const m = p.match(/^\/hub\/v1\/rooms\/([^/]+)(?:\/(members|messages|read|invitations)(?:\/([^/]+))?)?$/);
    if (m && m[1] !== "events" && m[1] !== "candidates") {   // candidates: Track U2 below
      const room = roomOf(decodeURIComponent(m[1]!));
      if (!room) return fail(404, "not-found");
      const sub = m[2];
      if (!sub && method === "GET") return { status: 200, body: { room: listItem(room), me: { id: FIXTURE_ME.id, role: room.members.find(x => x.id === FIXTURE_ME.id)?.role ?? "member" },
        members: room.members, settings: room.settings, invited: room.invited } };
      if (!sub && method === "PATCH") {
        const b = req.body ?? {};
        if (typeof b.name === "string") room.name = b.name;
        if (typeof b.allMention === "boolean") room.settings.allMention = b.allMention;
        if (b.historyForNew === "since-join" || b.historyForNew === "all") room.settings.historyForNew = b.historyForNew;
        if (typeof b.archived === "boolean") room.archived = b.archived;
        emit("room.changed", { roomId: room.id, room: listItem(room) });
        return { status: 200, body: { room: listItem(room), settings: room.settings } };
      }
      if (sub === "members" && method === "POST") {
        const b = req.body ?? {}, agent = agentMembers.find(a => a.id === b.id);
        // U2 (R #3866): a group or team joins as its people now; nothing is written when refused.
        if (b.kind === "group" || b.kind === "team") {
          const refused = peopleCheck(room.members.filter(x => x.kind === "person").map(x => x.id), b.kind === "group" ? { groups: [b.id] } : { teams: [b.id] });
          if (refused) return refused;
          if (b.kind === "group" && !room.members.some(x => x.id === NEW_PERSON.id)) room.members.push({ ...NEW_PERSON });
          emit("member.changed", { roomId: room.id });
          return { status: 200, body: {} };
        }
        const added: FixtureMember = b.kind === "assistant" ? assistant : agent ?? { id: String(b.id), kind: "person", name: String(b.name ?? b.id), role: "member", presence: "offline" };
        if (!room.members.some(x => x.id === added.id)) room.members.push(added);
        emit("member.changed", { roomId: room.id });
        return { status: 200, body: { member: added } };
      }
      if (sub === "members" && method === "DELETE" && m[3]) {
        const gone = decodeURIComponent(m[3]!);
        // U2: the room's only manager cannot leave (hand the role on first).
        if (gone === FIXTURE_ME.id && room.members.find(x => x.id === gone)?.role === "manager" && room.members.filter(x => x.role === "manager").length === 1) return fail(409, "last-manager");
        room.members = room.members.filter(x => x.id !== gone);
        emit(gone === FIXTURE_ME.id ? "room.changed" : "member.changed", gone === FIXTURE_ME.id ? { roomId: room.id, removed: true } : { roomId: room.id });
        return { status: 200, body: {} };
      }
      if (sub === "messages" && method === "GET") {
        const before = url.searchParams.get("before"), limit = Math.min(100, Number(url.searchParams.get("limit")) || 50);
        const end = before ? room.messages.findIndex(x => x.id === before) : room.messages.length;
        const page = room.messages.slice(Math.max(0, (end < 0 ? room.messages.length : end) - limit), end < 0 ? room.messages.length : end);
        return { status: 200, body: { messages: page, more: page.length > 0 && room.messages[0] !== page[0] } };
      }
      if (sub === "messages" && method === "POST") {
        const b = req.body ?? {};
        if (room.archived) return fail(409, "archived");
        if (!room.members.some(x => x.id === FIXTURE_ME.id)) return fail(403, "not-member");
        const mentions: string[] = Array.isArray(b.mentions) ? b.mentions : [];
        if (mentions.includes("all") && !room.settings.allMention && room.members.find(x => x.id === FIXTURE_ME.id)?.role !== "manager") return fail(403, "all-mention-off");
        if (typeof b.text !== "string" || typeof b.idempotencyKey !== "string") return fail(400, "invalid");
        const prior = room.messages.find(x => x.idempotencyKey === b.idempotencyKey);
        if (prior) return { status: 200, body: { message: prior } };
        const targets = room.kind === "direct" ? presenceOf(room) : mentions.includes("all") ? presenceOf(room).filter(a => a.kind !== "assistant")
          : presenceOf(room).filter(a => mentions.includes(a.id) || (a.kind === "assistant" && mentions.includes("assistant")));
        const later = targets.filter(a => ["paused", "offline", "later"].includes(a.presence)).length;
        const assistantDown = targets.some(a => a.kind === "assistant" && a.presence === "paused");
        const msg = say(room, people[0]!, now(), b.text, { mentions, idempotencyKey: b.idempotencyKey, ...(b.replyTo ? { replyTo: b.replyTo } : {}),
          ...(Array.isArray(b.files) && b.files.length ? { files: b.files.map((id: string) => ({ id, name: `${id}.png`, size: 1024, mime: "image/png", url: `/hub/v1/rooms/${room.id}/files/${id}` })) } : {}),
          ...(targets.length ? { ask: { total: targets.length, answered: 0, working: targets.length - later, later } } : {}),
          ...(assistantDown ? { warning: "assistant-unavailable" as const } : {}) });
        room.readUpTo = msg.id;
        emit("message.added", { roomId: room.id, message: msg });
        return { status: 200, body: { message: msg } };
      }
      if (sub === "read" && method === "POST") {
        const upTo = req.body?.upTo;
        if (room.messages.some(x => x.id === upTo)) room.readUpTo = upTo;
        emit("unread.changed", { roomId: room.id, unread: unread(room).length });
        return { status: 200, body: { unread: unread(room).length } };
      }
      if (sub === "invitations" && method === "POST") {
        const ids: string[] = Array.isArray(req.body?.agents) ? req.body.agents : [];
        for (const exposureId of ids) room.invited.push({ id: nextId("inv"), exposureId, name: exposureId, owner: { name: "" }, at: now(), state: "pending" });
        emit("room.changed", { roomId: room.id, room: listItem(room) });
        return { status: 200, body: { invited: room.invited } };
      }
    }
    if (p === "/hub/v1/invitations" && method === "GET") return { status: 200, body: { invitations } };
    const inv = p.match(/^\/hub\/v1\/invitations\/([^/]+)\/(accept|decline)$/);
    if (inv && method === "POST") {
      const i = invitations.findIndex(x => x.id === decodeURIComponent(inv[1]!));
      if (i < 0) return fail(404, "not-found");
      invitations.splice(i, 1); emit("invitation.changed", {});
      return { status: 200, body: { ok: true } };
    }
    if (p === "/hub/v1/teams" && method === "GET") return { status: 200, body: { teams } };
    if (p === "/hub/v1/teams/candidates" && method === "GET") {
      const kind = url.searchParams.get("kind"), q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2 || q.length > 64 || !["person", "group"].includes(kind || "")) return fail(400, "invalid");
      const rows = kind === "group" ? Object.entries(GROUPS).map(([id, group]) => ({ kind, id, name: group.name, login: "" }))
        : [...people, NEW_PERSON].map(row => ({ kind, id: row.id, name: row.name, login: row.id === FIXTURE_ME.id ? FIXTURE_ME.login : row.id.replace("person-", "") }));
      return { status: 200, body: { candidates: rows.filter(row => `${row.name} ${row.login}`.toLowerCase().includes(q)).slice(0, 20) } };
    }
    if (p === "/hub/v1/teams" && method === "POST") {
      const body = req.body || {}, departmentName = GROUPS[body.department]?.name;
      if (!body.name?.trim() || !departmentName || !body.lead) return fail(400, "invalid");
      const team = { id: nextId("team"), name: body.name.trim(), department: body.department, departmentName, lead: body.lead,
        leadName: people.find(row => row.id === body.lead)?.name || body.lead, members: [...new Set<string>([body.lead, ...(body.members || [])])], revision: 1, canManage: true, isLead: teamLead, leadEligible: true };
      teams.push(team); return { status: 200, body: { team: teamView(team) } };
    }
    const teamMatch = p.match(/^\/hub\/v1\/teams\/([^/]+)$/);
    if (teamMatch) {
      const index = teams.findIndex(row => row.id === decodeURIComponent(teamMatch[1]!)), team = teams[index];
      if (!team) return fail(404, "not-found");
      if (method === "GET") return { status: 200, body: { team: teamView(team) } };
      if (method === "DELETE") { teams.splice(index, 1); return { status: 200, body: { ok: true } }; }
      if (method === "PATCH") {
        const body = req.body || {}; if (body.revision !== undefined && body.revision !== team.revision) return fail(409, "conflict");
        if (body.name) team.name = body.name; if (body.department) { team.department = body.department; team.departmentName = GROUPS[body.department]?.name || body.department; }
        const previousLead = team.lead; if (body.lead) { team.lead = body.lead; team.leadName = people.find(row => row.id === body.lead)?.name || body.lead; }
        if (body.members || body.lead) team.members = [...new Set<string>([team.lead, previousLead, ...(body.members || team.members)])];
        team.revision++; return { status: 200, body: { team: teamView(team) } };
      }
    }
    // U2: the creators list names its entries (the admin page shows them as tags); PUT still takes ids.
    if (p === "/hub/v1/admin/rooms/creators" && method === "GET") {
      const directory = [...people, { id: "person-lin", name: "林小華" }, { id: "person-zhou", name: "周小明" }];
      return { status: 200, body: { people: creators.people.map(id => ({ id, name: directory.find(x => x.id === id)?.name ?? id })),
        teams: creators.teams.map(id => { const team = teams.find(x => x.id === id); return { id, name: team?.name ?? id, people: team?.members.length ?? 0 }; }) } };
    }
    if (p === "/hub/v1/admin/rooms/creators" && method === "PUT") { creators = { people: req.body?.people ?? [], teams: req.body?.teams ?? [] }; return { status: 200, body: creators }; }
    if (p === "/hub/v1/admin/rooms" && method === "GET")
      return { status: 200, body: { rooms: rooms.filter(r => r.kind === "group").map(r => ({ id: r.id, name: r.name, people: r.members.filter(x => x.kind === "person").length,
        agents: r.members.filter(x => x.kind === "agent" || x.kind === "later").length, managers: r.members.filter(x => x.role === "manager").map(x => x.name),
        lastAt: r.messages.at(-1)?.at ?? 0, archived: r.archived })) } };
    // ── Track U2 (dev-claude2): pickers, roles, invitations, the agent's rooms, admin rooms ──
    if (p === "/hub/v1/rooms/candidates" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase(), kind = url.searchParams.get("kind");
      const all = [
        ...[...people, { id: "person-lin", name: "林小華" }, { id: "person-zhou", name: "周小明" }].map(x => ({ kind: "person", id: x.id, name: x.name })),
        ...teams.map(x => ({ kind: "team", id: x.id, name: x.name, people: x.members.length })),
        ...Object.entries(GROUPS).map(([id, g]) => ({ kind: "group", id, name: g.name })),   // a group's count is read when chosen
        ...agentMembers.map(x => ({ kind: "agent", id: x.id, name: x.name, owner: x.owner, mine: false })),
        { kind: "agent", id: "exp-mine-1", name: "my-notes", owner: { name: FIXTURE_ME.name }, mine: true },
      ];
      return { status: 200, body: { candidates: all.filter(x => (!kind || x.kind === kind) && (!q || x.name.toLowerCase().includes(q))) } };
    }
    const chosenGroup = p.match(/^\/hub\/v1\/rooms\/candidates\/group\/([^/]+)$/);
    if (chosenGroup && method === "GET") {
      const gid = decodeURIComponent(chosenGroup[1]!), g = GROUPS[gid];
      if (!g || gid === "group-rd2") return fail(503, "group-unavailable", { group: gid });
      return { status: 200, body: { kind: "group", id: gid, name: g.name, people: g.people } };
    }
    const u2 = p.match(/^\/hub\/v1\/rooms\/([^/]+)\/(members|invitations)\/([^/]+)$/);
    if (u2 && u2[2] === "members" && method === "PATCH") {
      const room = roomOf(decodeURIComponent(u2[1]!)), who = room?.members.find(x => x.id === decodeURIComponent(u2[3]!));
      if (!room || !who) return fail(404, "not-found");
      const role = req.body?.role;
      if (role !== "manager" && role !== "member") return fail(400, "invalid");
      if (role === "member" && who.role === "manager" && room.members.filter(x => x.role === "manager").length === 1) return fail(409, "last-manager");
      who.role = role; emit("member.changed", { roomId: room.id });
      return { status: 200, body: { member: who } };
    }
    if (u2 && u2[2] === "invitations" && method === "DELETE") {
      const room = roomOf(decodeURIComponent(u2[1]!));
      if (!room) return fail(404, "not-found");
      const before = room.invited.length;
      room.invited = room.invited.filter(x => x.id !== decodeURIComponent(u2[3]!));
      if (room.invited.length === before) return fail(404, "not-found");
      emit("room.changed", { roomId: room.id, room: listItem(room) });
      return { status: 200, body: { ok: true } };
    }
    const agentRooms = p.match(/^\/hub\/v1\/exposures\/([^/]+)\/rooms$/);
    if (agentRooms && method === "GET") {
      const exposureId = decodeURIComponent(agentRooms[1]!);
      return { status: 200, body: { rooms: rooms.filter(r => r.kind === "group" && r.members.some(x => x.id === exposureId))
        .map(r => ({ id: r.id, name: r.name, people: r.members.filter(x => x.kind === "person").length, memberId: exposureId })) } };
    }
    const admin = p.match(/^\/hub\/v1\/admin\/rooms\/([^/]+)(\/join)?$/);
    if (admin && ((admin[2] && method === "POST") || (!admin[2] && method === "PATCH"))) {
      const room = roomOf(decodeURIComponent(admin[1]!));
      if (!room) return fail(404, "not-found");
      if (admin[2]) {
        const mine = room.members.find(x => x.id === FIXTURE_ME.id);
        if (mine) mine.role = "manager";
        else { room.members.push({ id: FIXTURE_ME.id, kind: "person", name: FIXTURE_ME.name, role: "manager", presence: "online" }); say(room, system, now(), `${FIXTURE_ME.name} 加入了房間`); }
        emit("member.changed", { roomId: room.id });
      } else if (typeof req.body?.archived === "boolean") { room.archived = req.body.archived; emit("room.changed", { roomId: room.id, room: listItem(room) }); }
      return { status: 200, body: { room: listItem(room) } };
    }
    // ── end Track U2 ──
    return null;
  }

  /** The late answer the spec's walk asks for (step 3): a reply-later agent comes online and answers the @all. */
  function answerLater(roomId = "room-weekly") {
    const room = roomOf(roomId)!, pending = room.messages.find(x => x.stage === "queued" && x.answerTo);
    if (!pending) return null;
    const agent = room.members.find(x => x.id === pending.author.id)!;
    agent.presence = "idle"; pending.stage = "answered"; pending.text = `${agent.name}：上線後補答，進度 80%。`; pending.at = now();
    const question = room.messages.find(x => x.id === pending.answerTo)!;
    if (question.ask) question.ask = { ...question.ask, answered: question.ask.answered + 1, later: Math.max(0, question.ask.later - 1) };
    emit("presence.changed", { roomId, memberId: agent.id, presence: agent.presence });
    emit("message.updated", { roomId, message: pending, ...(question.ask ? { parent: { id: question.id, ask: question.ask } } : {}) });
    emit("unread.changed", { roomId, unread: unread(room).length });
    return pending;
  }

  /** The room assistant's state everywhere (spec §10: 「暫時無法回答」 is paused). */
  function setAssistant(presence: "idle" | "working" | "paused") {
    assistant.presence = presence;
    for (const r of rooms) if (r.members.some(m => m.id === assistant.id)) emit("presence.changed", { roomId: r.id, memberId: assistant.id, presence });
  }
  /** A fetch for unit tests: same-origin paths, JSON in and out; a path the fixture does not serve is 404. */
  async function fetchImpl(input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    const r = handle({ method: init.method ?? "GET", path: input, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined }) ?? fail(404, "not-found");
    const bytes = JSON.stringify(r.body);                            // a copy, as over the network: never the fixture's own objects
    return { ok: r.status < 300, status: r.status, headers: { get: (name: string) => r.headers?.[name] ?? null }, json: async () => JSON.parse(bytes) };
  }
  /** An EventSource for unit tests: opened on /hub/v1/rooms/events, fed by emit(). */
  class FixtureEventSource {
    readyState = 1; private listeners = new Map<string, Set<Listener>>(); private self = { emit: (name: string, data: unknown) => {
      if (this.readyState !== 1) return; for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) }); } };
    constructor(readonly url: string) { if (url.startsWith("/hub/v1/rooms/events")) sources.add(this.self); else this.readyState = 2; }
    addEventListener(name: string, fn: Listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(fn); }
    removeEventListener(name: string, fn: Listener) { this.listeners.get(name)?.delete(fn); }
    close() { this.readyState = 2; sources.delete(this.self); }
  }
  /**
   * Playwright: answer the seam on this page (or context). The stream is answered with whatever was emitted since the
   * last answer and a long retry, so a picture is still and a test can still push events.
   */
  async function route(target: { route(glob: string, handler: (r: any) => unknown): Promise<unknown> }) {
    const queued: string[] = [];
    sources.add({ emit: (name, data) => { queued.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } });
    await target.route("**/hub/v1/**", async (r: any) => {
      const request = r.request(), path = new URL(request.url()).pathname + new URL(request.url()).search;
      if (path.startsWith("/hub/v1/rooms/events"))
        return r.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body: `retry: 600000\n\n${queued.splice(0).join("")}` });
      const raw = request.postData();
      const out = handle({ method: request.method(), path, headers: request.headers(), body: raw ? JSON.parse(raw) : undefined });
      if (!out) return r.fallback();
      return r.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.body) });
    });
  }
  return { me: FIXTURE_ME, rooms, invitations, teams, csrf, handle, emit, answerLater, setAssistant, fetch: fetchImpl, EventSource: FixtureEventSource, route };
}
export type HubRoomsFixture = ReturnType<typeof createHubRoomsFixture>;
