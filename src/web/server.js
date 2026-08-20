// Express app: static dashboard + JSON API, everything behind staff login.
import express from "express";
import cookieSession from "cookie-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAuthRoutes } from "./auth.js";
import { nowIso } from "../format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const PAGE_SIZE = 25;

export function createWebServer({ config, queries, roblox, checkStaff }) {
  const app = express();
  app.set("trust proxy", 1); // Railway/Render sit behind a proxy
  app.use(express.json());
  app.use(
    cookieSession({
      name: "warden.sid",
      keys: [config.web.sessionSecret],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: config.web.baseUrl.startsWith("https://"),
    })
  );

  registerAuthRoutes(app, { config, checkStaff });

  const requireAuth = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "not signed in" });
    next();
  };

  const pageParams = (req) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    return { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, page };
  };

  app.get("/api/me", (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: "not signed in" });
    res.json({ user: req.session.user });
  });

  app.get("/api/stats", requireAuth, (req, res) => {
    res.json(queries.stats());
  });

  const stateListRoute = (listFn) => (req, res) => {
    const { limit, offset, page } = pageParams(req);
    const status = ["active", "expired", "all"].includes(req.query.status)
      ? req.query.status
      : "active";
    const { rows, total } = listFn({
      status,
      q: String(req.query.q ?? "").trim(),
      limit,
      offset,
    });
    res.json({ rows, total, page, pageSize: PAGE_SIZE, now: nowIso() });
  };

  app.get("/api/bans", requireAuth, stateListRoute(queries.listBans));
  app.get("/api/dungeon", requireAuth, stateListRoute(queries.listDungeons));

  app.get("/api/actions", requireAuth, (req, res) => {
    const { limit, offset, page } = pageParams(req);
    const type = ["ban", "unban", "kick", "warn", "note", "dungeon", "release"].includes(req.query.type)
      ? req.query.type
      : "";
    const { rows, total } = queries.listActions({
      type,
      q: String(req.query.q ?? "").trim(),
      limit,
      offset,
    });
    res.json({ rows, total, page, pageSize: PAGE_SIZE });
  });

  app.get("/api/search", requireAuth, async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ local: [], remote: null });

    const local = queries.searchPlayers(q);
    let remote = null;
    // If nothing local matches exactly, ask Roblox — lets staff pull up anyone.
    const exactLocal = local.some(
      (p) =>
        p.username.toLowerCase() === q.toLowerCase() || String(p.user_id) === q
    );
    if (!exactLocal) {
      try {
        const found = await roblox.resolveUser(q);
        if (found && !local.some((p) => p.user_id === found.id)) {
          remote = {
            user_id: found.id,
            username: found.name,
            display_name: found.displayName,
            avatar_url: await roblox.getHeadshotUrl(found.id),
          };
        }
      } catch {
        // Roblox being unreachable shouldn't break local search.
      }
    }
    res.json({ local, remote });
  });

  app.get("/api/users/:id", requireAuth, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "bad user id" });
    }

    let player = queries.getPlayer(userId);
    let liveInfo = null;
    if (!player || req.query.refresh === "1") {
      try {
        liveInfo = await roblox.getUserInfo(userId);
      } catch {
        liveInfo = null;
      }
      if (!player && !liveInfo) {
        return res.status(404).json({ error: "no such Roblox user" });
      }
    }
    const avatar_url =
      player?.avatar_url ?? (await roblox.getHeadshotUrl(userId).catch(() => null));

    const profile = {
      user_id: userId,
      username: liveInfo?.name ?? player?.username,
      display_name: liveInfo?.displayName ?? player?.display_name,
      created_on: liveInfo?.created ?? player?.created_on ?? null,
      avatar_url,
      known_locally: Boolean(player),
    };

    let robloxStatus = null; // null = couldn't check; {active:false} = not banned
    try {
      const r = await roblox.getRestriction(userId);
      robloxStatus = r ?? { active: false };
    } catch {
      robloxStatus = null;
    }

    let dungeonStatus = null; // null = couldn't check
    try {
      const s = await roblox.getDungeonSentence(userId);
      const nowUnix = Math.floor(Date.now() / 1000);
      const active =
        !!s && (s.permanent === true || (typeof s.expiresAt === "number" && s.expiresAt > nowUnix));
      dungeonStatus = {
        active,
        permanent: active ? s.permanent === true : false,
        expiresAt: active && !s.permanent ? s.expiresAt : null,
        reason: active ? (s.reason ?? null) : null,
      };
    } catch {
      dungeonStatus = null;
    }

    res.json({
      profile,
      history: queries.userHistory(userId),
      counts: queries.userCounts(userId),
      currentBan: queries.currentBan(userId),
      currentDungeon: queries.currentDungeon(userId),
      robloxStatus,
      dungeonStatus,
      now: nowIso(),
    });
  });

  // Evidence files — auth-gated, streamed from EVIDENCE_DIR.
  app.get("/evidence/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = Number.isInteger(id) ? queries.getEvidence(id) : null;
    if (!row || row.kind !== "file" || !row.file_name) {
      return res.status(404).json({ error: "no such evidence file" });
    }
    const dir = path.resolve(config.evidence.dir);
    const filePath = path.resolve(dir, row.file_name);
    if (!filePath.startsWith(dir + path.sep)) {
      return res.status(400).json({ error: "bad path" });
    }
    const headers = { "Cache-Control": "private, max-age=86400" };
    if (row.content_type) headers["Content-Type"] = row.content_type;
    if (row.original_name) {
      headers["Content-Disposition"] =
        `inline; filename="${row.original_name.replace(/[^\w.\- ]/g, "_")}"`;
    }
    res.sendFile(filePath, { headers }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "file missing on disk" });
    });
  });

  app.use(express.static(PUBLIC_DIR));

  return app;
}
