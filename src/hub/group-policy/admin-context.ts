/** Server-owned administrator/session boundary shared by the group-policy control. No routes or activation. */
import type { HubActor, PersonKey } from "../types.js";
import { personKeyString } from "../identity.js";
import { HubProtocolError, identifier, person, validated } from "../validation.js";
import type { GroupAdminContext } from "./admin-dto.js";

type DirectoryAdministrator = Extract<HubActor, { kind: "directory" }>;

export function createHubGroupAdminBoundary(options: { administrator: PersonKey; current(): boolean }) {
  // Never retain a caller-owned mutable key or re-read a replaced callback after an await.
  const administrator = validated(person, options.administrator), serverCurrent = options.current;
  const captured = new WeakSet<object>();
  let closed = false;
  const live = () => { try { return !closed && serverCurrent() === true; } catch { return false; } };
  const assertCurrent = (ctx: Pick<GroupAdminContext, "current">) => {
    if (!captured.has(ctx) || !live() || ctx.current() !== true) throw new HubProtocolError("unavailable");
  };
  const capture = (incoming: GroupAdminContext): GroupAdminContext => {
    const requestId = validated(identifier, incoming.requestId);
    if (typeof incoming.current !== "function" || typeof incoming.requireAdmin !== "function") throw new HubProtocolError("invalid");
    const caller = incoming.current.bind(incoming), authenticate = incoming.requireAdmin.bind(incoming);
    const ctx = Object.freeze({ requestId, requireAdmin: authenticate, current() {
      try { return live() && caller() === true; } catch { return false; }
    } });
    captured.add(ctx); return ctx;
  };
  const authenticate = async (ctx: GroupAdminContext): Promise<DirectoryAdministrator> => {
    assertCurrent(ctx);
    const actor = await ctx.requireAdmin();
    assertCurrent(ctx);
    if (actor.kind !== "directory" || personKeyString(validated(person, actor.person)) !== personKeyString(administrator)) throw new HubProtocolError("denied");
    return Object.freeze({ kind: "directory", person: Object.freeze(validated(person, actor.person)), sessionId: validated(identifier, actor.sessionId) });
  };
  return {
    async begin(incoming: GroupAdminContext) {
      const ctx = capture(incoming), actor = await authenticate(ctx);
      return { ctx, actor };
    },
    authenticate,
    assertCurrent,
    close(): void { closed = true; },
  };
}
