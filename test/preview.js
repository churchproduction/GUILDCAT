// Dev preview: boots the dashboard on :4455 with seeded fake data and prints
// a signed cookie so you (or a screenshot tool) can view it without Discord.
// Not used in production.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Keygrip from "keygrip";
import { openDb, makeQueries } from "../src/db.js";
import { createWebServer } from "../src/web/server.js";
import { createModerationService } from "../src/actions.js";

const db = openDb(":memory:");
const q = makeQueries(db);

const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "warden-preview-ev-"));
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const players = [
  { id: 101, name: "xX_Blitz_Xx", displayName: "Blitz" },
  { id: 202, name: "NoClipNancy", displayName: "Nancy" },
  { id: 303, name: "CartRacer99", displayName: "Speedy" },
  { id: 404, name: "TentThief", displayName: "TentThief" },
  { id: 505, name: "MildAnnoyance", displayName: "Milo" },
];
const mods = [["m1", "matt"], ["m2", "brooke_mod"], ["m3", "sentinel"]];
const reasons = {
  ban: ["Exploiting — speed hacks", "Chat bypass, repeated", "Scamming other players"],
  dungeon: ["Griefing spawn", "Team-killing after warnings", "Blocking the track on purpose"],
  release: ["Time served, behaved in the dungeon", "Appealed on Discord"],
  kick: ["AFK farming", "Mic spam in voice area"],
  warn: ["Language", "Spamming purchase prompts", "Toxicity in chat"],
  note: ["Claims the ban was a sibling — watch account", "Helpful in reports, credible witness"],
  unban: ["Appealed on Discord, accepted"],
};
const pick = (arr, i) => arr[i % arr.length];

let t = 0;
const backdate = (days) => new Date(Date.now() - days * 86400000 - (t++ % 7) * 3600000).toISOString();
const insert = db.prepare(`INSERT INTO actions (type,user_id,username,reason,display_reason,duration_seconds,expires_at,exclude_alts,moderator_id,moderator_name,created_at)
  VALUES (@type,@user_id,@username,@reason,@display_reason,@duration_seconds,@expires_at,@exclude_alts,@moderator_id,@moderator_name,@created_at)`);
const upsertP = db.prepare(`INSERT OR REPLACE INTO players (user_id,username,display_name,avatar_url,created_on,updated_at)
  VALUES (?,?,?,NULL,'2019-06-12T00:00:00Z',?)`);

for (const pl of players) upsertP.run(pl.id, pl.name, pl.displayName, new Date().toISOString());

const types = ["warn", "kick", "dungeon", "warn", "note", "release", "warn", "kick", "dungeon", "unban"];
for (let i = 0; i < 34; i++) {
  const pl = pick(players, i);
  const type = pick(types, i);
  const [mid, mname] = pick(mods, i);
  insert.run({
    type, user_id: pl.id, username: pl.name,
    reason: pick(reasons[type], i), display_reason: null,
    duration_seconds: type === "dungeon" ? (i % 2 ? 86400 : 3600) : null,
    expires_at: null, exclude_alts: 0,
    moderator_id: mid, moderator_name: mname,
    created_at: backdate(28 - i * 0.8),
  });
}

const setState = (table) => (pl, durationSeconds, expiresAt, when, reason, evidence = []) => {
  const info = insert.run({
    type: table === "bans" ? "ban" : "dungeon",
    user_id: pl.id, username: pl.name, reason,
    display_reason: table === "bans" ? "You broke the rules. Appeal on our Discord." : null,
    duration_seconds: durationSeconds, expires_at: expiresAt,
    exclude_alts: table === "bans" ? 1 : 0,
    moderator_id: "m1", moderator_name: "matt", created_at: when,
  });
  const actionId = Number(info.lastInsertRowid);
  db.prepare(`INSERT OR REPLACE INTO ${table} (user_id, action_id, expires_at, created_at) VALUES (?,?,?,?)`)
    .run(pl.id, actionId, expiresAt, when);
  for (const ev of evidence) q.insertEvidence({ action_id: actionId, uploaded_by: "m1", ...ev });
  return actionId;
};
const mkBan = setState("bans");
const mkDungeon = setState("dungeons");

// Evidence files on disk
const shot1 = "shot1.png";
fs.writeFileSync(path.join(evidenceDir, shot1), PNG_1PX);

mkBan(players[0], null, null, backdate(2), "Exploiting — teleport cheats, second offense", [
  { kind: "file", file_name: shot1, original_name: "teleport_clip.png", content_type: "image/png", size_bytes: PNG_1PX.length },
  { kind: "link", url: "https://medal.tv/clips/blitz-teleport" },
]);
mkBan(players[1], 604800, new Date(Date.now() + 4.5 * 86400000).toISOString(), backdate(3), "Chat bypass, repeated");

mkDungeon(players[3], null, null, backdate(1), "Stealing tents from new players, third offense", [
  { kind: "link", url: "https://youtu.be/tent-heist-evidence" },
]);
mkDungeon(players[4], 86400, new Date(Date.now() + 15 * 3600000).toISOString(), backdate(0.4), "Blocking the track on purpose", [
  { kind: "file", file_name: shot1, original_name: "track_block.png", content_type: "image/png", size_bytes: PNG_1PX.length },
]);
mkDungeon(players[2], 3600, new Date(Date.now() - 2 * 86400000).toISOString(), backdate(2.5), "Ramming karts in the lobby");

const SECRET = "preview-secret";
const config = {
  discord: { clientId: "c", clientSecret: "s", guildId: "g", modRoleIds: ["r"], seniorRoleIds: ["s"], logChannelId: null },
  web: { sessionSecret: SECRET, baseUrl: "http://localhost:4455", port: 4455 },
  evidence: { dir: evidenceDir, maxMb: 25 },
};
const robloxStub = {
  // any name/id resolves so the action buttons work in the preview
  resolveUser: async (query) => {
    const s = String(query).trim();
    const known = players.find((p) => p.name.toLowerCase() === s.toLowerCase() || String(p.id) === s);
    if (known) return { id: known.id, name: known.name, displayName: known.displayName };
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 99999;
    return { id: 900000 + h, name: s, displayName: s };
  },
  getUserInfo: async () => null,
  getHeadshotUrl: async () => null,
  getRestriction: async (id) => ({ active: id === 101 }),
  getDungeonSentence: async (id) =>
    id === 404
      ? { permanent: true, reason: "Stealing tents" }
      : id === 505
        ? { permanent: false, expiresAt: Math.floor(Date.now() / 1000) + 15 * 3600, reason: "Blocking the track" }
        : null,
  banUser: async () => ({}),
  unbanUser: async () => ({}),
  setDungeonSentence: async () => ({}),
  clearDungeonSentence: async () => ({}),
  publishDungeonMove: async () => ({}),
  kickUser: async () => ({}),
};
const service = createModerationService({ queries: q, roblox: robloxStub, config });
const previewStaff = { id: "1", username: "preview", displayName: "Preview mode", senior: true };
const app = createWebServer({
  config, queries: q, roblox: robloxStub, service,
  checkStaff: async () => previewStaff,
});

// Preview-only: skip Discord sign-in entirely. This route exists only here,
// never in the real app.
app.get("/preview-login", (req, res) => {
  req.session.user = previewStaff;
  res.redirect("/");
});

app.listen(4455, () => {
  console.log("");
  console.log("  Warden preview is up (sample data, no Discord/Roblox needed)");
  console.log("  →  open  http://localhost:4455/preview-login");
  console.log("");
  const val = Buffer.from(JSON.stringify({ user: { id: "1", username: "matt", displayName: "matt" } })).toString("base64");
  const sig = new Keygrip([SECRET]).sign(`warden.sid=${val}`);
  console.log(`  (cookie for tooling: warden.sid=${val}; warden.sid.sig=${sig})`);
});
