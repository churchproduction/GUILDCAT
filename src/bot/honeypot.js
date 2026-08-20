// Honeypot (fake remote) catches.
//
// The game has bait RemoteEvents no honest player can ever reach. When an
// exploiter fires one, the game posts here → an embed lands in
// HONEYPOT_CHANNEL_ID and STACKS. One button — allowed only for the roles in
// HONEYPOT_ADMIN_ROLE_IDS (plus the server owner) — dungeons everyone in the
// stack at once, files a "Dungeon" entry on each record with the auto reason,
// and attaches what they fired as text evidence.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { joinServerUrl, formatDuration, parseDuration, clamp } from "../format.js";

export function createHoneypot({ client, config, queries, service, roblox }) {
  let sentenceSeconds = null; // permanent by default
  try {
    sentenceSeconds = parseDuration(config.honeypot.sentence);
  } catch {
    console.warn(`Bad HONEYPOT_SENTENCE "${config.honeypot.sentence}" — using permanent.`);
  }

  const canPunish = (interaction) => {
    if (interaction.guild?.ownerId === interaction.user.id) return true;
    return config.honeypot.adminRoleIds.some((id) =>
      interaction.member?.roles?.cache?.has?.(id)
    );
  };

  const punishRow = (count) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("wardenHoney:punish")
        .setLabel(`Send all ${count} to the dungeon`)
        .setStyle(ButtonStyle.Danger)
    );

  /* ── a new catch arrives (called by the web server) ──────
     One channel message per player until they're punished. Tracked in memory
     so a missed post (bot restart, perms fixed later) self-heals — the next
     hit re-posts instead of the player being stuck silently in the stack. */
  const posted = new Set(); // user ids that currently have a live message

  async function postHit(hit) {
    if (!config.honeypot.channelId) {
      console.warn("[trap] HONEYPOT_CHANNEL_ID is not set — hit stored but not posted");
      return;
    }
    if (posted.has(hit.user_id)) return; // already showing a message for them
    try {
      const channel = await client.channels.fetch(config.honeypot.channelId);
      if (!channel?.isTextBased()) {
        console.warn(`[trap] channel ${config.honeypot.channelId} isn't a text channel the bot can post to`);
        return;
      }
      const avatarUrl = await roblox.getHeadshotUrl(hit.user_id).catch(() => null);
      console.log(`[trap] posting hit to #${channel.name ?? config.honeypot.channelId}`);

      const pendingUsers = queries.pendingHoneypotUserCount();
      const join = joinServerUrl(hit.place_id, hit.job_id);

      const embed = new EmbedBuilder()
        .setColor(0xd64550)
        .setTitle("Honeypot tripped")
        .setDescription(
          `**[${hit.username}](https://www.roblox.com/users/${hit.user_id}/profile)** \`${hit.user_id}\` ` +
            `fired a fake remote — there is no honest way to do that.`
        )
        .addFields(
          { name: "Remote", value: `\`${hit.remote_name}\``, inline: true },
          ...(hit.total ? [{ name: "Traps fired all-time", value: String(hit.total), inline: true }] : []),
          ...(hit.job_id ? [{ name: "Server", value: `\`${hit.job_id}\``, inline: true }] : []),
          ...(hit.args ? [{ name: "What they sent", value: clamp(hit.args, 900) }] : []),
          { name: "Record", value: `${config.web.baseUrl}/#/user/${hit.user_id}`, inline: true },
          {
            name: "Waiting for judgment",
            value: `**${pendingUsers}** player${pendingUsers === 1 ? "" : "s"} in the stack · sentence: **${formatDuration(sentenceSeconds)}**`,
          }
        )
        .setTimestamp(new Date());
      if (avatarUrl) embed.setThumbnail(avatarUrl);

      const rows = [punishRow(pendingUsers)];
      if (join) {
        rows[0].addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Join their server").setURL(join)
        );
      }

      await channel.send({ embeds: [embed], components: rows });
      posted.add(hit.user_id);
    } catch (err) {
      console.warn("Couldn't post honeypot hit:", err.message);
    }
  }

  /* ── the button: dungeon the whole stack ───────────────── */

  async function handleInteraction(interaction) {
    if (!interaction.isButton() || interaction.customId !== "wardenHoney:punish") return false;

    if (!canPunish(interaction)) {
      await interaction.reply({
        content: "Only the owner and the honeypot admin roles can pass this judgment.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const hits = queries.pendingHoneypotHits();
    if (!hits.length) {
      await interaction.reply({ content: "The stack is empty — everyone's been dealt with.", flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply();

    // Group the stack by player (one sentence each, all their hits as evidence).
    const byUser = new Map();
    for (const h of hits) {
      if (!byUser.has(h.user_id)) byUser.set(h.user_id, []);
      byUser.get(h.user_id).push(h);
    }

    const moderator = { id: interaction.user.id, name: interaction.user.username, via: "discord" };
    const done = [];
    const failed = [];

    for (const [userId, userHits] of byUser) {
      const username = userHits[userHits.length - 1].username;
      const remotes = [...new Set(userHits.map((h) => h.remote_name))].join(", ");
      try {
        const { actionId } = await service.dungeon(
          { id: userId, name: username, displayName: null, avatarUrl: null },
          {
            durationSeconds: sentenceSeconds,
            reason: `Caught by the honeypot — fired fake remote event(s): ${remotes}. Auto-punished from the exploit stack.`,
            moderator,
          }
        );
        // Everything they fired, saved as text evidence on the record.
        const lines = userHits.map((h) =>
          `[${h.created_at}] remote "${h.remote_name}" · server ${h.job_id ?? "?"}` +
          (h.total ? ` · running total ${h.total}` : "") +
          (h.args ? `\n  sent: ${h.args}` : "")
        );
        await service.addEvidenceFile(actionId, {
          buffer: Buffer.from(
            `HONEYPOT EVIDENCE — ${username} (${userId})\n` +
            `${userHits.length} catch${userHits.length === 1 ? "" : "es"}\n\n` +
            lines.join("\n\n"),
            "utf8"
          ),
          originalName: `honeypot-${userId}.txt`,
          contentType: "text/plain",
          uploadedBy: interaction.user.id,
        });
        done.push(`[${username}](https://www.roblox.com/users/${userId}/profile) — ${userHits.length} catch${userHits.length === 1 ? "" : "es"}`);
      } catch (err) {
        console.error("Honeypot punish failed for", userId, err);
        failed.push(`${username} (${userId}) — ${err.message ?? "error"}`);
      }
    }

    queries.markHoneypotPunished(interaction.user.username);
    posted.clear(); // stack cleared → fresh messages for anyone caught next

    const embed = new EmbedBuilder()
      .setColor(done.length ? 0x9085e9 : 0x99332e)
      .setTitle("Judgment passed")
      .setDescription(
        (done.length
          ? `Sent **${done.length}** player${done.length === 1 ? "" : "s"} to the dungeon (**${formatDuration(sentenceSeconds)}**):\n` +
            clamp(done.join("\n"), 3000)
          : "Nobody could be punished.") +
        (failed.length ? `\n\n**Failed:**\n${clamp(failed.join("\n"), 800)}` : "")
      )
      .setFooter({ text: `by ${interaction.user.username}` })
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  return { postHit, handleInteraction };
}
