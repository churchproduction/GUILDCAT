// Ticket system + in-game report relay.
//
// Tickets: a panel message offers two buttons — User Report / Support Ticket.
// Clicking opens a modal; submitting creates a private channel the opener and
// the mod team can see, pings the mod roles, and records everything so the
// dashboard shows the same conversation live.
//
//   • Support tickets close with the button (or /close, or from the website).
//   • User-report tickets ONLY close via /close with the reporter's Discord
//     user + the reported Roblox username (+ evidence) — closing files a
//     "Player report" entry on that player's record automatically.
//
// In-game reports: the game POSTs to the web server, which calls
// postGameReport() here → an embed in REPORT_CHANNEL_ID with a Join Server
// button that puts a mod into the exact server the report came from.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { joinServerUrl, clamp } from "../format.js";

const KIND_LABEL = { report: "User report", support: "Support ticket" };
const COLORS = { report: 0xd64550, support: 0x5865f2, closed: 0x6b7a8f, game: 0xd64550 };

export function createTicketSystem({ client, config, queries }) {
  const staffRoleIds = [
    ...config.discord.modRoleIds,
    ...config.discord.seniorRoleIds,
  ];

  const pingRoleIds = config.discord.ticketPingRoleIds.length
    ? config.discord.ticketPingRoleIds
    : config.discord.modRoleIds;
  const modPing = () => pingRoleIds.map((id) => `<@&${id}>`).join(" ") || "@here";

  const dashboardTicketLink = (id) => `${config.web.baseUrl}/#/ticket/${id}`;

  /* ── panels ───────────────────────────────────────────── */

  const PANEL_WARNING =
    "Misuse of the ticket system will result to you being permanently unable to use them in the future.";

  const REPORT_PANEL_TEXT =
    PANEL_WARNING +
    "\n\n> This ticket should **ONLY** be used for reporting exploiters in-game." +
    "\n> Do **NOT** use this ticket for reporting bugs, asking for roles, or bugging staff." +
    "\n\nPlease ensure in your evidence you are CLEARLY able to see the exploiters username, " +
    "you can do this by simply opening up the leader-board and clicking on the person." +
    "\nIf we can't see the username, we CANT ban them. We also need distinct visual proof " +
    "(clear recordings), we don't expect Ultra-HD recordings but we need to be able to make " +
    "out what is happening to help.";

  const SUPPORT_PANEL_TEXT =
    PANEL_WARNING +
    "\n\n> Use this ticket to;" +
    "\n> • Report people in the Discord Server" +
    "\n> • Dispute an in-game ban" +
    "\n> • Report Staff for misconduct" +
    "\n> • And anything else that can't be solved with relative information around the server!" +
    "\n\nPlease remember that staff are people too, we can't be on tickets 24/7 so it may take " +
    "some time for your ticket to be answered but we WILL get to it eventually." +
    "\n\nTickets that staff cannot help you with will be closed by our staff, continued " +
    "re-opening of tickets for the same issue AFTER them being closed will result in punishment.";

  /** Download a Discord attachment so the banner lives on the panel message forever. */
  async function bannerFile(attachment, name) {
    if (!attachment) return null;
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error("couldn't download the banner image");
    const ext = (attachment.name?.match(/\.\w+$/) || [".png"])[0];
    return {
      file: new AttachmentBuilder(Buffer.from(await res.arrayBuffer()), { name: name + ext }),
      ref: `attachment://${name}${ext}`,
    };
  }

  async function postPanel(channel, { type = "both", reportImage, supportImage } = {}) {
    if (type === "support" || type === "both") {
      const banner = await bannerFile(supportImage, "support-banner");
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("GENERAL SUPPORT")
        .setDescription(SUPPORT_PANEL_TEXT);
      if (banner) embed.setImage(banner.ref);
      await channel.send({
        embeds: [embed],
        files: banner ? [banner.file] : [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("wardenTicket:open:support")
              .setLabel("Open a ticket!")
              .setEmoji("📩")
              .setStyle(ButtonStyle.Primary)
          ),
        ],
      });
    }
    if (type === "report" || type === "both") {
      const banner = await bannerFile(reportImage, "report-banner");
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("EXPLOITER REPORT")
        .setDescription(REPORT_PANEL_TEXT);
      if (banner) embed.setImage(banner.ref);
      await channel.send({
        embeds: [embed],
        files: banner ? [banner.file] : [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("wardenTicket:open:report")
              .setLabel("Create a Report!")
              .setEmoji("⚔️")
              .setStyle(ButtonStyle.Danger)
          ),
        ],
      });
    }
  }

  /* ── open flow: button → modal → channel ─────────────── */

  function openModal(kind) {
    const modal = new ModalBuilder()
      .setCustomId(`wardenTicket:modal:${kind}`)
      .setTitle(kind === "report" ? "Report a player" : "Open a support ticket");
    if (kind === "report") {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("subject")
            .setLabel("Roblox username of the player")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("details")
            .setLabel("What happened?")
            .setPlaceholder("What were they doing? When? Which server?")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(900)
        )
      );
    } else {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("subject")
            .setLabel("Subject")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("details")
            .setLabel("How can we help?")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(900)
        )
      );
    }
    return modal;
  }

  const channelName = (kind, user) =>
    `${kind === "report" ? "report" : "support"}-${user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .slice(0, 60);

  async function hasOpenTicket(openerId, kind) {
    const { rows } = queries.listTickets({ status: "open", limit: 200 });
    return rows.find((t) => t.opener_id === openerId && t.kind === kind);
  }

  async function createTicketChannel(interaction, kind, subject, details) {
    const guild = interaction.guild;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];
    for (const roleId of staffRoleIds) {
      if (guild.roles.cache.has(roleId)) {
        overwrites.push({
          id: roleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        });
      }
    }

    const channel = await guild.channels.create({
      name: channelName(kind, interaction.user),
      type: ChannelType.GuildText,
      parent: config.discord.ticketCategoryId || undefined,
      permissionOverwrites: overwrites,
    });

    const ticketId = queries.createTicket({
      kind,
      channel_id: channel.id,
      opener_id: interaction.user.id,
      opener_tag: interaction.user.username,
      subject,
      details,
    });
    queries.addTicketMessage({
      ticket_id: ticketId,
      author_id: interaction.user.id,
      author_name: interaction.user.username,
      via: "discord",
      content: details,
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS[kind])
      .setTitle(`${KIND_LABEL[kind]} #${ticketId}`)
      .addFields(
        { name: kind === "report" ? "Reported player" : "Subject", value: subject },
        { name: kind === "report" ? "What happened" : "Details", value: details },
        { name: "Opened by", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Dashboard", value: dashboardTicketLink(ticketId), inline: true },
        kind === "report"
          ? {
              name: "Closing this ticket",
              value:
                "Staff close report tickets with `/close`: the reported player's Roblox " +
                "username + evidence (link or file) — both required. The reporter is filled " +
                "in automatically from whoever opened this ticket. Closing files the report " +
                "on the player's record.",
            }
          : {
              name: "Closing this ticket",
              value: "Press the button below (or `/close`) when it's resolved.",
            }
      )
      .setTimestamp(new Date());

    const components =
      kind === "support"
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`wardenTicket:close:${ticketId}`)
                .setLabel("Close ticket")
                .setStyle(ButtonStyle.Secondary)
            ),
          ]
        : [];

    await channel.send({
      content: `${modPing()} — new ${KIND_LABEL[kind].toLowerCase()} from <@${interaction.user.id}>`,
      embeds: [embed],
      components,
    });

    return { channel, ticketId };
  }

  /* ── closing ──────────────────────────────────────────── */

  async function postToLog(embed) {
    if (!config.discord.logChannelId) return;
    try {
      const channel = await client.channels.fetch(config.discord.logChannelId);
      if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn("Couldn't post ticket log:", err.message);
    }
  }

  /**
   * Mark closed in DB, announce in the channel, mirror to the log channel,
   * then delete the channel shortly after. `fields` lands in both embeds.
   */
  async function finalizeClose({ ticket, closedBy, fields = [], closeActionId = null }) {
    queries.closeTicket(ticket.id, { closedBy: closedBy.id, closeActionId });
    queries.addTicketMessage({
      ticket_id: ticket.id,
      author_id: closedBy.id,
      author_name: closedBy.name,
      via: "system",
      content: `Ticket closed by ${closedBy.name}${closedBy.via === "web" ? " (dashboard)" : ""}`,
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS.closed)
      .setTitle(`${KIND_LABEL[ticket.kind]} #${ticket.id} closed`)
      .addFields(
        { name: "Opened by", value: `<@${ticket.opener_id}>`, inline: true },
        { name: "Closed by", value: closedBy.mention ?? closedBy.name, inline: true },
        ...fields,
        { name: "Transcript", value: dashboardTicketLink(ticket.id) }
      )
      .setTimestamp(new Date());

    postToLog(embed);

    if (ticket.channel_id) {
      try {
        const channel = await client.channels.fetch(ticket.channel_id);
        await channel.send({
          content: "This ticket is closed — the channel disappears in a few seconds. " +
            "The full transcript stays on the dashboard.",
          embeds: [embed],
        });
        setTimeout(() => channel.delete("Ticket closed").catch(() => {}), 8000);
      } catch {
        /* channel already gone */
      }
    }
    return embed;
  }

  /* ── interactions (buttons + modals) ──────────────────── */

  const isStaffMember = (member) => {
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return staffRoleIds.some((id) => member?.roles?.cache?.has?.(id));
  };

  async function handleInteraction(interaction) {
    const id = interaction.customId ?? "";
    if (!id.startsWith("wardenTicket:")) return false;

    if (interaction.isButton() && id.startsWith("wardenTicket:open:")) {
      const kind = id.split(":")[2];
      if (!KIND_LABEL[kind]) return true;
      const existing = await hasOpenTicket(interaction.user.id, kind);
      if (existing) {
        await interaction.reply({
          content: `You already have an open ${KIND_LABEL[kind].toLowerCase()}${existing.channel_id ? `: <#${existing.channel_id}>` : ""}.`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      await interaction.showModal(openModal(kind));
      return true;
    }

    if (interaction.isModalSubmit() && id.startsWith("wardenTicket:modal:")) {
      const kind = id.split(":")[2];
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const subject = clamp(interaction.fields.getTextInputValue("subject").trim(), 100);
        const details = interaction.fields.getTextInputValue("details").trim();
        const { channel } = await createTicketChannel(interaction, kind, subject, details);
        await interaction.editReply({ content: `Your ticket is open: <#${channel.id}>` });
      } catch (err) {
        console.error("Ticket creation failed:", err);
        await interaction
          .editReply({
            content:
              "Couldn't open the ticket — the bot may be missing the Manage Channels permission.",
          })
          .catch(() => {});
      }
      return true;
    }

    if (interaction.isButton() && id.startsWith("wardenTicket:close:")) {
      const ticketId = parseInt(id.split(":")[2], 10);
      const ticket = queries.getTicket(ticketId);
      if (!ticket || ticket.status !== "open") {
        await interaction.reply({ content: "This ticket is already closed.", flags: MessageFlags.Ephemeral });
        return true;
      }
      if (ticket.kind === "report") {
        await interaction.reply({
          content: "Report tickets close with `/close` (reporter + player + evidence), so the report gets filed.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      // Support tickets: the opener or any staff member can close.
      const allowed =
        interaction.user.id === ticket.opener_id || isStaffMember(interaction.member);
      if (!allowed) {
        await interaction.reply({ content: "Only the opener or staff can close this.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await finalizeClose({
        ticket,
        closedBy: {
          id: interaction.user.id,
          name: interaction.user.username,
          mention: `<@${interaction.user.id}>`,
          via: "discord",
        },
      });
      await interaction.editReply({ content: "Ticket closed." }).catch(() => {});
      return true;
    }

    return true;
  }

  /* ── message sync (Discord → dashboard) ───────────────── */

  function onMessage(message) {
    try {
      if (!message.guildId || message.guildId !== config.discord.guildId) return;
      if (message.author?.bot) return; // web replies are recorded when sent
      const ticket = queries.ticketByChannel(message.channelId);
      if (!ticket || ticket.status !== "open") return;
      const attachments = [...message.attachments.values()].map((a) => ({
        name: a.name,
        url: a.url,
      }));
      queries.addTicketMessage({
        ticket_id: ticket.id,
        author_id: message.author.id,
        author_name: message.member?.displayName ?? message.author.username,
        via: "discord",
        content: message.content || null,
        attachments: attachments.length ? JSON.stringify(attachments) : null,
      });
    } catch (err) {
      console.warn("Ticket message sync failed:", err.message);
    }
  }

  /* ── website → Discord ────────────────────────────────── */

  async function sendTicketReply(ticket, staff, text) {
    if (!ticket.channel_id) throw new Error("This ticket has no Discord channel anymore.");
    const channel = await client.channels.fetch(ticket.channel_id);
    // Members see one consistent voice; WHO sent it is recorded in the
    // transcript + audit trail, not shown in the channel.
    await channel.send({
      content: `**Moderation Team**\n${clamp(text, 1800)}`,
      allowedMentions: { parse: [] },
    });
  }

  async function webCloseSupport(ticket, staff) {
    await finalizeClose({
      ticket,
      closedBy: {
        id: staff.id,
        name: staff.username,
        mention: "Moderation Team",
        via: "web",
      },
    });
  }

  /* ── in-game exploit reports → Discord ────────────────── */

  async function postGameReport(report, targetAvatarUrl) {
    if (!config.discord.reportChannelId) return;
    try {
      const channel = await client.channels.fetch(config.discord.reportChannelId);
      if (!channel?.isTextBased()) return;

      const join = joinServerUrl(report.place_id, report.job_id);
      const embed = new EmbedBuilder()
        .setColor(COLORS.game)
        .setTitle("In-game exploit report")
        .setDescription(
          `**[${report.reporter_name}](https://www.roblox.com/users/${report.reporter_user_id}/profile)** reported ` +
            `**[${report.target_name}](https://www.roblox.com/users/${report.target_user_id}/profile)** \`${report.target_user_id}\``
        )
        .addFields(
          { name: "What they said", value: clamp(report.reason, 900) },
          report.job_id
            ? { name: "Server", value: `\`${report.job_id}\``, inline: true }
            : { name: "Server", value: "none — Studio test (real reports get a Join button)", inline: true },
          { name: "Record", value: `${config.web.baseUrl}/#/user/${report.target_user_id}`, inline: true }
        )
        .setTimestamp(new Date(report.created_at ?? Date.now()));
      if (targetAvatarUrl) embed.setThumbnail(targetAvatarUrl);

      const buttons = [];
      if (join) {
        buttons.push(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Join their server").setURL(join)
        );
      }
      buttons.push(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Open on dashboard")
          .setURL(`${config.web.baseUrl}/#/reports`)
      );

      await channel.send({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(...buttons)],
      });
    } catch (err) {
      console.warn("Couldn't post game report to Discord:", err.message);
    }
  }

  return {
    postPanel,
    handleInteraction,
    onMessage,
    finalizeClose,
    sendTicketReply,
    webCloseSupport,
    postGameReport,
  };
}
