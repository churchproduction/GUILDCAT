// Discord client: connects, registers guild slash commands, routes interactions.
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
} from "discord.js";
import { buildDefinitions, buildHandlers } from "./commands.js";

export async function startBot({ config, queries, roblox, service }) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  const { dispatch, isMod, isSenior } = buildHandlers({ queries, roblox, config, service });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Discord: logged in as ${c.user.tag}`);
    try {
      const rest = new REST().setToken(config.discord.token);
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: buildDefinitions() }
      );
      console.log("Discord: slash commands registered");
    } catch (err) {
      console.error("Discord: failed to register commands:", err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== config.discord.guildId) return;
    await dispatch(interaction);
  });

  await client.login(config.discord.token);

  return {
    client,
    /**
     * Used by the web login: is this Discord user a moderator in the guild?
     * Returns the member's basic profile if yes, null if no.
     */
    async checkStaff(discordUserId) {
      try {
        const guild = await client.guilds.fetch(config.discord.guildId);
        const member = await guild.members.fetch(discordUserId);
        if (!isMod(member)) return null;
        return {
          id: member.id,
          username: member.user.username,
          displayName: member.displayName,
          avatar: member.displayAvatarURL({ size: 64 }),
          senior: isSenior(member),
        };
      } catch {
        return null; // not in the guild (or fetch failed) → not staff
      }
    },
  };
}
