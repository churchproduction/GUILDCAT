// Smoke test: durations, database logic (incl. v1→v2 migration, dungeon,
// evidence), permission tiers, and the web API with a real signed session
// cookie. No Discord or Roblox network calls — those are stubbed.
// Run with: npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Keygrip from "keygrip";
import { parseDuration, formatDuration } from "../src/format.js";
import { openDb, makeQueries } from "../src/db.js";
import { createWebServer } from "../src/web/server.js";
import { createModerationService } from "../src/actions.js";
import { buildHandlers } from "../src/bot/commands.js";

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-test-"));

/* ── durations ──────────────────────────────────────────── */
console.log("durations");
assert.equal(parseDuration("30m"), 1800);
assert.equal(parseDuration("2h"), 7200);
assert.equal(parseDuration("7d"), 604800);
assert.equal(parseDuration("1d12h"), 129600);
assert.equal(parseDuration("1w"), 604800);
assert.equal(parseDuration("1m"), 60);
assert.equal(parseDuration("90"), 90);
assert.equal(parseDuration("permanent"), null);
assert.equal(parseDuration(null), null);
assert.throws(() => parseDuration("xyz"));
assert.throws(() => parseDuration("5x"));
ok("parseDuration");
assert.equal(formatDuration(null), "Permanent");
assert.equal(formatDuration(5400), "1 hour 30 minutes");
assert.equal(formatDuration(604800), "1 week");
ok("formatDuration");

/* ── v1 → v2 migration ──────────────────────────────────── */
console.log("migration");
const migPath = path.join(tmp, "migrate.db");
{
  const raw = new Database(migPath);
  raw.exec(`
    CREATE TABLE actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('ban','unban','kick','warn','note')),
      user_id INTEGER NOT NULL, username TEXT NOT NULL,
      reason TEXT, display_reason TEXT, duration_seconds INTEGER, expires_at TEXT,
      exclude_alts INTEGER NOT NULL DEFAULT 0,
      moderator_id TEXT NOT NULL, moderator_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_actions_user ON actions(user_id, created_at DESC);
    CREATE TABLE players (user_id INTEGER PRIMARY KEY, username TEXT NOT NULL,
      display_name TEXT, avatar_url TEXT, created_on TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE bans (user_id INTEGER PRIMARY KEY,
      action_id INTEGER NOT NULL REFERENCES actions(id), expires_at TEXT, created_at TEXT NOT NULL);
  `);
  raw.prepare(`INSERT INTO actions (type,user_id,username,reason,moderator_id,moderator_name,created_at)
    VALUES ('warn', 42, 'OldTimer', 'legacy row', 'm0', 'oldmod', '2026-01-01T00:00:00Z')`).run();
  raw.close();
}
const migDb = openDb(migPath);
const migQ = makeQueries(migDb);
assert.equal(migDb.pragma("user_version", { simple: true }), 3);
assert.equal(migQ.userHistory(42).length, 1); // legacy data survived
migQ.recordAction({
  type: "dungeon", user_id: 42, username: "OldTimer", reason: "post-migration",
  duration_seconds: 3600, expires_at: new Date(Date.now() + 3600e3).toISOString(),
  moderator_id: "m1", moderator_name: "modA",
});
assert.equal(migQ.currentDungeon(42).active, true);
migQ.recordAction({
  type: "report", user_id: 42, username: "OldTimer",
  reason: "Player report — reporter: someone (1). works after migration",
  moderator_id: "m1", moderator_name: "modA",
});
assert.equal(migQ.userHistory(42)[0].type, "report");
migDb.close();
ok("v1 schema upgraded in place, old rows intact, dungeon + report types accepted");

/* ── database ───────────────────────────────────────────── */
console.log("database");
const db = openDb(":memory:");
const q = makeQueries(db);

const alice = { id: 111, name: "AliceRBX", displayName: "Alice" };
const bob = { id: 222, name: "BobRBX", displayName: "Bob" };
const cara = { id: 333, name: "CaraRBX", displayName: "Cara" };

// permanent ban for alice
q.recordAction(
  {
    type: "ban", user_id: alice.id, username: alice.name,
    reason: "Exploiting", display_reason: "Exploiting is not allowed",
    duration_seconds: null, expires_at: null, exclude_alts: 1,
    moderator_id: "m1", moderator_name: "modA",
  },
  alice
);
assert.equal(q.currentBan(alice.id).active, true);
assert.equal(q.listBans({ status: "active" }).total, 1);
ok("permanent ban recorded and active");

// warn + kick, then unban
q.recordAction({ type: "warn", user_id: alice.id, username: alice.name, reason: "Language", moderator_id: "m1", moderator_name: "modA" }, alice);
q.recordAction({ type: "kick", user_id: alice.id, username: alice.name, reason: "AFK farming", moderator_id: "m2", moderator_name: "modB" }, alice);
q.recordAction({ type: "unban", user_id: alice.id, username: alice.name, reason: "Appealed", moderator_id: "m2", moderator_name: "modB" }, alice);
assert.equal(q.currentBan(alice.id), null);
assert.equal(q.listBans({ status: "active" }).total, 0);
assert.equal(q.userHistory(alice.id).length, 4);
assert.equal(q.userHistory(alice.id)[0].type, "unban");
ok("warn/kick/unban flow");

// expired temp ban for bob
q.recordAction(
  {
    type: "ban", user_id: bob.id, username: bob.name,
    reason: "Spam", duration_seconds: 3600,
    expires_at: new Date(Date.now() - 1000).toISOString(),
    moderator_id: "m1", moderator_name: "modA",
  },
  bob
);
assert.equal(q.currentBan(bob.id).active, false);
assert.equal(q.listBans({ status: "expired" }).total, 1);
ok("temp ban expiry logic");

// dungeon flow: sentence cara, then release
const dungeonActionId = q.recordAction(
  {
    type: "dungeon", user_id: cara.id, username: cara.name,
    reason: "Griefing spawn", duration_seconds: 86400,
    expires_at: new Date(Date.now() + 86400e3).toISOString(),
    moderator_id: "m2", moderator_name: "modB",
  },
  cara
);
assert.equal(q.currentDungeon(cara.id).active, true);
assert.equal(q.listDungeons({ status: "active" }).total, 1);
assert.equal(q.stats().activeDungeons, 1);
q.recordAction({ type: "release", user_id: cara.id, username: cara.name, reason: "Time served", moderator_id: "m2", moderator_name: "modB" }, cara);
assert.equal(q.currentDungeon(cara.id), null);
assert.equal(q.listDungeons({ status: "active" }).total, 0);
ok("dungeon sentence + release flow");

// evidence attached to the dungeon action
const evidenceDir = path.join(tmp, "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evFile = "1-test.png";
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
fs.writeFileSync(path.join(evidenceDir, evFile), PNG_1PX);
const evId = q.insertEvidence({
  action_id: dungeonActionId, kind: "file", file_name: evFile,
  original_name: "clip.png", content_type: "image/png",
  size_bytes: PNG_1PX.length, uploaded_by: "m2",
});
q.insertEvidence({ action_id: dungeonActionId, kind: "link", url: "https://medal.tv/clip/abc", uploaded_by: "m2" });
const caraHistory = q.userHistory(cara.id);
const dungeonRow = caraHistory.find((a) => a.type === "dungeon");
assert.equal(dungeonRow.evidence.length, 2);
assert.equal(dungeonRow.evidence[0].kind, "file");
assert.equal(caraHistory.find((a) => a.type === "release").evidence.length, 0);
ok("evidence rows attach to the right actions");

// action log filters
assert.equal(q.listActions({ type: "dungeon" }).total, 1);
assert.equal(q.listActions({ type: "ban" }).total, 2);
assert.equal(q.listActions({ q: "Griefing" }).total, 1);
const stats = q.stats();
assert.equal(stats.totalActions, 7);
assert.equal(stats.playersTouched, 3);
ok("action log filters + stats");

/* ── permission tiers ───────────────────────────────────── */
console.log("permission tiers");
const tierConfig = {
  discord: { modRoleIds: ["modR"], seniorRoleIds: ["senR"], logChannelId: null },
  web: { baseUrl: "http://x" },
  evidence: { dir: evidenceDir, maxMb: 25 },
};
const tiers = buildHandlers({ queries: q, roblox: {}, config: tierConfig, service: {} });
const member = (roleIds, admin = false) => ({
  permissions: { has: () => admin },
  roles: { cache: { has: (id) => roleIds.includes(id) } },
});
assert.equal(tiers.isMod(member(["modR"])), true);
assert.equal(tiers.isSenior(member(["modR"])), false); // mods can't ban
assert.equal(tiers.isMod(member(["senR"])), true);     // senior ⊇ mod
assert.equal(tiers.isSenior(member(["senR"])), true);
assert.equal(tiers.isSenior(member([], true)), true);  // admins always senior
assert.equal(tiers.isMod(member([])), false);
ok("mods can't ban; senior staff can do everything; admins pass");

/* ── web API ────────────────────────────────────────────── */
console.log("web api");
const SECRET = "test-secret";
const config = {
  discord: { clientId: "c", clientSecret: "s", guildId: "g", modRoleIds: ["r"], seniorRoleIds: [], logChannelId: null },
  web: { sessionSecret: SECRET, baseUrl: "http://localhost:0", port: 0 },
  evidence: { dir: evidenceDir, maxMb: 25 },
  game: { reportSecret: "game-secret" },
};
const robloxStub = {
  resolveUser: async (query) => {
    const s = String(query).toLowerCase();
    return s === "alicerbx" || s === "111"
      ? { id: 111, name: "AliceRBX", displayName: "Alice" }
      : null;
  },
  getUserInfo: async (id) =>
    id === 999 ? { id, name: "Fresh", displayName: "Fresh", created: "2020-01-01T00:00:00Z" } : null,
  getHeadshotUrl: async () => null,
  getRestriction: async (id) => {
    if (id === 111) throw new Error("simulated Roblox outage"); // → "couldn't check"
    return { active: false };
  },
  getDungeonSentence: async (id) =>
    id === 333
      ? { permanent: false, expiresAt: Math.floor(Date.now() / 1000) + 999, reason: "Griefing" }
      : null,
  // mutation no-ops so the service can run without the network
  banUser: async () => ({}),
  unbanUser: async () => ({}),
  setDungeonSentence: async () => ({}),
  clearDungeonSentence: async () => ({}),
  publishDungeonMove: async () => ({}),
  kickUser: async () => ({}),
};
const auditEvents = [];
const service = createModerationService({
  queries: q, roblox: robloxStub, config,
  audit: (source, event) => auditEvents.push({ source, ...event }),
});
const checkStaffStub = async (id) =>
  id === "senior1" ? { id, username: "seniorTester", senior: true }
  : id === "mod1" ? { id, username: "modTester", senior: false }
  : id === "1" ? { id, username: "tester", senior: false }
  : null;
const bridgeCalls = [];
const bridgeStub = {
  postGameReport: async (report) => bridgeCalls.push(["gameReport", report.id]),
  sendTicketReply: async (ticket, staff, text) => bridgeCalls.push(["reply", ticket.id, text]),
  webCloseSupport: async (ticket, staff) => {
    q.closeTicket(ticket.id, { closedBy: staff.id });
    bridgeCalls.push(["close", ticket.id]);
  },
};
const app = createWebServer({
  config, queries: q, roblox: robloxStub, service,
  checkStaff: checkStaffStub,
  bridge: bridgeStub,
  audit: (source, event) => auditEvents.push({ source, ...event }),
});

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const cookieFor = (user) => {
  const value = Buffer.from(JSON.stringify({ user })).toString("base64");
  const sig = new Keygrip([SECRET]).sign(`warden.sid=${value}`);
  return { Cookie: `warden.sid=${value}; warden.sid.sig=${sig}` };
};
const authedHeaders = cookieFor({ id: "1", username: "tester", displayName: "Tester" });
const seniorHeaders = { ...cookieFor({ id: "senior1", username: "seniorTester", senior: true }), "Content-Type": "application/json" };
const modHeaders = { ...cookieFor({ id: "mod1", username: "modTester", senior: false }), "Content-Type": "application/json" };

let res = await fetch(`${base}/api/me`);
assert.equal(res.status, 401);
ok("unauthenticated → 401");

res = await fetch(`${base}/api/me`, { headers: authedHeaders });
assert.equal(res.status, 200);
ok("signed session cookie accepted");

res = await fetch(`${base}/api/stats`, { headers: authedHeaders });
const s = await res.json();
assert.equal(s.totalActions, 7);
assert.equal(typeof s.activeDungeons, "number");
ok("stats endpoint");

res = await fetch(`${base}/api/bans?status=all`, { headers: authedHeaders });
assert.equal((await res.json()).total, 1);
ok("bans endpoint");

res = await fetch(`${base}/api/dungeon?status=all`, { headers: authedHeaders });
assert.equal((await res.json()).total, 0); // cara was released
ok("dungeon endpoint");

res = await fetch(`${base}/api/actions?type=dungeon`, { headers: authedHeaders });
const dngActions = await res.json();
assert.equal(dngActions.total, 1);
assert.equal(dngActions.rows[0].evidence.length, 2);
ok("actions endpoint includes evidence");

res = await fetch(`${base}/api/users/333`, { headers: authedHeaders });
const caraData = await res.json();
assert.equal(caraData.dungeonStatus.active, true); // live sentence from stub
assert.equal(caraData.currentDungeon, null);       // but local record released
ok("user endpoint reports live dungeon status");

res = await fetch(`${base}/api/users/111`, { headers: authedHeaders });
const profile = await res.json();
assert.equal(profile.profile.username, "AliceRBX");
assert.equal(profile.robloxStatus, null);
ok("user endpoint survives Roblox outage");

res = await fetch(`${base}/evidence/${evId}`, { headers: authedHeaders });
assert.equal(res.status, 200);
assert.equal(res.headers.get("content-type"), "image/png");
assert.equal((await res.arrayBuffer()).byteLength, PNG_1PX.length);
ok("evidence file served with auth");

res = await fetch(`${base}/evidence/${evId}`);
assert.equal(res.status, 401);
ok("evidence file blocked without auth");

res = await fetch(`${base}/api/users/notanid`, { headers: authedHeaders });
assert.equal(res.status, 400);
ok("bad user id → 400");

res = await fetch(`${base}/`);
assert.equal(res.status, 200);
assert.ok((await res.text()).includes("GuildCat"));
ok("static dashboard served");

/* ── web moderation actions ─────────────────────────────── */
console.log("web moderation");

// mods can't ban from the web
res = await fetch(`${base}/api/mod/ban`, {
  method: "POST", headers: modHeaders,
  body: JSON.stringify({ user: "AliceRBX", reason: "web test", duration: "" }),
});
assert.equal(res.status, 403);
ok("web ban blocked for normal mods");

// senior staff can
res = await fetch(`${base}/api/mod/ban`, {
  method: "POST", headers: seniorHeaders,
  body: JSON.stringify({ user: "AliceRBX", reason: "web ban test", duration: "1d" }),
});
assert.equal(res.status, 200);
assert.equal(q.currentBan(111).active, true);
ok("web ban works for senior staff");

// mods can dungeon from the web
res = await fetch(`${base}/api/mod/dungeon`, {
  method: "POST", headers: modHeaders,
  body: JSON.stringify({ user: "AliceRBX", reason: "web dungeon test", duration: "1h" }),
});
assert.equal(res.status, 200);
const dungeonedNow = q.currentDungeon(111);
assert.equal(dungeonedNow.active, true);
ok("web dungeon works for mods");

// deleting the entry behind an ACTIVE sentence is refused
const backingActionId = dungeonedNow.id;
res = await fetch(`${base}/api/mod/actions/${backingActionId}`, {
  method: "DELETE", headers: seniorHeaders,
});
assert.equal(res.status, 409);
ok("delete blocked while sentence is active");

// release, then the delete goes through
res = await fetch(`${base}/api/mod/release`, {
  method: "POST", headers: modHeaders,
  body: JSON.stringify({ user: "111" }),
});
assert.equal(res.status, 200);
res = await fetch(`${base}/api/mod/actions/${backingActionId}`, {
  method: "DELETE", headers: seniorHeaders,
});
assert.equal(res.status, 200);
assert.ok(!q.userHistory(111).some((a) => a.id === backingActionId));
ok("release then delete removes the entry");

// deletes are senior-only
res = await fetch(`${base}/api/mod/actions/1`, { method: "DELETE", headers: modHeaders });
assert.equal(res.status, 403);
ok("delete blocked for normal mods");

// web unban clears the ban state
res = await fetch(`${base}/api/mod/unban`, {
  method: "POST", headers: seniorHeaders,
  body: JSON.stringify({ user: "111" }),
});
assert.equal(res.status, 200);
assert.equal(q.currentBan(111), null);
ok("web unban clears the ban");

// bad target → 400 with a message
res = await fetch(`${base}/api/mod/warn`, {
  method: "POST", headers: modHeaders,
  body: JSON.stringify({ user: "nobody-here", reason: "x" }),
});
assert.equal(res.status, 400);
ok("unknown player → 400");

// audit events carried the right source + details
assert.ok(auditEvents.some((e) => e.source === "web" && e.type === "ban" && e.player.id === 111));
assert.ok(auditEvents.some((e) => e.source === "web" && e.type === "dungeon"));
assert.ok(auditEvents.some((e) => e.source === "web" && e.type === "delete" && e.deleted?.type === "dungeon"));
assert.ok(auditEvents.every((e) => e.moderator?.name));
ok("audit events fired with web source and details");

/* ── in-game reports ────────────────────────────────────── */
console.log("in-game reports");

res = await fetch(`${base}/api/game/report`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ reporter: { id: 1 }, target: { id: 2 }, reason: "flying around" }),
});
assert.equal(res.status, 401);
ok("game report without the secret → 401");

res = await fetch(`${base}/api/game/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-warden-key": "game-secret" },
  body: JSON.stringify({ reporter: { id: 1 }, target: { id: 2 }, reason: "x" }),
});
assert.equal(res.status, 400);
ok("game report with a junk reason → 400");

res = await fetch(`${base}/api/game/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-warden-key": "game-secret" },
  body: JSON.stringify({
    reporter: { id: 555, name: "GoodGuy" },
    target: { id: 666, name: "BadGuy" },
    reason: "killing through walls",
    placeId: "123", jobId: "abc-def",
  }),
});
assert.equal(res.status, 200);
const gameReport = await res.json();
assert.ok(gameReport.id > 0);
await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget bridge run
assert.ok(bridgeCalls.some(([kind, id]) => kind === "gameReport" && id === gameReport.id));
ok("game report accepted and relayed to Discord");

res = await fetch(`${base}/api/reports?status=open`, { headers: authedHeaders });
const openReports = await res.json();
assert.equal(openReports.total, 1);
assert.equal(openReports.rows[0].target_name, "BadGuy");
assert.equal(openReports.rows[0].job_id, "abc-def");
ok("reports list shows the open report");

res = await fetch(`${base}/api/mod/reports/${gameReport.id}/handled`, {
  method: "POST", headers: modHeaders,
});
assert.equal(res.status, 200);
assert.equal(q.getReport(gameReport.id).status, "handled");
assert.ok(auditEvents.some((e) => e.type === "report_handled" && e.source === "web"));
ok("mod can mark a report handled (audited)");

// same reporter reporting the same target again → accepted quietly, stored once
res = await fetch(`${base}/api/game/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-warden-key": "game-secret" },
  body: JSON.stringify({
    reporter: { id: 555, name: "GoodGuy" },
    target: { id: 666, name: "BadGuy" },
    reason: "still killing through walls",
  }),
});
assert.equal(res.status, 200);
assert.equal((await res.json()).duplicate, true);
assert.equal(q.listReports({ status: "all" }).total, 1);
ok("second report about the same player is dropped as a duplicate");

// blacklisted reporters get shadow-dropped
q.blacklistReporter({ user_id: 555, username: "GoodGuy", reason: "spamming fake reports", added_by: "modTester" });
assert.equal(q.isReporterBlacklisted(555), true);
res = await fetch(`${base}/api/game/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-warden-key": "game-secret" },
  body: JSON.stringify({
    reporter: { id: 555, name: "GoodGuy" },
    target: { id: 777, name: "SomeoneElse" },
    reason: "made-up nonsense report",
  }),
});
assert.equal(res.status, 200); // the game still hears "ok" — shadow-blocked
assert.equal(q.listReports({ status: "all" }).total, 1);
assert.ok(q.unblacklistReporter(555));
assert.equal(q.isReporterBlacklisted(555), false);
ok("blacklisted reporter is shadow-dropped; remove works");

/* ── honeypot ───────────────────────────────────────────── */
console.log("honeypot");

const bridgeHoney = [];
bridgeStub.postHoneypotHit = async (hit) => bridgeHoney.push(hit);

res = await fetch(`${base}/api/game/honeypot`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ player: { id: 9 }, remote: "GiveCoins" }),
});
assert.equal(res.status, 401);
ok("honeypot without the secret → 401");

const honeyPost = (body) =>
  fetch(`${base}/api/game/honeypot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-warden-key": "game-secret" },
    body: JSON.stringify(body),
  });

// the game's contract: /api/game/trap with user + running total
const trapPost = (body) =>
  fetch(`${base}/api/game/trap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-warden-key": "game-secret" },
    body: JSON.stringify(body),
  });

res = await trapPost({ user: { id: 777, name: "Cheater77" }, remote: "GiveCash",
  total: 1, placeId: "123", jobId: "srv-1" });
assert.equal(res.status, 200);
res = await trapPost({ user: { id: 777, name: "Cheater77" }, remote: "SetWalkSpeed", total: 2 });
assert.equal(res.status, 200);
// resend with the same total → dropped as a duplicate
res = await trapPost({ user: { id: 777, name: "Cheater77" }, remote: "SetWalkSpeed", total: 2 });
assert.equal((await res.json()).duplicate, true);
res = await honeyPost({ player: { id: 778, name: "Cheater78" }, remote: "GiveCoins" });
assert.equal(res.status, 200);
await new Promise((r) => setTimeout(r, 50));
assert.equal(q.pendingHoneypotHits().length, 3);
assert.equal(q.pendingHoneypotUserCount(), 2);
// every recorded (non-duplicate) hit is handed to the bot; the bot itself
// decides whether to actually post (one live message per player)
assert.equal(bridgeHoney.length, 3);
ok("trap hits stack, dedupe by running total, handed to the bot");

const punished = q.markHoneypotPunished("seniorTester");
assert.equal(punished, 3);
assert.equal(q.pendingHoneypotHits().length, 0);
assert.equal(q.userHasPendingHoneypot(777), false);
ok("punishing clears the stack");

/* ── tickets ────────────────────────────────────────────── */
console.log("tickets");

const supportId = q.createTicket({
  kind: "support", channel_id: "chan-1", opener_id: "u9", opener_tag: "player9",
  subject: "Lost my stuff", details: "I lost my kit after a crash",
});
q.addTicketMessage({
  ticket_id: supportId, author_id: "u9", author_name: "player9", content: "I lost my kit after a crash",
});
const reportTicketId = q.createTicket({
  kind: "report", channel_id: "chan-2", opener_id: "u10", opener_tag: "player10",
  subject: "BadGuy", details: "he was flying",
});

res = await fetch(`${base}/api/tickets?status=open`, { headers: authedHeaders });
assert.equal((await res.json()).total, 2);
ok("tickets list");

res = await fetch(`${base}/api/tickets/${supportId}`, { headers: authedHeaders });
let thread = await res.json();
assert.equal(thread.ticket.kind, "support");
assert.equal(thread.messages.length, 1);
ok("ticket thread endpoint");

res = await fetch(`${base}/api/mod/tickets/${supportId}/reply`, {
  method: "POST", headers: modHeaders,
  body: JSON.stringify({ text: "We got you — checking now." }),
});
assert.equal(res.status, 200);
assert.ok(bridgeCalls.some(([k, id, text]) => k === "reply" && id === supportId && text.includes("got you")));
res = await fetch(`${base}/api/tickets/${supportId}`, { headers: authedHeaders });
thread = await res.json();
assert.equal(thread.messages.length, 2);
assert.equal(thread.messages[1].via, "web");
ok("web reply reaches Discord and lands in the transcript");

// report tickets can NOT be closed from the web
res = await fetch(`${base}/api/mod/tickets/${reportTicketId}/close`, {
  method: "POST", headers: modHeaders,
});
assert.equal(res.status, 409);
ok("report ticket refuses web close (must use /close in Discord)");

// support tickets can
res = await fetch(`${base}/api/mod/tickets/${supportId}/close`, {
  method: "POST", headers: modHeaders,
});
assert.equal(res.status, 200);
assert.equal(q.getTicket(supportId).status, "closed");
assert.ok(auditEvents.some((e) => e.type === "ticket_close"));
ok("support ticket closes from the web (audited)");

// replying to a closed ticket is refused
res = await fetch(`${base}/api/mod/tickets/${supportId}/reply`, {
  method: "POST", headers: modHeaders,
  body: JSON.stringify({ text: "too late" }),
});
assert.equal(res.status, 409);
ok("no replies on closed tickets");

// closing a report ticket the right way: service.report files the record entry
const reported = { id: 666, name: "BadGuy", displayName: "Bad Guy" };
const { actionId: reportActionId } = service.report(reported, {
  reason: `Player report (ticket #${reportTicketId}) — reporter: player10 (u10). Outcome: dungeoned`,
  moderator: { id: "mod1", name: "modTester", via: "discord" },
});
q.closeTicket(reportTicketId, { closedBy: "mod1", closeActionId: reportActionId });
assert.equal(q.getTicket(reportTicketId).close_action_id, reportActionId);
assert.equal(q.userHistory(666)[0].type, "report");
res = await fetch(`${base}/api/actions?type=report`, { headers: authedHeaders });
assert.ok((await res.json()).total >= 1);
assert.ok(auditEvents.some((e) => e.type === "report" && e.player?.id === 666));
ok("closing a report ticket files a report entry on the player");

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nAll good — ${passed} checks passed.`);
