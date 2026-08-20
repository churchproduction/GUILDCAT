// SQLite persistence layer.
//
// Tables:
//   actions  — immutable audit log of everything (bans, kicks, dungeons, …)
//   bans     — current ban state (one row per currently-banned player)
//   dungeons — current dungeon state (one row per currently-dungeoned player)
//   evidence — files/links attached to actions
//   players  — username/avatar cache so the dashboard doesn't hammer Roblox
//
// Schema versioning via PRAGMA user_version, with a rebuild migration from the
// v1 schema (which lacked dungeon/release action types and the new tables).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./format.js";

const SCHEMA_VERSION = 3;

export const ACTION_TYPES = ["ban", "unban", "kick", "warn", "note", "dungeon", "release", "report"];

const ACTIONS_TABLE_SQL = `
  CREATE TABLE actions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    type             TEXT NOT NULL CHECK (type IN ('ban','unban','kick','warn','note','dungeon','release','report')),
    user_id          INTEGER NOT NULL,
    username         TEXT NOT NULL,          -- snapshot at action time
    reason           TEXT,                   -- internal/private reason
    display_reason   TEXT,                   -- bans: what the player sees
    duration_seconds INTEGER,                -- bans/dungeons: NULL = permanent
    expires_at       TEXT,                   -- bans/dungeons: NULL = permanent
    exclude_alts     INTEGER NOT NULL DEFAULT 0,
    moderator_id     TEXT NOT NULL,          -- Discord user id
    moderator_name   TEXT NOT NULL,
    created_at       TEXT NOT NULL
  )
`;

const SUPPORT_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS players (
    user_id      INTEGER PRIMARY KEY,
    username     TEXT NOT NULL,
    display_name TEXT,
    avatar_url   TEXT,
    created_on   TEXT,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_actions_user ON actions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at DESC);

  CREATE TABLE IF NOT EXISTS bans (
    user_id    INTEGER PRIMARY KEY,
    action_id  INTEGER NOT NULL REFERENCES actions(id),
    expires_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dungeons (
    user_id    INTEGER PRIMARY KEY,
    action_id  INTEGER NOT NULL REFERENCES actions(id),
    expires_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evidence (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id     INTEGER NOT NULL REFERENCES actions(id),
    kind          TEXT NOT NULL CHECK (kind IN ('file','link')),
    url           TEXT,          -- links: the external URL
    file_name     TEXT,          -- files: stored filename inside EVIDENCE_DIR
    original_name TEXT,
    content_type  TEXT,
    size_bytes    INTEGER,
    uploaded_by   TEXT NOT NULL, -- Discord user id
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_action ON evidence(action_id);

  -- In-game exploit reports (submitted by players from inside the game).
  CREATE TABLE IF NOT EXISTS reports (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_user_id INTEGER NOT NULL,
    reporter_name    TEXT NOT NULL,
    target_user_id   INTEGER NOT NULL,
    target_name      TEXT NOT NULL,
    reason           TEXT NOT NULL,
    place_id         TEXT,
    job_id           TEXT,        -- the server they were in → mods can join it
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled')),
    handled_by       TEXT,
    handled_at       TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_pair ON reports(reporter_user_id, target_user_id);

  -- Roblox users blocked from sending in-game exploit reports (abuse).
  -- Shadow-blocked: their game still says "thanks", nothing arrives.
  CREATE TABLE IF NOT EXISTS report_blacklist (
    user_id    INTEGER PRIMARY KEY,
    username   TEXT NOT NULL,
    reason     TEXT,
    added_by   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Players caught firing fake (honeypot) remote events. 'pending' hits stack
  -- until an admin presses the punish button, which dungeons them all.
  CREATE TABLE IF NOT EXISTS honeypot_hits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    remote_name TEXT NOT NULL,
    args        TEXT,            -- what the exploiter fired it with (if known)
    total       INTEGER,         -- the game's running total of traps fired (dedupe)
    place_id    TEXT,
    job_id      TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','punished')),
    punished_by TEXT,
    punished_at TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_honeypot_status ON honeypot_hits(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_honeypot_user ON honeypot_hits(user_id, status);

  -- Discord tickets ('report' = user report, 'support' = support ticket).
  CREATE TABLE IF NOT EXISTS tickets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL CHECK (kind IN ('report','support')),
    channel_id      TEXT,
    opener_id       TEXT NOT NULL,   -- Discord user id
    opener_tag      TEXT NOT NULL,
    subject         TEXT,            -- report: who; support: topic
    details         TEXT,            -- what they wrote in the form
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    closed_by       TEXT,
    closed_at       TEXT,
    close_action_id INTEGER,         -- report tickets: the logged record entry
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
    author_id   TEXT NOT NULL,
    author_name TEXT NOT NULL,
    via         TEXT NOT NULL DEFAULT 'discord' CHECK (via IN ('discord','web','system')),
    content     TEXT,
    attachments TEXT,                -- JSON [{name,url}]
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, id);
`;

function migrate(db) {
  const actionsRow = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'`)
    .get();

  if (!actionsRow) {
    // Fresh database.
    db.exec(ACTIONS_TABLE_SQL + ";" + SUPPORT_TABLES_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }

  if (!actionsRow.sql.includes("'report'")) {
    // Older schema (v1 or v2): SQLite can't alter a CHECK constraint, so
    // rebuild the table with the full type list.
    // legacy_alter_table stops RENAME from rewriting other tables' foreign
    // keys (bans REFERENCES actions) to point at the temporary name.
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    const rebuild = db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS idx_actions_user;
        DROP INDEX IF EXISTS idx_actions_type;
        DROP INDEX IF EXISTS idx_actions_created;
        ALTER TABLE actions RENAME TO actions_v1;
      `);
      db.exec(ACTIONS_TABLE_SQL);
      db.exec(`
        INSERT INTO actions (id, type, user_id, username, reason, display_reason,
          duration_seconds, expires_at, exclude_alts, moderator_id, moderator_name, created_at)
        SELECT id, type, user_id, username, reason, display_reason,
          duration_seconds, expires_at, exclude_alts, moderator_id, moderator_name, created_at
        FROM actions_v1;
        DROP TABLE actions_v1;
      `);
    });
    rebuild();
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }

  db.exec(SUPPORT_TABLES_SQL);
  // Older honeypot_hits tables (created before the game sent totals) get the column added.
  const honeyCols = db.prepare(`PRAGMA table_info(honeypot_hits)`).all().map((c) => c.name);
  if (!honeyCols.includes("total")) {
    db.exec(`ALTER TABLE honeypot_hits ADD COLUMN total INTEGER`);
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function openDb(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function makeQueries(db) {
  const upsertPlayer = db.prepare(`
    INSERT INTO players (user_id, username, display_name, avatar_url, created_on, updated_at)
    VALUES (@user_id, @username, @display_name, @avatar_url, @created_on, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      username     = excluded.username,
      display_name = COALESCE(excluded.display_name, players.display_name),
      avatar_url   = COALESCE(excluded.avatar_url, players.avatar_url),
      created_on   = COALESCE(excluded.created_on, players.created_on),
      updated_at   = excluded.updated_at
  `);

  const insertAction = db.prepare(`
    INSERT INTO actions (type, user_id, username, reason, display_reason,
      duration_seconds, expires_at, exclude_alts, moderator_id, moderator_name, created_at)
    VALUES (@type, @user_id, @username, @reason, @display_reason,
      @duration_seconds, @expires_at, @exclude_alts, @moderator_id, @moderator_name, @created_at)
  `);

  const upsertState = (table) =>
    db.prepare(`
      INSERT INTO ${table} (user_id, action_id, expires_at, created_at)
      VALUES (@user_id, @action_id, @expires_at, @created_at)
      ON CONFLICT(user_id) DO UPDATE SET
        action_id  = excluded.action_id,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `);
  const setBan = upsertState("bans");
  const setDungeon = upsertState("dungeons");
  const clearBan = db.prepare(`DELETE FROM bans WHERE user_id = ?`);
  const clearDungeon = db.prepare(`DELETE FROM dungeons WHERE user_id = ?`);

  const recordAction = db.transaction((entry, player) => {
    if (player) {
      upsertPlayer.run({
        user_id: player.id,
        username: player.name,
        display_name: player.displayName ?? null,
        avatar_url: player.avatarUrl ?? null,
        created_on: player.createdOn ?? null,
        updated_at: nowIso(),
      });
    }
    const info = insertAction.run({
      reason: null,
      display_reason: null,
      duration_seconds: null,
      expires_at: null,
      exclude_alts: 0,
      ...entry,
      created_at: nowIso(),
    });
    const actionId = Number(info.lastInsertRowid);
    const state = {
      user_id: entry.user_id,
      action_id: actionId,
      expires_at: entry.expires_at ?? null,
      created_at: nowIso(),
    };
    if (entry.type === "ban") setBan.run(state);
    else if (entry.type === "unban") clearBan.run(entry.user_id);
    else if (entry.type === "dungeon") setDungeon.run(state);
    else if (entry.type === "release") clearDungeon.run(entry.user_id);
    return actionId;
  });

  const insertEvidenceStmt = db.prepare(`
    INSERT INTO evidence (action_id, kind, url, file_name, original_name,
      content_type, size_bytes, uploaded_by, created_at)
    VALUES (@action_id, @kind, @url, @file_name, @original_name,
      @content_type, @size_bytes, @uploaded_by, @created_at)
  `);
  const insertEvidence = (row) =>
    Number(
      insertEvidenceStmt.run({
        url: null,
        file_name: null,
        original_name: null,
        content_type: null,
        size_bytes: null,
        ...row,
        created_at: nowIso(),
      }).lastInsertRowid
    );

  /** Attach an `evidence` array to a list of action rows (mutates + returns). */
  function withEvidence(rows) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const all = db
      .prepare(`SELECT * FROM evidence WHERE action_id IN (${placeholders}) ORDER BY id`)
      .all(...ids);
    const grouped = new Map();
    for (const e of all) {
      if (!grouped.has(e.action_id)) grouped.set(e.action_id, []);
      grouped.get(e.action_id).push(e);
    }
    for (const r of rows) r.evidence = grouped.get(r.id) ?? [];
    return rows;
  }

  const PLAYER_JOIN = `
    LEFT JOIN players p ON p.user_id = a.user_id
  `;
  const ACTION_COLS = `
    a.id, a.type, a.user_id, a.username, a.reason, a.display_reason,
    a.duration_seconds, a.expires_at, a.exclude_alts,
    a.moderator_id, a.moderator_name, a.created_at,
    COALESCE(p.username, a.username) AS current_username,
    p.display_name, p.avatar_url
  `;

  const currentState = (table) => (userId) => {
    const row = db
      .prepare(
        `SELECT s.user_id, s.expires_at, s.created_at, ${ACTION_COLS}
         FROM ${table} s JOIN actions a ON a.id = s.action_id ${PLAYER_JOIN}
         WHERE s.user_id = ?`
      )
      .get(userId);
    if (!row) return null;
    row.active = row.expires_at === null || row.expires_at > nowIso();
    return row;
  };

  const listState = (table) => ({ status = "active", q = "", limit = 50, offset = 0 } = {}) => {
    const now = nowIso();
    const statusClause =
      status === "active"
        ? `AND (s.expires_at IS NULL OR s.expires_at > @now)`
        : status === "expired"
          ? `AND (s.expires_at IS NOT NULL AND s.expires_at <= @now)`
          : ``;
    const search = q
      ? `AND (COALESCE(p.username, a.username) LIKE @q OR p.display_name LIKE @q
             OR CAST(a.user_id AS TEXT) LIKE @q OR a.reason LIKE @q)`
      : ``;
    const params = { now, q: `%${q}%`, limit, offset };
    const rows = db
      .prepare(
        `SELECT s.expires_at AS state_expires_at, s.created_at AS state_since, ${ACTION_COLS}
         FROM ${table} s JOIN actions a ON a.id = s.action_id ${PLAYER_JOIN}
         WHERE 1=1 ${statusClause} ${search}
         ORDER BY s.created_at DESC LIMIT @limit OFFSET @offset`
      )
      .all(params);
    const total = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM ${table} s JOIN actions a ON a.id = s.action_id ${PLAYER_JOIN}
         WHERE 1=1 ${statusClause} ${search}`
      )
      .get(params).n;
    return { rows: withEvidence(rows), total };
  };

  const deleteAction = db.transaction((actionId) => {
    const action = db.prepare(`SELECT id FROM actions WHERE id = ?`).get(actionId);
    if (!action) return { ok: false, notFound: true };

    const now = nowIso();
    const activeBacking = db
      .prepare(
        `SELECT 1 AS x FROM bans WHERE action_id = @id AND (expires_at IS NULL OR expires_at > @now)
         UNION ALL
         SELECT 1 FROM dungeons WHERE action_id = @id AND (expires_at IS NULL OR expires_at > @now)`
      )
      .get({ id: actionId, now });
    if (activeBacking) {
      return { ok: false, blocked: true }; // lift the ban/sentence first
    }

    const evidenceFiles = db
      .prepare(`SELECT file_name FROM evidence WHERE action_id = ? AND file_name IS NOT NULL`)
      .all(actionId)
      .map((r) => r.file_name);

    db.prepare(`DELETE FROM evidence WHERE action_id = ?`).run(actionId);
    // expired state rows referencing this action go too
    db.prepare(`DELETE FROM bans WHERE action_id = ?`).run(actionId);
    db.prepare(`DELETE FROM dungeons WHERE action_id = ?`).run(actionId);
    db.prepare(`DELETE FROM actions WHERE id = ?`).run(actionId);
    return { ok: true, evidenceFiles };
  });

  return {
    recordAction,
    insertEvidence,
    deleteAction,

    getPlayer: (userId) =>
      db.prepare(`SELECT * FROM players WHERE user_id = ?`).get(userId),

    getEvidence: (id) => db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(id),

    getAction: (id) =>
      db.prepare(`SELECT ${ACTION_COLS} FROM actions a ${PLAYER_JOIN} WHERE a.id = ?`).get(id),

    userHistory: (userId) =>
      withEvidence(
        db
          .prepare(
            `SELECT ${ACTION_COLS} FROM actions a ${PLAYER_JOIN}
             WHERE a.user_id = ? ORDER BY a.created_at DESC, a.id DESC`
          )
          .all(userId)
      ),

    userCounts: (userId) =>
      db
        .prepare(
          `SELECT type, COUNT(*) AS count FROM actions WHERE user_id = ? GROUP BY type`
        )
        .all(userId),

    currentBan: currentState("bans"),
    currentDungeon: currentState("dungeons"),
    listBans: listState("bans"),
    listDungeons: listState("dungeons"),

    listActions: ({ type = "", q = "", limit = 50, offset = 0 } = {}) => {
      const typeClause = type ? `AND a.type = @type` : ``;
      const search = q
        ? `AND (COALESCE(p.username, a.username) LIKE @q OR CAST(a.user_id AS TEXT) LIKE @q
               OR a.reason LIKE @q OR a.moderator_name LIKE @q)`
        : ``;
      const params = { type, q: `%${q}%`, limit, offset };
      const rows = db
        .prepare(
          `SELECT ${ACTION_COLS} FROM actions a ${PLAYER_JOIN}
           WHERE 1=1 ${typeClause} ${search}
           ORDER BY a.created_at DESC, a.id DESC LIMIT @limit OFFSET @offset`
        )
        .all(params);
      const total = db
        .prepare(
          `SELECT COUNT(*) AS n FROM actions a ${PLAYER_JOIN} WHERE 1=1 ${typeClause} ${search}`
        )
        .get(params).n;
      return { rows: withEvidence(rows), total };
    },

    searchPlayers: (q, limit = 12) =>
      db
        .prepare(
          `SELECT p.*,
             (SELECT COUNT(*) FROM actions a WHERE a.user_id = p.user_id) AS action_count,
             EXISTS(SELECT 1 FROM bans b WHERE b.user_id = p.user_id
                    AND (b.expires_at IS NULL OR b.expires_at > @now)) AS banned,
             EXISTS(SELECT 1 FROM dungeons d WHERE d.user_id = p.user_id
                    AND (d.expires_at IS NULL OR d.expires_at > @now)) AS dungeoned
           FROM players p
           WHERE p.username LIKE @q OR p.display_name LIKE @q OR CAST(p.user_id AS TEXT) LIKE @q
           ORDER BY p.updated_at DESC LIMIT @limit`
        )
        .all({ q: `%${q}%`, now: nowIso(), limit }),

    /* ── in-game exploit reports ─────────────────────────── */

    insertReport: (r) =>
      Number(
        db.prepare(`
          INSERT INTO reports (reporter_user_id, reporter_name, target_user_id,
            target_name, reason, place_id, job_id, created_at)
          VALUES (@reporter_user_id, @reporter_name, @target_user_id,
            @target_name, @reason, @place_id, @job_id, @created_at)
        `).run({ place_id: null, job_id: null, ...r, created_at: nowIso() }).lastInsertRowid
      ),

    getReport: (id) => db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id),

    listReports: ({ status = "open", q = "", limit = 50, offset = 0 } = {}) => {
      const statusClause = status === "all" ? `` : `AND r.status = @status`;
      const search = q
        ? `AND (r.reporter_name LIKE @q OR r.target_name LIKE @q OR r.reason LIKE @q
               OR CAST(r.target_user_id AS TEXT) LIKE @q)`
        : ``;
      const params = { status, q: `%${q}%`, limit, offset };
      const rows = db
        .prepare(`SELECT r.*, p.avatar_url AS target_avatar_url,
                    COALESCE(p.username, r.target_name) AS target_current_name
                  FROM reports r LEFT JOIN players p ON p.user_id = r.target_user_id
                  WHERE 1=1 ${statusClause} ${search}
                  ORDER BY r.created_at DESC LIMIT @limit OFFSET @offset`)
        .all(params);
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM reports r WHERE 1=1 ${statusClause} ${search}`)
        .get(params).n;
      return { rows, total };
    },

    setReportHandled: (id, handledBy) =>
      db.prepare(`UPDATE reports SET status='handled', handled_by=?, handled_at=?
                  WHERE id=? AND status='open'`).run(handledBy, nowIso(), id).changes > 0,

    /** Has this reporter already reported this target (ever)? */
    hasReportAbout: (reporterId, targetId) =>
      Boolean(
        db.prepare(`SELECT 1 FROM reports WHERE reporter_user_id=? AND target_user_id=? LIMIT 1`)
          .get(reporterId, targetId)
      ),

    /* ── report blacklist (abusive reporters, shadow-blocked) ── */

    blacklistReporter: (r) =>
      db.prepare(`
        INSERT INTO report_blacklist (user_id, username, reason, added_by, created_at)
        VALUES (@user_id, @username, @reason, @added_by, @created_at)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          reason = excluded.reason,
          added_by = excluded.added_by,
          created_at = excluded.created_at
      `).run({ reason: null, ...r, created_at: nowIso() }),

    unblacklistReporter: (userId) =>
      db.prepare(`DELETE FROM report_blacklist WHERE user_id = ?`).run(userId).changes > 0,

    isReporterBlacklisted: (userId) =>
      Boolean(db.prepare(`SELECT 1 FROM report_blacklist WHERE user_id = ?`).get(userId)),

    listReportBlacklist: () =>
      db.prepare(`SELECT * FROM report_blacklist ORDER BY created_at DESC`).all(),

    /* ── honeypot (fake remote) catches ──────────────────── */

    insertHoneypotHit: (h) =>
      Number(
        db.prepare(`
          INSERT INTO honeypot_hits (user_id, username, remote_name, args, total, place_id, job_id, created_at)
          VALUES (@user_id, @username, @remote_name, @args, @total, @place_id, @job_id, @created_at)
        `).run({ args: null, total: null, place_id: null, job_id: null, ...h, created_at: nowIso() })
          .lastInsertRowid
      ),

    /** Highest running-total we've seen among this user's pending hits (null = none pending). */
    maxPendingHoneypotTotal: (userId) =>
      db.prepare(`SELECT MAX(total) AS m FROM honeypot_hits WHERE user_id=? AND status='pending'`)
        .get(userId)?.m ?? null,

    /** Does this user already have a pending hit? (avoids channel spam) */
    userHasPendingHoneypot: (userId) =>
      Boolean(db.prepare(`SELECT 1 FROM honeypot_hits WHERE user_id=? AND status='pending' LIMIT 1`).get(userId)),

    pendingHoneypotHits: () =>
      db.prepare(`SELECT * FROM honeypot_hits WHERE status='pending' ORDER BY id`).all(),

    pendingHoneypotUserCount: () =>
      db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM honeypot_hits WHERE status='pending'`).get().n,

    markHoneypotPunished: (punishedBy) =>
      db.prepare(`UPDATE honeypot_hits SET status='punished', punished_by=?, punished_at=?
                  WHERE status='pending'`).run(punishedBy, nowIso()).changes,

    openReportCount: () =>
      db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status='open'`).get().n,

    openTicketCount: () =>
      db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status='open'`).get().n,

    /* ── Discord tickets ─────────────────────────────────── */

    createTicket: (t) =>
      Number(
        db.prepare(`
          INSERT INTO tickets (kind, channel_id, opener_id, opener_tag, subject, details, created_at)
          VALUES (@kind, @channel_id, @opener_id, @opener_tag, @subject, @details, @created_at)
        `).run({ subject: null, details: null, ...t, created_at: nowIso() }).lastInsertRowid
      ),

    getTicket: (id) => db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id),

    ticketByChannel: (channelId) =>
      db.prepare(`SELECT * FROM tickets WHERE channel_id = ? ORDER BY id DESC`).get(channelId),

    closeTicket: (id, { closedBy, closeActionId = null } = {}) =>
      db.prepare(`UPDATE tickets SET status='closed', closed_by=?, closed_at=?, close_action_id=?
                  WHERE id=? AND status='open'`)
        .run(closedBy ?? null, nowIso(), closeActionId, id).changes > 0,

    listTickets: ({ status = "open", kind = "", limit = 50, offset = 0 } = {}) => {
      const statusClause = status === "all" ? `` : `AND t.status = @status`;
      const kindClause = kind ? `AND t.kind = @kind` : ``;
      const params = { status, kind, limit, offset };
      const rows = db
        .prepare(`SELECT t.*,
                    (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
                    (SELECT MAX(m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
                  FROM tickets t WHERE 1=1 ${statusClause} ${kindClause}
                  ORDER BY t.status = 'open' DESC, COALESCE(last_message_at, t.created_at) DESC
                  LIMIT @limit OFFSET @offset`)
        .all(params);
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE 1=1 ${statusClause} ${kindClause}`)
        .get(params).n;
      return { rows, total };
    },

    addTicketMessage: (m) =>
      Number(
        db.prepare(`
          INSERT INTO ticket_messages (ticket_id, author_id, author_name, via, content, attachments, created_at)
          VALUES (@ticket_id, @author_id, @author_name, @via, @content, @attachments, @created_at)
        `).run({ via: "discord", content: null, attachments: null, ...m, created_at: nowIso() })
          .lastInsertRowid
      ),

    ticketMessages: (ticketId) =>
      db.prepare(`SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id`).all(ticketId),

    stats: () => {
      const now = nowIso();
      const activeIn = (table) =>
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE expires_at IS NULL OR expires_at > ?`)
          .get(now).n;
      const last30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const actions30d = db
        .prepare(`SELECT COUNT(*) AS n FROM actions WHERE created_at > ?`)
        .get(last30).n;
      const totalActions = db.prepare(`SELECT COUNT(*) AS n FROM actions`).get().n;
      const playersTouched = db
        .prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM actions`)
        .get().n;
      const byType = db
        .prepare(`SELECT type, COUNT(*) AS count FROM actions GROUP BY type`)
        .all();
      const byDay = db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
           FROM actions WHERE created_at > ?
           GROUP BY day ORDER BY day`
        )
        .all(last30);
      return {
        activeBans: activeIn("bans"),
        activeDungeons: activeIn("dungeons"),
        actions30d,
        totalActions,
        playersTouched,
        byType,
        byDay,
      };
    },
  };
}
