// Express app: static dashboard + JSON API, everything behind staff login.
import express from "express";
import cookieSession from "cookie-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAuthRoutes } from "./auth.js";
import { nowIso, parseDuration } from "../format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const PAGE_SIZE = 25;

export function createWebServer({ config, queries, roblox, service, checkStaff, bridge, audit }) {
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

  // Re-check the member's roles on every load, so rank changes (or a stale
  // pre-update session) never show the wrong buttons.
  app.get("/api/me", async (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: "not signed in" });
    const staff = await checkStaff(req.session.user.id);
    if (!staff) {
      req.session = null;
      return res.status(401).json({ error: "no longer staff" });
    }
    req.session.user = staff;
    res.json({ user: staff });
  });

  app.get("/api/stats", requireAuth, (req, res) => {
    res.json({
      ...queries.stats(),
      openReports: queries.openReportCount(),
      openTickets: queries.openTicketCount(),
    });
  });

  /* ── in-game exploit reports (posted by the game server) ──
     No session here — the game authenticates with a shared secret. */
  app.post("/api/game/report", async (req, res) => {
    if (!config.game.reportSecret) {
      return res.status(503).json({ error: "GAME_REPORT_SECRET is not configured" });
    }
    if (req.get("x-warden-key") !== config.game.reportSecret) {
      return res.status(401).json({ error: "bad key" });
    }
    const b = req.body ?? {};
    const reporterId = parseInt(b.reporter?.id, 10);
    const targetId = parseInt(b.target?.id, 10);
    const reason = String(b.reason ?? "").trim().slice(0, 300);
    if (!Number.isInteger(reporterId) || !Number.isInteger(targetId) || reason.length < 4) {
      return res.status(400).json({ error: "reporter.id, target.id and a reason are required" });
    }
    const report = {
      reporter_user_id: reporterId,
      reporter_name: String(b.reporter?.name ?? reporterId).slice(0, 60),
      target_user_id: targetId,
      target_name: String(b.target?.name ?? targetId).slice(0, 60),
      reason,
      place_id: b.placeId ? String(b.placeId).slice(0, 30) : null,
      job_id: b.jobId ? String(b.jobId).slice(0, 60) : null,
    };
    const id = queries.insertReport(report);
    // Post to Discord (with the join-server button) without holding up the game.
    (async () => {
      const avatar = await roblox.getHeadshotUrl(targetId).catch(() => null);
      await bridge?.postGameReport({ ...report, id, created_at: nowIso() }, avatar);
    })().catch(() => {});
    res.json({ ok: true, id });
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

  app.get("/api/reports", requireAuth, (req, res) => {
    const { limit, offset, page } = pageParams(req);
    const status = ["open", "handled", "all"].includes(req.query.status)
      ? req.query.status
      : "open";
    const { rows, total } = queries.listReports({
      status,
      q: String(req.query.q ?? "").trim(),
      limit,
      offset,
    });
    res.json({ rows, total, page, pageSize: PAGE_SIZE });
  });

  app.get("/api/tickets", requireAuth, (req, res) => {
    const { limit, offset, page } = pageParams(req);
    const status = ["open", "closed", "all"].includes(req.query.status)
      ? req.query.status
      : "all";
    const kind = ["report", "support"].includes(req.query.kind) ? req.query.kind : "";
    const { rows, total } = queries.listTickets({ status, kind, limit, offset });
    res.json({ rows, total, page, pageSize: PAGE_SIZE });
  });

  app.get("/api/tickets/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const ticket = Number.isInteger(id) ? queries.getTicket(id) : null;
    if (!ticket) return res.status(404).json({ error: "no such ticket" });
    const messages = queries.ticketMessages(id).map((m) => ({
      ...m,
      attachments: m.attachments ? JSON.parse(m.attachments) : [],
    }));
    res.json({ ticket, messages });
  });

  app.get("/api/actions", requireAuth, (req, res) => {
    const { limit, offset, page } = pageParams(req);
    const type = ["ban", "unban", "kick", "warn", "note", "dungeon", "release", "report"].includes(req.query.type)
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

  /* ── moderation actions from the web ─────────────────────
     Roles are re-checked against Discord on EVERY call — a stale session
     or a fired mod can't act. Senior gates: ban, unban, delete log. */

  const bad = (msg) => {
    const e = new Error(msg);
    e.status = 400;
    return e;
  };

  const requireStaff = (needSenior) => async (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: "not signed in" });
    const staff = await checkStaff(req.session.user.id);
    if (!staff) {
      req.session = null;
      return res.status(401).json({ error: "you're no longer staff" });
    }
    if (needSenior && !staff.senior) {
      return res.status(403).json({ error: "senior staff only" });
    }
    req.staff = staff;
    next();
  };

  const modAction = (needSenior, fn) => [
    requireStaff(needSenior),
    async (req, res) => {
      try {
        const moderator = { id: req.staff.id, name: req.staff.username, via: "web" };
        const result = await fn(req.body ?? {}, moderator);
        res.json({ ok: true, ...result });
      } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        console.error("Web action failed:", err);
        res.status(502).json({ error: err.message ?? "action failed" });
      }
    },
  ];

  async function resolveTarget(body) {
    const query = String(body.user ?? "").trim();
    if (!query) throw bad("Player is required");
    const player = await service.resolvePlayer(query);
    if (!player) throw bad(`No Roblox user found for "${query}"`);
    return player;
  }

  function parseDurationOr400(input) {
    try {
      return parseDuration(input);
    } catch (err) {
      throw bad(err.message);
    }
  }

  const summary = (player, actionId) => ({
    actionId,
    player: { id: player.id, name: player.name, displayName: player.displayName },
  });

  app.post("/api/mod/ban", ...modAction(true, async (body, moderator) => {
    const player = await resolveTarget(body);
    const reason = String(body.reason ?? "").trim();
    if (!reason) throw bad("Reason is required");
    const durationSeconds = parseDurationOr400(body.duration);
    const { actionId } = await service.ban(player, {
      reason,
      displayReason: String(body.display_reason ?? "").trim() || reason,
      durationSeconds,
      includeAlts: body.include_alts !== false,
      moderator,
    });
    return summary(player, actionId);
  }));

  app.post("/api/mod/unban", ...modAction(true, async (body, moderator) => {
    const player = await resolveTarget(body);
    const { actionId } = await service.unban(player, {
      reason: String(body.reason ?? "").trim() || null,
      moderator,
    });
    return summary(player, actionId);
  }));

  app.post("/api/mod/dungeon", ...modAction(false, async (body, moderator) => {
    const player = await resolveTarget(body);
    const reason = String(body.reason ?? "").trim();
    if (!reason) throw bad("Reason is required");
    const durationSeconds = parseDurationOr400(body.duration);
    const { actionId } = await service.dungeon(player, { durationSeconds, reason, moderator });
    return summary(player, actionId);
  }));

  app.post("/api/mod/release", ...modAction(false, async (body, moderator) => {
    const player = await resolveTarget(body);
    const { actionId } = await service.release(player, {
      reason: String(body.reason ?? "").trim() || null,
      moderator,
    });
    return summary(player, actionId);
  }));

  app.post("/api/mod/kick", ...modAction(false, async (body, moderator) => {
    const player = await resolveTarget(body);
    const { actionId } = await service.kick(player, {
      reason: String(body.reason ?? "").trim() || null,
      moderator,
    });
    return summary(player, actionId);
  }));

  app.post("/api/mod/warn", ...modAction(false, async (body, moderator) => {
    const player = await resolveTarget(body);
    const reason = String(body.reason ?? "").trim();
    if (!reason) throw bad("Reason is required");
    const { actionId } = service.warn(player, { reason, moderator });
    return summary(player, actionId);
  }));

  app.post("/api/mod/note", ...modAction(false, async (body, moderator) => {
    const player = await resolveTarget(body);
    const text = String(body.text ?? "").trim();
    if (!text) throw bad("Note text is required");
    const { actionId } = service.note(player, { text, moderator });
    return summary(player, actionId);
  }));

  app.post("/api/mod/reports/:id/handled", requireStaff(false), (req, res) => {
    const id = parseInt(req.params.id, 10);
    const report = Number.isInteger(id) ? queries.getReport(id) : null;
    if (!report) return res.status(404).json({ error: "no such report" });
    if (report.status !== "open") return res.json({ ok: true }); // already done
    queries.setReportHandled(id, req.staff.username);
    audit?.("web", {
      type: "report_handled",
      report,
      moderator: { id: req.staff.id, name: req.staff.username },
    });
    res.json({ ok: true });
  });

  app.post("/api/mod/tickets/:id/reply", requireStaff(false), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const ticket = Number.isInteger(id) ? queries.getTicket(id) : null;
    if (!ticket) return res.status(404).json({ error: "no such ticket" });
    if (ticket.status !== "open") return res.status(409).json({ error: "ticket is closed" });
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "Write a message first" });
    if (!bridge) return res.status(503).json({ error: "Discord bot is offline" });
    try {
      await bridge.sendTicketReply(ticket, req.staff, text.slice(0, 1800));
    } catch (err) {
      return res.status(502).json({ error: `Couldn't send to Discord: ${err.message}` });
    }
    queries.addTicketMessage({
      ticket_id: ticket.id,
      author_id: req.staff.id,
      author_name: req.staff.displayName ?? req.staff.username,
      via: "web",
      content: text.slice(0, 1800),
    });
    res.json({ ok: true });
  });

  app.post("/api/mod/tickets/:id/close", requireStaff(false), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const ticket = Number.isInteger(id) ? queries.getTicket(id) : null;
    if (!ticket) return res.status(404).json({ error: "no such ticket" });
    if (ticket.status !== "open") return res.json({ ok: true });
    if (ticket.kind === "report") {
      return res.status(409).json({
        error:
          "Report tickets close in Discord with /close — reporter + player + evidence — so the report gets filed on the record.",
      });
    }
    if (!bridge) return res.status(503).json({ error: "Discord bot is offline" });
    await bridge.webCloseSupport(ticket, req.staff);
    audit?.("web", {
      type: "ticket_close",
      ticket,
      moderator: { id: req.staff.id, name: req.staff.username },
    });
    res.json({ ok: true });
  });

  app.delete("/api/mod/actions/:id", requireStaff(true), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad id" });
    const result = await service.deleteAction(id, {
      id: req.staff.id,
      name: req.staff.username,
      via: "web",
    });
    if (!result.ok) {
      if (result.blocked) {
        return res.status(409).json({
          error: "That entry backs an ACTIVE ban or dungeon sentence — lift it first, then delete.",
        });
      }
      return res.status(404).json({ error: "no such log entry" });
    }
    res.json({ ok: true });
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
