import { ChannelType, PermissionFlagsBits } from "discord.js";
import { DiscordAdapter } from "../../src/channel/adapters/discord.js";

/** Synthetic Discord caches only. No client login, network, directory or Fleet lifecycle. */
export function guestMentionFixture(fm: any) {
  const ids = { first: "900000000000000001", second: "900000000000000002", hidden: "900000000000000003", room: "900000000000000010", private: "900000000000000011", foreign: "900000000000000012", viewer: "900000000000000099" };
  const guild = { id: "900000000000000020", members: { cache: new Map([[ids.viewer, { id: ids.viewer, displayName: "Guest fixture" }], [ids.first, { displayName: "Avery" }], [ids.second, { displayName: "Blair" }]]) }, roles: { cache: new Map([[ids.first, { name: "Example role" }]]) } };
  const foreign = { id: "900000000000000021", members: { cache: new Map([[ids.hidden, { displayName: "Hidden fixture" }]]) }, roles: { cache: new Map([[ids.hidden, { name: "Hidden role" }]]) } };
  const channel = (id: string, g: any, name: string, allow: boolean) => ({ id, guild: g, name, type: ChannelType.GuildText, permissionsFor: () => ({ has: (bit: bigint) => allow && [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory].includes(bit) }) });
  const room = channel(ids.room, guild, "Example room", true), privateRoom = channel(ids.private, guild, "Hidden channel", false), foreignRoom = channel(ids.foreign, foreign, "Other server", true);
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  Object.assign(adapter, { type: "discord", id: "discord", client: { guilds: { cache: new Map([[guild.id, guild], [foreign.id, foreign]]) }, users: { cache: new Map([[ids.hidden, { globalName: "Hidden fixture", username: "hidden-fixture" }]]) }, channels: { cache: new Map([[ids.room, room], [ids.private, privateRoom], [ids.foreign, foreignRoom]]) } } });
  fm.worlds.set("discord", { type: "discord", adapter }); fm.adapters.set("discord", adapter);
  fm.fleetConfig.instances["agent-alpha"].channel_id = "discord"; fm.fleetConfig.instances["agent-alpha"].topic_id = ids.room;
  return { ids, adapter, guild, room, privateRoom, foreignRoom };
}
