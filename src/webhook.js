// Audit webhooks — every moderation action gets posted to Discord.
// Two separate feeds: actions run via Discord commands, and actions taken
// on the website. Configure one or both; unset = that feed is off.
import { formatDuration, ACTION_LABELS } from "./format.js";

const COLORS = {
  ban: 0xd64550,
  unban: 0x3f9e6e,
  kick: 0xe08a3c,
  warn: 0xd9b23c,
  note: 0x6b7a8f,
  dungeon: 0x9085e9,
  release: 0x3f9e6e,
  report: 0xd64550,
  delete: 0x99332e,
};

export function createAuditWebhooks(config) {
  const urls = {
    discord: config.webhooks.discord,
    web: config.webhooks.web,
  };

  async function post(source, event) {
    const url = urls[source];
    if (!url) return;

    const embed = {
      color: COLORS[event.type] ?? 0x5865f2,
      timestamp: new Date().toISOString(),
      footer: { text: source === "web" ? "via the website" : "via Discord" },
    };

    if (event.type === "ticket_close") {
      embed.author = { name: "Ticket closed" };
      embed.description =
        `**${event.ticket?.kind === "report" ? "User report" : "Support ticket"} #${event.ticket?.id}** — ` +
        `opened by ${event.ticket?.opener_tag ?? "?"}`;
      embed.fields = [
        { name: "Closed by", value: `${event.moderator.name} (<@${event.moderator.id}>)`, inline: true },
      ];
    } else if (event.type === "report_handled") {
      embed.author = { name: "In-game report handled" };
      embed.description =
        `**${event.report?.reporter_name}** reported ` +
        `[${event.report?.target_name}](https://www.roblox.com/users/${event.report?.target_user_id}/profile) — marked handled.`;
      embed.fields = [
        ...(event.report?.reason
          ? [{ name: "Report", value: String(event.report.reason).slice(0, 900) }]
          : []),
        { name: "Handled by", value: `${event.moderator.name} (<@${event.moderator.id}>)`, inline: true },
      ];
    } else if (event.type === "delete") {
      embed.author = { name: "Log entry deleted" };
      embed.description =
        `**${ACTION_LABELS[event.deleted?.type] ?? event.deleted?.type ?? "entry"}** on ` +
        `[${event.deleted?.username ?? "unknown"}](https://www.roblox.com/users/${event.deleted?.user_id}/profile) ` +
        `\`${event.deleted?.user_id ?? "?"}\``;
      embed.fields = [
        ...(event.deleted?.reason
          ? [{ name: "Original reason", value: String(event.deleted.reason).slice(0, 900) }]
          : []),
        ...(event.deleted?.moderator_name
          ? [{ name: "Originally by", value: event.deleted.moderator_name, inline: true }]
          : []),
        { name: "Deleted by", value: `${event.moderator.name} (<@${event.moderator.id}>)`, inline: true },
      ];
    } else {
      embed.author = { name: ACTION_LABELS[event.type] ?? event.type };
      embed.description =
        `[${event.player.displayName && event.player.displayName !== event.player.name
          ? `${event.player.displayName} (@${event.player.name})`
          : `@${event.player.name}`}](https://www.roblox.com/users/${event.player.id}/profile) \`${event.player.id}\`` +
        ` · [record](${config.web.baseUrl}/#/user/${event.player.id})`;
      if (event.player.avatarUrl) embed.thumbnail = { url: event.player.avatarUrl };
      embed.fields = [
        ...(event.type === "ban" || event.type === "dungeon"
          ? [{ name: "Duration", value: formatDuration(event.durationSeconds), inline: true }]
          : []),
        ...(event.type === "ban"
          ? [{ name: "Alt accounts", value: event.includeAlts ? "Included" : "Not included", inline: true }]
          : []),
        { name: "By", value: `${event.moderator.name} (<@${event.moderator.id}>)`, inline: true },
        ...(event.reason
          ? [{ name: event.type === "note" ? "Note" : "Reason", value: String(event.reason).slice(0, 900) }]
          : []),
      ];
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Warden Audit",
          embeds: [embed],
        }),
      });
      if (!res.ok) {
        console.warn(`Audit webhook (${source}) rejected: ${res.status}`);
      }
    } catch (err) {
      console.warn(`Audit webhook (${source}) failed:`, err.message);
    }
  }

  // fire-and-forget wrapper so a slow webhook never slows an action
  return (source, event) => { post(source, event); };
}
