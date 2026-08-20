// Roblox Open Cloud client.
//
// Bans/unbans — User Restrictions API (real platform-level game bans):
//   PATCH https://apis.roblox.com/cloud/v2/universes/{universe}/user-restrictions/{userId}
//   API key permission: User Restrictions read + write.
//   Applying a ban also removes the player from live servers — Roblox handles that.
//
// Kicks & live dungeon moves — Open Cloud messaging:
//   POST https://apis.roblox.com/cloud/v2/universes/{universe}:publishMessage
//   API key permission: Messaging Service publish.
//   Game scripts in roblox/ subscribe and act on the message.
//
// Dungeon sentences — Standard DataStores v1 API, so the game can check a
// player's status the moment they join (works even if they join days later):
//   {POST|GET|DELETE} https://apis.roblox.com/datastores/v1/universes/{universe}
//     /standard-datastores/datastore/entries/entry?datastoreName=X&entryKey=Y
//   API key permission: DataStores (read/write/delete entries).
//
// Username lookup and avatars use the public users/thumbnails APIs (no key).
import crypto from "node:crypto";
import { clamp } from "./format.js";

const CLOUD = "https://apis.roblox.com/cloud/v2";
const DATASTORES = "https://apis.roblox.com/datastores/v1";

// Roblox limits on ban reasons.
const DISPLAY_REASON_MAX = 400;
const PRIVATE_REASON_MAX = 1000;

export class RobloxError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RobloxError";
    this.status = status;
    this.body = body;
  }
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createRobloxClient({ apiKey, universeId, kickTopic, dungeonTopic, dungeonDatastore }) {
  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { "x-api-key": apiKey, ...(options.headers || {}) },
    });
    const body = await readBody(res);
    if (!res.ok) {
      const detail =
        (body && typeof body === "object" && (body.message || body.error)) ||
        (typeof body === "string" && body.slice(0, 200)) ||
        res.statusText;
      throw new RobloxError(`Roblox API ${res.status}: ${detail}`, res.status, body);
    }
    return body;
  }

  async function publish(topic, payload) {
    // Message limit is 1 KiB — keep payloads tight.
    return apiFetch(`${CLOUD}/universes/${universeId}:publishMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, message: JSON.stringify(payload) }),
    });
  }

  const dungeonEntryUrl = (userId) =>
    `${DATASTORES}/universes/${universeId}/standard-datastores/datastore/entries/entry` +
    `?datastoreName=${encodeURIComponent(dungeonDatastore)}&entryKey=${encodeURIComponent(String(userId))}`;

  return {
    /**
     * Accepts a username, a numeric user id, or a profile URL.
     * Returns { id, name, displayName } or null if not found.
     */
    async resolveUser(query) {
      const raw = String(query).trim();
      const urlMatch = raw.match(/roblox\.com\/users\/(\d+)/i);
      const idText = urlMatch ? urlMatch[1] : raw;

      if (/^\d+$/.test(idText)) {
        const id = Number(idText);
        const info = await this.getUserInfo(id);
        return info ? { id, name: info.name, displayName: info.displayName } : null;
      }

      const res = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [raw], excludeBannedUsers: false }),
      });
      if (!res.ok) throw new RobloxError("Username lookup failed", res.status, await readBody(res));
      const data = await readBody(res);
      const hit = data?.data?.[0];
      return hit ? { id: hit.id, name: hit.name, displayName: hit.displayName } : null;
    },

    /** Public profile info; returns null on 404. */
    async getUserInfo(userId) {
      const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new RobloxError("User info lookup failed", res.status, await readBody(res));
      const data = await readBody(res);
      return {
        id: data.id,
        name: data.name,
        displayName: data.displayName,
        created: data.created,
        description: data.description,
      };
    },

    /** Headshot URL for the dashboard/embeds; null if unavailable. */
    async getHeadshotUrl(userId) {
      try {
        const res = await fetch(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
        );
        if (!res.ok) return null;
        const data = await readBody(res);
        const entry = data?.data?.[0];
        return entry && entry.state === "Completed" ? entry.imageUrl : null;
      } catch {
        return null;
      }
    },

    /* ── bans ─────────────────────────────────────────────── */

    /**
     * Ban a player. durationSeconds null/undefined = permanent.
     * Roblox kicks them from live servers automatically when the ban lands.
     */
    async banUser(userId, { durationSeconds, privateReason, displayReason, excludeAltAccounts }) {
      const gameJoinRestriction = {
        active: true,
        privateReason: clamp(privateReason || "Banned via Warden", PRIVATE_REASON_MAX),
        displayReason: clamp(displayReason || privateReason || "You have been banned.", DISPLAY_REASON_MAX),
        excludeAltAccounts: Boolean(excludeAltAccounts),
      };
      if (durationSeconds !== null && durationSeconds !== undefined) {
        gameJoinRestriction.duration = `${Math.max(1, Math.floor(durationSeconds))}s`;
      }
      return apiFetch(
        `${CLOUD}/universes/${universeId}/user-restrictions/${userId}?updateMask=gameJoinRestriction`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameJoinRestriction }),
        }
      );
    },

    async unbanUser(userId) {
      return apiFetch(
        `${CLOUD}/universes/${universeId}/user-restrictions/${userId}?updateMask=gameJoinRestriction`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameJoinRestriction: { active: false } }),
        }
      );
    },

    /** Live restriction state straight from Roblox; null = no restriction. */
    async getRestriction(userId) {
      try {
        const data = await apiFetch(`${CLOUD}/universes/${universeId}/user-restrictions/${userId}`);
        return data?.gameJoinRestriction ?? null;
      } catch (err) {
        if (err instanceof RobloxError && err.status === 404) return null;
        throw err;
      }
    },

    /* ── kicks ────────────────────────────────────────────── */

    /**
     * Kick a live player via MessagingService. Only reaches players currently
     * in a server, and requires the Warden game script to be installed.
     */
    async kickUser(userId, reason) {
      return publish(kickTopic, {
        userId: Number(userId),
        reason: clamp(reason || "Kicked by a moderator.", 400),
      });
    },

    /* ── dungeon ──────────────────────────────────────────── */

    /**
     * Write a dungeon sentence to the game's DataStore so every server —
     * including ones that start next week — can see it at player join.
     * expiresAtUnix: unix seconds, or null for permanent.
     */
    async setDungeonSentence(userId, { expiresAtUnix, reason, moderator }) {
      const value = {
        permanent: expiresAtUnix === null || expiresAtUnix === undefined,
        reason: clamp(reason || "Sent to the dungeon by a moderator.", 400),
        by: clamp(moderator || "", 100),
        at: Math.floor(Date.now() / 1000),
      };
      if (!value.permanent) value.expiresAt = Math.floor(expiresAtUnix);
      const body = JSON.stringify(value);
      return apiFetch(dungeonEntryUrl(userId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "content-md5": crypto.createHash("md5").update(body).digest("base64"),
        },
        body,
      });
    },

    /** Read the live dungeon sentence; null = none on record. */
    async getDungeonSentence(userId) {
      try {
        return await apiFetch(dungeonEntryUrl(userId));
      } catch (err) {
        if (err instanceof RobloxError && err.status === 404) return null;
        throw err;
      }
    },

    /** Remove the sentence entirely (release). 404 = already gone, fine. */
    async clearDungeonSentence(userId) {
      try {
        return await apiFetch(dungeonEntryUrl(userId), { method: "DELETE" });
      } catch (err) {
        if (err instanceof RobloxError && err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Tell live servers to move a player right now.
     * action: "send" (to the dungeon) or "release" (back to the main game).
     */
    async publishDungeonMove(action, userId, { expiresAtUnix = null, reason = "" } = {}) {
      return publish(dungeonTopic, {
        action,
        userId: Number(userId),
        permanent: action === "send" ? expiresAtUnix === null : undefined,
        expiresAt: expiresAtUnix ?? undefined,
        reason: clamp(reason, 300) || undefined,
      });
    },
  };
}
