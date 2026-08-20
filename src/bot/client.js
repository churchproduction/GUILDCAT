// Discord client: connects, registers guild slash commands, routes interactions.
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
} from "discord.js";
import { buildDefinitions, buildHandlers } from "./commands.js";
import { createTicketSystem } from "./tickets.js";
import { createHoneypot } from "./honeypot.js";

export async function startBot({ config, queries, roblox, service }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      // Ticket channels are mirrored to the dashboard, so the bot reads the
      // messages in them. Needs "Message Content Intent" enabled in the
      // Discord developer portal (Bot tab), same place as the members intent.
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const tickets = createTicketSystem({ client, config, queries });
  const honeypot = createHoneypot({ client, config, queries, service });
  const { dispatch, isMod, isSenior } = buildHandlers({
    queries,
    roblox,
    config,
    service,
    tickets,
  });

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
    if (interaction.guildId !== config.discord.guildId) return;
    try {
      if (interaction.isButton() || interaction.isModalSubmit()) {
        const handled = await tickets.handleInteraction(interaction);
        if (!handled) await honeypot.handleInteraction(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) await dispatch(interaction);
    } catch (err) {
      console.error("Interaction failed:", err);
    }
  });

  client.on(Events.MessageCreate, (message) => tickets.onMessage(message));

  await client.login(config.discord.token);

  return {
    client,

    // The web server talks to Discord through this.
    bridge: {
      postGameReport: tickets.postGameReport,
      sendTicketReply: tickets.sendTicketReply,
      webCloseSupport: tickets.webCloseSupport,
      postHoneypotHit: honeypot.postHit,
    },

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
