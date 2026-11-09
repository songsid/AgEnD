/** Host-owner reader over validated existing state. No listener, directory client or alternate settings writer. */
import { hubServerDatabasePlan } from "./compose/server.js";
import { HUB_HTTP_MIGRATIONS } from "./http/schema.js";
import { withHubDirectoryNoticeRecovery } from "./settings-directory-recovery.js";
import { HUB_DIRECTORY_HOST_NOTICE_SINK, parseHubDirectoryNoticeQuery, type HubDirectoryNoticeQuery,
  type HubDirectoryNotices, type HubDirectoryNoticeHostContext } from "./settings-directory-notices.js";
import type { HubInitHostOwner } from "./init/types.js";
import { HubProtocolError, identifier, uuid, validated } from "./validation.js";

export function createHubDirectoryHostNotices(options: { home: string; readHub(): unknown; current(): boolean }) {
  const home = options.home, readHub = options.readHub.bind(options), hostCurrent = options.current.bind(options);
  function run<T>(owner: HubInitHostOwner, work: (notices: Readonly<Pick<HubDirectoryNotices, "forHost" | "acknowledgeHost">>,
    ctx: HubDirectoryNoticeHostContext) => T): T {
    const requestId = validated(identifier, owner.requestId), ownerCurrent = owner.current.bind(owner);
    if (owner.kind !== "host-session" || hostCurrent() !== true || ownerCurrent() !== true) throw new HubProtocolError("denied");
    const hub = structuredClone(readHub());
    if (!hub || typeof hub !== "object" || Array.isArray(hub)) throw new HubProtocolError("not-found");
    const { settings, migrations } = hubServerDatabasePlan(hub as Record<string, unknown>, HUB_HTTP_MIGRATIONS);
    const current = () => {
      if (hostCurrent() !== true || ownerCurrent() !== true) return false;
      const latest = readHub() as { hubId?: unknown; memberOrigin?: unknown } | null | undefined;
      return latest?.hubId === settings.hubId && latest?.memberOrigin === settings.memberOrigin;
    };
    if (!current()) throw new HubProtocolError("revoked");
    return withHubDirectoryNoticeRecovery({ home, hubId: settings.hubId, memberOrigin: settings.memberOrigin,
      migrations, hostSink: HUB_DIRECTORY_HOST_NOTICE_SINK, current }, notices => work(notices, { requestId, current }));
  }
  return {
    read(owner: HubInitHostOwner, raw: HubDirectoryNoticeQuery = {}) {
      const query = parseHubDirectoryNoticeQuery(raw); return run(owner, (notices, ctx) => notices.forHost(ctx, query));
    },
    acknowledge(owner: HubInitHostOwner, raw: string): void {
      const id = validated(uuid, raw); run(owner, (notices, ctx) => notices.acknowledgeHost(ctx, id));
    },
  };
}
export type HubDirectoryHostNotices = ReturnType<typeof createHubDirectoryHostNotices>;
