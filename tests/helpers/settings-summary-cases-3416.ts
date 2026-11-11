/** Pure diff inputs: no filesystem, process, account or real credential. */
const agents = Object.fromEntries(["one", "two", "three", "four", "five", "six"].map(name => [name, {}]));
const channel = (id: string) => ({ id, type: "discord", group_id: "100", access: { mode: "locked", allowed_users: ["1"] } });
export const settingsSummaryCases: Array<{ name: string; before: unknown; after: unknown; options?: { force?: boolean; secret?: { key: string; before?: string; after: string } } }> = [
  { name: "secret", before: null, after: null, options: { secret: { key: "EXAMPLE_SECRET", after: "dummy-value" } } },
  { name: "identity", before: { access: { allowed_users: ["1"] } }, after: { access: { allowed_users: ["2"] } } },
  { name: "classic-admin", before: { classic: { channels: { room: { admin_users: ["1"] } } } }, after: { classic: { channels: { room: { admin_users: ["2"] } } } } },
  { name: "user", before: { allowed_users: ["1"] }, after: { allowed_users: ["2"] } },
  { name: "group", before: { allowed_groups: ["1"] }, after: { allowed_groups: ["2"] } },
  { name: "guild", before: { allowed_guilds: ["1"] }, after: { allowed_guilds: ["2"] } },
  { name: "identity-order", before: { allowed_users: ["1", "2"] }, after: { allowed_users: ["2", "1"] } },
  { name: "identity-inherit", before: { access: { allowed_users: ["1"] } }, after: { access: {} } },
  { name: "connections-order", before: { fleet: { channels: [channel("a"), channel("b")] } }, after: { fleet: { channels: [channel("b"), channel("a")] } } },
  { name: "connection-add-remove", before: { fleet: { channels: [channel("a")] } }, after: { fleet: { channels: [channel("b")] } } },
  { name: "number", before: { permission_level: 1 }, after: { permission_level: 2 } },
  { name: "default", before: { fleet: { web: { session: { local: { idle_hours: 1 } } } } }, after: { fleet: { web: { session: { local: {} } } } } },
  { name: "directional", before: { fleet: { web: { log_tab: false } } }, after: { fleet: { web: { log_tab: true } } } },
  { name: "deleted-agent", before: { fleet: { instances: { worker: { description: "free text" } } } }, after: { fleet: { instances: {} } } },
  { name: "forced", before: {}, after: {}, options: { force: true } },
  { name: "visibility-inherited", before: { defaults: { cross_instance_visibility: "hidden" }, instances: agents }, after: { defaults: { cross_instance_visibility: "full" }, instances: agents } },
  { name: "visibility-own", before: { defaults: { cross_instance_visibility: "hidden" }, instances: { worker: { cross_instance_visibility: "hidden" } } }, after: { defaults: { cross_instance_visibility: "hidden" }, instances: { worker: { cross_instance_visibility: "full" } } } },
  { name: "visibility-default", before: { defaults: { cross_instance_visibility: "hidden" }, instances: { worker: {} } }, after: { defaults: { cross_instance_visibility: "hidden" }, instances: { worker: { cross_instance_visibility: "invalid" } } } },
  { name: "dashboard-inherited", before: { defaults: { dashboard: { task_board: false } }, instances: agents }, after: { defaults: { dashboard: { task_board: true } }, instances: agents } },
  { name: "dashboard-own", before: { defaults: { dashboard: { task_board: false } }, instances: { worker: {} } }, after: { defaults: { dashboard: { task_board: false } }, instances: { worker: { dashboard: { task_board: true } } } } },
  { name: "dashboard-default", before: { instances: { worker: {} } }, after: { instances: { worker: { dashboard: { task_board: "invalid" } } } } },
  { name: "record-limit", before: { allowed_users: [] }, after: { allowed_users: Array.from({ length: 40 }, (_, i) => String(i)) } },
  { name: "unit-limit", before: { working_directory: "short" }, after: { working_directory: "x".repeat(5000) } },
  { name: "unsupported", before: {}, after: { opaque: { private: "unknown string" } } },
];
