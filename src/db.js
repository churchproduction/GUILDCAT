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

const SCHEMA_VERSION = 2;

export const ACTION_TYPES = ["ban", "unban", "kick", "warn", "note", "dungeon", "release"];

const ACTIONS_TABLE_SQL = `
  CREATE TABLE actions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    type             TEXT NOT NULL CHECK (type IN ('ban','unban','kick','warn','note','dungeon','release')),
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

  if (!actionsRow.sql.includes("'dungeon'")) {
    // v1 → v2: SQLite can't alter a CHECK constraint, so rebuild the table.
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
