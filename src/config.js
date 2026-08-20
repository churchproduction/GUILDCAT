// Central config: reads .env (if present) and process.env, validates what's required.
import fs from "node:fs";
import path from "node:path";

// Tiny .env loader — no dependency needed.
function loadDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

const idList = (name) =>
  env(name, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  discord: {
    token: env("DISCORD_TOKEN"),
    clientId: env("DISCORD_CLIENT_ID"),
    clientSecret: env("DISCORD_CLIENT_SECRET"),
    guildId: env("GUILD_ID"),
    modRoleIds: idList("MOD_ROLE_IDS"),
    seniorRoleIds: idList("SENIOR_ROLE_IDS"),
    logChannelId: env("LOG_CHANNEL_ID", null),
    reportChannelId: env("REPORT_CHANNEL_ID", null),     // in-game exploit reports land here
    ticketCategoryId: env("TICKET_CATEGORY_ID", null),   // ticket channels are created under this category
    ticketPingRoleIds: idList("TICKET_PING_ROLE_IDS"),   // pinged when a ticket opens (falls back to MOD_ROLE_IDS)
  },
  game: {
    reportSecret: env("GAME_REPORT_SECRET", null),       // shared secret the game script sends
  },
  roblox: {
    apiKey: env("ROBLOX_API_KEY"),
    universeId: env("ROBLOX_UNIVERSE_ID"),
    kickTopic: env("ROBLOX_KICK_TOPIC", "WardenKick"),
    dungeonTopic: env("ROBLOX_DUNGEON_TOPIC", "WardenDungeon"),
    dungeonDatastore: env("DUNGEON_DATASTORE", "WardenDungeon"),
  },
  evidence: {
    dir: env("EVIDENCE_DIR", "./evidence"),
    maxMb: Number(env("EVIDENCE_MAX_MB", "25")),
  },
  webhooks: {
    discord: env("DISCORD_AUDIT_WEBHOOK", null), // actions run via Discord commands
    web: env("WEB_AUDIT_WEBHOOK", null),         // actions taken on the website
  },
  web: {
    sessionSecret: env("SESSION_SECRET"),
    baseUrl: env("BASE_URL", "http://localhost:3000").replace(/\/+$/, ""),
    port: Number(env("PORT", "3000")),
  },
  dbPath: env("DB_PATH", "./warden.db"),
};

// Returns a list of problems; empty list means we're good to boot.
export function validateConfig() {
  const problems = [];
  const need = [
    ["DISCORD_TOKEN", config.discord.token],
    ["DISCORD_CLIENT_ID", config.discord.clientId],
    ["DISCORD_CLIENT_SECRET", config.discord.clientSecret],
    ["GUILD_ID", config.discord.guildId],
    ["ROBLOX_API_KEY", config.roblox.apiKey],
    ["ROBLOX_UNIVERSE_ID", config.roblox.universeId],
    ["SESSION_SECRET", config.web.sessionSecret],
  ];
  for (const [name, value] of need) {
    if (!value) problems.push(`Missing ${name} — see .env.example`);
  }
  if (config.web.sessionSecret === "change-me") {
    problems.push("SESSION_SECRET is still the placeholder — generate a real one");
  }
  if (config.discord.modRoleIds.length === 0) {
    problems.push("MOD_ROLE_IDS is empty — nobody would be able to use the bot or dashboard");
  }
  return problems;
}

// Non-fatal heads-ups printed at boot.
export function configWarnings() {
  const warnings = [];
  if (config.discord.seniorRoleIds.length === 0) {
    warnings.push(
      "SENIOR_ROLE_IDS is empty — only server administrators will be able to /ban and /unban."
    );
  }
  if (!config.discord.reportChannelId) {
    warnings.push(
      "REPORT_CHANNEL_ID is not set — in-game exploit reports will only show on the dashboard, not in Discord."
    );
  }
  if (!config.game.reportSecret) {
    warnings.push(
      "GAME_REPORT_SECRET is not set — the in-game report endpoint is disabled until you set one."
    );
  }
  return warnings;
}
