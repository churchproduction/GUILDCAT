// Moderation service — the single place actions actually happen.
// Both the Discord slash commands and the web dashboard call these,
// so the rules and the paper trail are identical everywhere.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isoPlusSeconds, clamp } from "./format.js";

export function createModerationService({ queries, roblox, config, audit }) {
  // Post to the right audit feed. moderator.via is "discord" or "web".
  const emit = (moderator, event) => {
    try { audit?.(moderator.via ?? "discord", { ...event, moderator }); } catch {}
  };

  /** Resolve query (username/id/url) and enrich with avatar + join date. */
  async function resolvePlayer(query) {
    const found = await roblox.resolveUser(query);
    if (!found) return null;
    const [avatarUrl, info] = await Promise.all([
      roblox.getHeadshotUrl(found.id).catch(() => null),
      roblox.getUserInfo(found.id).catch(() => null),
    ]);
    return {
      ...found,
      avatarUrl,
      createdOn: info?.created ?? null,
      displayName: found.displayName ?? info?.displayName ?? null,
    };
  }

  return {
    resolvePlayer,

    /** Platform-level Roblox ban. durationSeconds null = permanent. */
    async ban(player, { reason, displayReason, durationSeconds, includeAlts, moderator }) {
      await roblox.banUser(player.id, {
        durationSeconds,
        privateReason: reason,
        displayReason,
        excludeAltAccounts: includeAlts,
      });
      const expiresAt = durationSeconds ? isoPlusSeconds(durationSeconds) : null;
      const actionId = queries.recordAction(
        {
          type: "ban",
          user_id: player.id,
          username: player.name,
          reason,
          display_reason: displayReason,
          duration_seconds: durationSeconds,
          expires_at: expiresAt,
          exclude_alts: includeAlts ? 1 : 0,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "ban", player, reason, durationSeconds, includeAlts });
      return { actionId, expiresAt };
    },

    async unban(player, { reason, moderator }) {
      await roblox.unbanUser(player.id);
      const actionId = queries.recordAction(
        {
          type: "unban",
          user_id: player.id,
          username: player.name,
          reason,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "unban", player, reason });
      return { actionId };
    },

    /** Dungeon sentence: DataStore write + live move + record. */
    async dungeon(player, { durationSeconds, reason, moderator }) {
      const expiresAtUnix = durationSeconds
        ? Math.floor(Date.now() / 1000) + durationSeconds
        : null;
      await roblox.setDungeonSentence(player.id, {
        expiresAtUnix,
        reason,
        moderator: moderator.name,
      });
      try {
        await roblox.publishDungeonMove("send", player.id, { expiresAtUnix, reason });
      } catch (err) {
        console.warn("Dungeon live-move publish failed (sentence still saved):", err.message);
      }
      const actionId = queries.recordAction(
        {
          type: "dungeon",
          user_id: player.id,
          username: player.name,
          reason,
          duration_seconds: durationSeconds,
          expires_at: durationSeconds ? isoPlusSeconds(durationSeconds) : null,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "dungeon", player, reason, durationSeconds });
      return { actionId };
    },

    async release(player, { reason, moderator }) {
      await roblox.clearDungeonSentence(player.id);
      try {
        await roblox.publishDungeonMove("release", player.id, {});
      } catch (err) {
        console.warn("Release publish failed (sentence still cleared):", err.message);
      }
      const actionId = queries.recordAction(
        {
          type: "release",
          user_id: player.id,
          username: player.name,
          reason,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "release", player, reason });
      return { actionId };
    },

    async kick(player, { reason, moderator }) {
      await roblox.kickUser(player.id, reason);
      const actionId = queries.recordAction(
        {
          type: "kick",
          user_id: player.id,
          username: player.name,
          reason,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "kick", player, reason });
      return { actionId };
    },

    warn(player, { reason, moderator }) {
      const actionId = queries.recordAction(
        {
          type: "warn",
          user_id: player.id,
          username: player.name,
          reason,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "warn", player, reason });
      return { actionId };
    },

    note(player, { text, moderator }) {
      const actionId = queries.recordAction(
        {
          type: "note",
          user_id: player.id,
          username: player.name,
          reason: text,
          moderator_id: moderator.id,
          moderator_name: moderator.name,
        },
        player
      );
      emit(moderator, { type: "note", player, reason: text });
      return { actionId };
    },

    /** Store downloaded bytes as evidence on an action. */
    async addEvidenceFile(actionId, { buffer, originalName, contentType, uploadedBy }) {
      await fs.mkdir(config.evidence.dir, { recursive: true });
      const ext = path.extname(originalName || "").toLowerCase() || ".bin";
      const fileName = `${actionId}-${crypto.randomUUID()}${ext}`;
      await fs.writeFile(path.join(config.evidence.dir, fileName), buffer);
      queries.insertEvidence({
        action_id: actionId,
        kind: "file",
        file_name: fileName,
        original_name: originalName ?? fileName,
        content_type: contentType ?? null,
        size_bytes: buffer.length,
        uploaded_by: uploadedBy,
      });
      return fileName;
    },

    addEvidenceLink(actionId, { url, uploadedBy }) {
      queries.insertEvidence({
        action_id: actionId,
        kind: "link",
        url: clamp(url, 500),
        uploaded_by: uploadedBy,
      });
    },

    /**
     * Delete a log entry (and its evidence). Refuses while the entry backs an
     * ACTIVE ban or dungeon sentence — lift it first so records match reality.
     * Returns { ok, blocked?, evidenceFiles? }.
     */
    async deleteAction(actionId, moderator) {
      const deleted = queries.getAction(actionId); // grab details BEFORE it's gone
      const result = queries.deleteAction(actionId);
      if (!result.ok) return result;
      // best-effort disk cleanup after the DB commit
      for (const fileName of result.evidenceFiles) {
        fs.unlink(path.join(config.evidence.dir, fileName)).catch(() => {});
      }
      if (moderator) emit(moderator, { type: "delete", deleted });
      return result;
    },
  };
}
