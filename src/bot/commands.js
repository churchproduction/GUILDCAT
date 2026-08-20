// Slash command definitions + handlers.
// The actual moderation work lives in src/actions.js (shared with the web
// dashboard) — this file is Discord glue: options, permissions, embeds.
//
// Permission tiers:
//   • senior  (SENIOR_ROLE_IDS, or server admin)          → /ban, /unban + everything below
//   • mod     (MOD_ROLE_IDS, SENIOR_ROLE_IDS, or admin)   → /dungeon, /release, /kick, /warn, /note, /evidence, /audit
import path from "node:path";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import { parseDuration, formatDuration, ACTION_LABELS } from "../format.js";

const COLORS = {
  ban: 0xd64550,
  unban: 0x3f9e6e,
  kick: 0xe08a3c,
  warn: 0xd9b23c,
  note: 0x6b7a8f,
  dungeon: 0x9085e9,
  release: 0x3f9e6e,
  report: 0xd64550,
  audit: 0x5865f2,
  error: 0x99332e,
};

const SENIOR_ONLY = new Set(["ban", "unban", "ticketpanel"]);
const EPHEMERAL_DEFER = new Set(["ticketpanel"]);

const EVIDENCE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".mp4", ".mov", ".webm", ".mkv", ".avi",
]);

const userOption = (o) =>
  o
    .setName("user")
    .setDescription("Roblox username, user ID, or profile link")
    .setRequired(true);

const evidenceOptions = (builder) =>
  builder
    .addAttachmentOption((o) =>
      o.setName("evidence").setDescription("Attach an image or video as evidence")
    )
    .addStringOption((o) =>
      o.setName("evidence_link").setDescription("Link to video evidence (YouTube, Medal, Streamable…)")
    );

export function buildDefinitions() {
  return [
    evidenceOptions(
      new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a player from the game (senior staff only)")
        .addStringOption(userOption)
        .addStringOption((o) =>
          o.setName("reason").setDescription("Why (kept internal, logged)").setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("duration")
            .setDescription('How long — e.g. 30m, 2h, 7d, 1w. Leave empty for permanent.')
        )
        .addStringOption((o) =>
          o
            .setName("display_reason")
            .setDescription("Message the banned player sees (defaults to the reason)")
        )
        .addBooleanOption((o) =>
          o
            .setName("include_alts")
            .setDescription("Also ban suspected alt accounts (default: yes)")
        )
    ),
    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("Lift a player's ban (senior staff only)")
      .addStringOption(userOption)
      .addStringOption((o) => o.setName("reason").setDescription("Why the ban is lifted")),
    evidenceOptions(
      new SlashCommandBuilder()
        .setName("dungeon")
        .setDescription("Send a player to the dungeon servers")
        .addStringOption(userOption)
        .addStringOption((o) =>
          o
            .setName("duration")
            .setDescription("How long they stay in the dungeon")
            .setRequired(true)
            .addChoices(
              { name: "1 minute", value: "1m" },
              { name: "1 hour", value: "1h" },
              { name: "1 day", value: "1d" },
              { name: "1 week", value: "1w" },
              { name: "Permanent", value: "permanent" }
            )
        )
        .addStringOption((o) =>
          o.setName("reason").setDescription("What they did").setRequired(true)
        )
    ),
    new SlashCommandBuilder()
      .setName("release")
      .setDescription("Release a player from the dungeon early")
      .addStringOption(userOption)
      .addStringOption((o) => o.setName("reason").setDescription("Why they're being released")),
    evidenceOptions(
      new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a player from the server they're in right now")
        .addStringOption(userOption)
        .addStringOption((o) => o.setName("reason").setDescription("Why (shown to the player)"))
    ),
    evidenceOptions(
      new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Log a warning for a player")
        .addStringOption(userOption)
        .addStringOption((o) =>
          o.setName("reason").setDescription("What they did").setRequired(true)
        )
    ),
    evidenceOptions(
      new SlashCommandBuilder()
        .setName("note")
        .setDescription("Attach a staff note to a player's record")
        .addStringOption(userOption)
        .addStringOption((o) =>
          o.setName("text").setDescription("The note").setRequired(true)
        )
    ),
    new SlashCommandBuilder()
      .setName("evidence")
      .setDescription("Add evidence to a player's record")
      .addStringOption(userOption)
      .addAttachmentOption((o) =>
        o.setName("file").setDescription("Image or video evidence")
      )
      .addStringOption((o) =>
        o.setName("link").setDescription("Link to video evidence")
      )
      .addStringOption((o) =>
        o.setName("context").setDescription("What this evidence shows")
      ),
    new SlashCommandBuilder()
      .setName("audit")
      .setDescription("Look up a player's full moderation history")
      .addStringOption(userOption),
    new SlashCommandBuilder()
      .setName("ticketpanel")
      .setDescription("Post the ticket panel (User Report / Support Ticket buttons) in this channel"),
    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Close this ticket. Report tickets need reporter + player (+ evidence).")
      .addUserOption((o) =>
        o.setName("reporter").setDescription("Report tickets: the Discord user who reported")
      )
      .addStringOption((o) =>
        o.setName("player").setDescription("Report tickets: Roblox username of the reported player")
      )
      .addAttachmentOption((o) =>
        o.setName("evidence").setDescription("Image or video evidence")
      )
      .addStringOption((o) =>
        o.setName("evidence_link").setDescription("Link to video evidence")
      )
      .addStringOption((o) =>
        o.setName("notes").setDescription("What was found / decided")
      ),
  ].map((c) => c.setDefaultMemberPermissions(PermissionFlagsBits.KickMembers).toJSON());
}

export function buildHandlers({ queries, roblox, config, service, tickets }) {
  const hasAnyRole = (member, roleIds) => {
    const roles = member?.roles?.cache;
    return roleIds.some((id) => roles?.has?.(id));
  };
  const isAdmin = (member) =>
    Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));

  function isSenior(member) {
    if (!member) return false;
    return isAdmin(member) || hasAnyRole(member, config.discord.seniorRoleIds);
  }
  function isMod(member) {
    if (!member) return false;
    return isSenior(member) || hasAnyRole(member, config.discord.modRoleIds);
  }

  const moderatorOf = (interaction) => ({
    id: interaction.user.id,
    name: interaction.user.username,
    via: "discord",
  });

  async function resolveOrFail(interaction, query) {
    const player = await service.resolvePlayer(query);
    if (!player) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.error)
            .setDescription(`Couldn't find a Roblox user matching **${query}**.`),
        ],
      });
      return null;
    }
    return player;
  }

  function playerLine(player) {
    const display =
      player.displayName && player.displayName !== player.name
        ? `${player.displayName} (@${player.name})`
        : `@${player.name}`;
    return `[${display}](https://www.roblox.com/users/${player.id}/profile) · \`${player.id}\``;
  }

  const dashboardLink = (userId) => `${config.web.baseUrl}/#/user/${userId}`;

  /* ── evidence (Discord attachments/links → service) ────── */

  async function collectEvidence(actionId, { attachment, link, uploadedBy }) {
    const parts = [];
    const problems = [];

    if (attachment) {
      const maxBytes = config.evidence.maxMb * 1024 * 1024;
      const ext = path.extname(attachment.name || "").toLowerCase();
      const typeOk =
        (attachment.contentType &&
          (attachment.contentType.startsWith("image/") ||
            attachment.contentType.startsWith("video/"))) ||
        EVIDENCE_EXTENSIONS.has(ext);
      if (!typeOk) {
        problems.push("attachment skipped — only images and videos are accepted");
      } else if (attachment.size > maxBytes) {
        problems.push(`attachment skipped — larger than ${config.evidence.maxMb}MB`);
      } else {
        try {
          // Discord CDN links expire, so pull the bytes down now and keep them.
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          const buffer = Buffer.from(await res.arrayBuffer());
          await service.addEvidenceFile(actionId, {
            buffer,
            originalName: attachment.name,
            contentType: attachment.contentType,
            uploadedBy,
          });
          parts.push(`1 file (${attachment.name ?? "attachment"})`);
        } catch (err) {
          console.error("Evidence download failed:", err);
          problems.push("attachment couldn't be saved — try /evidence again in a moment");
        }
      }
    }

    if (link) {
      if (/^https?:\/\/\S+$/i.test(link) && link.length <= 500) {
        service.addEvidenceLink(actionId, { url: link, uploadedBy });
        parts.push("1 link");
      } else {
        problems.push("evidence link skipped — must be a valid http(s) URL");
      }
    }

    return { parts, problems };
  }

  const evidenceFromOptions = (interaction) => ({
    attachment: interaction.options.getAttachment("evidence"),
    link: interaction.options.getString("evidence_link"),
    uploadedBy: interaction.user.id,
  });

  function evidenceFields({ parts, problems }) {
    const fields = [];
    if (parts.length) fields.push({ name: "Evidence", value: parts.join(" · "), inline: true });
    for (const p of problems) fields.push({ name: "Evidence problem", value: p });
    return fields;
  }

  /* ── embeds / logging ─────────────────────────────────── */

  function actionEmbed({ type, player, fields, moderator }) {
    const embed = new EmbedBuilder()
      .setColor(COLORS[type])
      .setAuthor({ name: ACTION_LABELS[type] })
      .setDescription(playerLine(player))
      .setTimestamp(new Date())
      .setFooter({ text: `by ${moderator.displayName ?? moderator.user.username}` });
    if (player.avatarUrl) embed.setThumbnail(player.avatarUrl);
    if (fields?.length) embed.addFields(fields);
    return embed;
  }

  async function postToLogChannel(interaction, embed) {
    const channelId = config.discord.logChannelId;
    if (!channelId || interaction.channelId === channelId) return;
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn("Couldn't post to log channel:", err.message);
    }
  }

  async function finish(interaction, embed) {
    await interaction.editReply({ embeds: [embed] });
    await postToLogChannel(interaction, embed);
  }

  /* ── handlers ─────────────────────────────────────────── */

  const handlers = {
    async ban(interaction) {
      const query = interaction.options.getString("user", true);
      const reason = interaction.options.getString("reason", true);
      const durationInput = interaction.options.getString("duration");
      const displayReason = interaction.options.getString("display_reason") || reason;
      const includeAlts = interaction.options.getBoolean("include_alts") ?? true;

      let durationSeconds;
      try {
        durationSeconds = parseDuration(durationInput);
      } catch (err) {
        return interaction.editReply({ content: err.message });
      }

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const { actionId } = await service.ban(player, {
        reason,
        displayReason,
        durationSeconds,
        includeAlts,
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, evidenceFromOptions(interaction));

      await finish(interaction, actionEmbed({
        type: "ban",
        player,
        moderator: interaction.member,
        fields: [
          { name: "Duration", value: formatDuration(durationSeconds), inline: true },
          { name: "Alt accounts", value: includeAlts ? "Included" : "Not included", inline: true },
          ...evidenceFields(ev),
          { name: "Reason", value: reason },
          ...(displayReason !== reason
            ? [{ name: "Shown to player", value: displayReason }]
            : []),
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async unban(interaction) {
      const query = interaction.options.getString("user", true);
      const reason = interaction.options.getString("reason") || null;

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      await service.unban(player, { reason, moderator: moderatorOf(interaction) });

      await finish(interaction, actionEmbed({
        type: "unban",
        player,
        moderator: interaction.member,
        fields: [
          ...(reason ? [{ name: "Reason", value: reason }] : []),
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async dungeon(interaction) {
      const query = interaction.options.getString("user", true);
      const durationChoice = interaction.options.getString("duration", true);
      const reason = interaction.options.getString("reason", true);

      const durationSeconds = parseDuration(durationChoice); // null = permanent
      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const { actionId } = await service.dungeon(player, {
        durationSeconds,
        reason,
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, evidenceFromOptions(interaction));

      await finish(interaction, actionEmbed({
        type: "dungeon",
        player,
        moderator: interaction.member,
        fields: [
          { name: "Duration", value: formatDuration(durationSeconds), inline: true },
          ...evidenceFields(ev),
          { name: "Reason", value: reason },
          {
            name: "What happens",
            value:
              "Moved to a dungeon server now if they're in game; routed there on every join until the sentence ends.",
          },
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async release(interaction) {
      const query = interaction.options.getString("user", true);
      const reason = interaction.options.getString("reason") || null;

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      await service.release(player, { reason, moderator: moderatorOf(interaction) });

      await finish(interaction, actionEmbed({
        type: "release",
        player,
        moderator: interaction.member,
        fields: [
          ...(reason ? [{ name: "Reason", value: reason }] : []),
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async kick(interaction) {
      const query = interaction.options.getString("user", true);
      const reason = interaction.options.getString("reason") || null;

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const { actionId } = await service.kick(player, {
        reason,
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, evidenceFromOptions(interaction));

      await finish(interaction, actionEmbed({
        type: "kick",
        player,
        moderator: interaction.member,
        fields: [
          ...(reason ? [{ name: "Reason", value: reason }] : []),
          ...evidenceFields(ev),
          { name: "Note", value: "Kicks only land if the player is in a server right now." },
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async warn(interaction) {
      const query = interaction.options.getString("user", true);
      const reason = interaction.options.getString("reason", true);

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const { actionId } = service.warn(player, {
        reason,
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, evidenceFromOptions(interaction));

      const warnCount =
        queries.userCounts(player.id).find((c) => c.type === "warn")?.count ?? 1;
      await finish(interaction, actionEmbed({
        type: "warn",
        player,
        moderator: interaction.member,
        fields: [
          { name: "Reason", value: reason },
          { name: "Warnings on record", value: String(warnCount), inline: true },
          ...evidenceFields(ev),
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async note(interaction) {
      const query = interaction.options.getString("user", true);
      const text = interaction.options.getString("text", true);

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const { actionId } = service.note(player, {
        text,
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, evidenceFromOptions(interaction));

      await finish(interaction, actionEmbed({
        type: "note",
        player,
        moderator: interaction.member,
        fields: [
          { name: "Note", value: text },
          ...evidenceFields(ev),
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async evidence(interaction) {
      const query = interaction.options.getString("user", true);
      const attachment = interaction.options.getAttachment("file");
      const link = interaction.options.getString("link");
      const context = interaction.options.getString("context");

      if (!attachment && !link) {
        return interaction.editReply({
          content: "Attach a file or provide a link — otherwise there's no evidence to add.",
        });
      }

      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const { actionId } = service.note(player, {
        text: context || "Evidence added",
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, {
        attachment,
        link,
        uploadedBy: interaction.user.id,
      });

      await finish(interaction, actionEmbed({
        type: "note",
        player,
        moderator: interaction.member,
        fields: [
          ...(context ? [{ name: "Context", value: context }] : []),
          ...evidenceFields(ev),
          { name: "Record", value: dashboardLink(player.id) },
        ],
      }));
    },

    async ticketpanel(interaction) {
      await tickets.postPanel(interaction.channel);
      await interaction.editReply({ content: "Ticket panel posted." });
    },

    async close(interaction) {
      const ticket = queries.ticketByChannel(interaction.channelId);
      if (!ticket) {
        return interaction.editReply({
          content: "This isn't a ticket channel — run /close inside the ticket you want to close.",
        });
      }
      if (ticket.status !== "open") {
        return interaction.editReply({ content: "This ticket is already closed." });
      }

      const closedBy = {
        id: interaction.user.id,
        name: interaction.user.username,
        mention: `<@${interaction.user.id}>`,
        via: "discord",
      };

      if (ticket.kind === "support") {
        await tickets.finalizeClose({ ticket, closedBy });
        return interaction.editReply({ content: "Support ticket closed." });
      }

      // User-report ticket: the close IS the paperwork.
      const reporter = interaction.options.getUser("reporter");
      const playerQuery = interaction.options.getString("player");
      const attachment = interaction.options.getAttachment("evidence");
      const link = interaction.options.getString("evidence_link");
      const notes = interaction.options.getString("notes");

      const missing = [];
      if (!reporter) missing.push("`reporter` — the Discord user who reported");
      if (!playerQuery) missing.push("`player` — the reported player's Roblox username");
      if (missing.length) {
        return interaction.editReply({
          content:
            "Report tickets can only be closed with the details filled in. Missing:\n" +
            missing.map((m) => `• ${m}`).join("\n") +
            "\nAdd `evidence` (or `evidence_link`) too if you have it.",
        });
      }

      const player = await resolveOrFail(interaction, playerQuery);
      if (!player) return;

      const reasonParts = [
        `Player report (ticket #${ticket.id}) — reporter: ${reporter.username} (${reporter.id}).`,
        `Reported in ticket: "${ticket.subject ?? "?"}"`,
      ];
      if (notes) reasonParts.push(`Outcome: ${notes}`);
      const { actionId } = service.report(player, {
        reason: reasonParts.join(" "),
        moderator: moderatorOf(interaction),
      });
      const ev = await collectEvidence(actionId, {
        attachment,
        link,
        uploadedBy: interaction.user.id,
      });

      await tickets.finalizeClose({
        ticket,
        closedBy,
        closeActionId: actionId,
        fields: [
          { name: "Reporter", value: `<@${reporter.id}>`, inline: true },
          { name: "Reported player", value: playerLine(player), inline: true },
          ...(notes ? [{ name: "Outcome", value: notes }] : []),
          ...evidenceFields(ev),
        ],
      });

      await interaction.editReply({
        embeds: [
          actionEmbed({
            type: "report",
            player,
            moderator: interaction.member,
            fields: [
              { name: "Reporter", value: `<@${reporter.id}> (${reporter.id})`, inline: true },
              ...(notes ? [{ name: "Outcome", value: notes }] : []),
              ...evidenceFields(ev),
              { name: "Filed on record", value: dashboardLink(player.id) },
            ],
          }),
        ],
      });
    },

    async audit(interaction) {
      const query = interaction.options.getString("user", true);
      const player = await resolveOrFail(interaction, query);
      if (!player) return;

      const [history, counts, localBan, liveRestriction, liveSentence] = await Promise.all([
        Promise.resolve(queries.userHistory(player.id)),
        Promise.resolve(queries.userCounts(player.id)),
        Promise.resolve(queries.currentBan(player.id)),
        roblox.getRestriction(player.id).catch(() => undefined), // undefined = couldn't check
        roblox.getDungeonSentence(player.id).catch(() => undefined),
      ]);

      const countFor = (t) => counts.find((c) => c.type === t)?.count ?? 0;
      const summary = ["ban", "dungeon", "kick", "warn", "note"]
        .map((t) => `${countFor(t)} ${t}${countFor(t) === 1 ? "" : "s"}`)
        .join(" · ");

      let banStatus;
      if (liveRestriction === undefined) {
        banStatus = localBan?.active ? "Banned (per local records)" : "Not banned (per local records)";
      } else if (liveRestriction?.active) {
        banStatus = liveRestriction.duration
          ? `Banned — expires ${formatDuration(parseInt(liveRestriction.duration, 10))} after it was applied`
          : "Banned — permanent";
      } else {
        banStatus = "Not banned";
      }

      let dungeonStatus;
      if (liveSentence === undefined) {
        const local = queries.currentDungeon(player.id);
        dungeonStatus = local?.active ? "In the dungeon (per local records)" : "Not in the dungeon (per local records)";
      } else if (
        liveSentence &&
        (liveSentence.permanent === true ||
          (typeof liveSentence.expiresAt === "number" &&
            liveSentence.expiresAt > Math.floor(Date.now() / 1000)))
      ) {
        dungeonStatus = liveSentence.permanent
          ? "In the dungeon — permanent"
          : `In the dungeon — until <t:${liveSentence.expiresAt}:f>`;
      } else {
        dungeonStatus = "Not in the dungeon";
      }

      const recent = history.slice(0, 5).map((a) => {
        const ts = Math.floor(new Date(a.created_at).getTime() / 1000);
        const extra =
          a.type === "ban" || a.type === "dungeon"
            ? ` (${formatDuration(a.duration_seconds)})`
            : "";
        const evNote = a.evidence?.length ? ` · ${a.evidence.length} evidence` : "";
        return `**${ACTION_LABELS[a.type]}**${extra} — ${a.reason ?? "no reason"} · by ${a.moderator_name}${evNote} · <t:${ts}:R>`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.audit)
        .setAuthor({ name: "Audit" })
        .setDescription(playerLine(player))
        .addFields(
          { name: "Game ban", value: banStatus, inline: true },
          { name: "Dungeon", value: dungeonStatus, inline: true },
          { name: "Record", value: summary, inline: false },
          ...(player.createdOn
            ? [{
                name: "Account created",
                value: `<t:${Math.floor(new Date(player.createdOn).getTime() / 1000)}:D>`,
                inline: true,
              }]
            : []),
          {
            name: `History${history.length > 5 ? ` (latest 5 of ${history.length})` : ""}`,
            value: recent.length ? recent.join("\n") : "Clean — nothing on file.",
          },
          { name: "Full record", value: dashboardLink(player.id) }
        )
        .setTimestamp(new Date());
      if (player.avatarUrl) embed.setThumbnail(player.avatarUrl);

      await interaction.editReply({ embeds: [embed] });
    },
  };

  return {
    isMod,
    isSenior,
    async dispatch(interaction) {
      const handler = handlers[interaction.commandName];
      if (!handler) return;

      const needsSenior = SENIOR_ONLY.has(interaction.commandName);
      const allowed = needsSenior ? isSenior(interaction.member) : isMod(interaction.member);
      if (!allowed) {
        return interaction.reply({
          content: needsSenior
            ? "Banning is limited to senior staff. Use /dungeon for regular moderation."
            : "You don't have a moderator role, so you can't use this.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply(
        EPHEMERAL_DEFER.has(interaction.commandName)
          ? { flags: MessageFlags.Ephemeral }
          : {}
      );
      try {
        await handler(interaction);
      } catch (err) {
        console.error(`/${interaction.commandName} failed:`, err);
        const embed = new EmbedBuilder()
          .setColor(COLORS.error)
          .setDescription(
            `Something went wrong: ${err.message ?? "unknown error"}\n` +
              (err.status === 401 || err.status === 403
                ? "Check that the Roblox API key is valid and has the right permissions for this universe."
                : "")
          );
        await interaction.editReply({ embeds: [embed] }).catch(() => {});
      }
    },
  };
}
