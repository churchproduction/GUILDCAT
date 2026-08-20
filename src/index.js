// Boot: config → database → Discord bot → web server. One process runs it all.
import fs from "node:fs";
import { config, validateConfig, configWarnings } from "./config.js";
import { openDb, makeQueries } from "./db.js";
import { createRobloxClient } from "./roblox.js";
import { createModerationService } from "./actions.js";
import { createAuditWebhooks } from "./webhook.js";
import { startBot } from "./bot/client.js";
import { createWebServer } from "./web/server.js";

const problems = validateConfig();
if (problems.length) {
  console.error("Can't start — fix these first:\n" + problems.map((p) => `  • ${p}`).join("\n"));
  process.exit(1);
}
for (const w of configWarnings()) console.warn(`Heads up: ${w}`);

fs.mkdirSync(config.evidence.dir, { recursive: true });
const db = openDb(config.dbPath);
const queries = makeQueries(db);
const roblox = createRobloxClient(config.roblox);
const audit = createAuditWebhooks(config);
const service = createModerationService({ queries, roblox, config, audit });

const { checkStaff, bridge } = await startBot({ config, queries, roblox, service });

const app = createWebServer({ config, queries, roblox, service, checkStaff, bridge, audit });
app.listen(config.web.port, () => {
  console.log(`Web: dashboard on ${config.web.baseUrl} (port ${config.web.port})`);
  // Confirm the honeypot wiring right in the boot log, so it's obvious if a var is missing.
  console.log(
    `Honeypot: channel ${config.honeypot.channelId ? "set ✓" : "NOT SET ✗"}, ` +
    `admin roles ${config.honeypot.adminRoleIds.length || "NONE ✗"}, ` +
    `game secret ${config.game.reportSecret ? "set ✓" : "NOT SET ✗"}, ` +
    `sentence ${config.honeypot.sentence}`
  );
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
