# Warden

A Discord moderation bot for your Roblox game, with a staff-only web dashboard.

From Discord, staff can ban, dungeon, kick, warn, and audit any Roblox player,
attaching image/video evidence as they go. Every action lands in one database,
and the dashboard gives your team a searchable view of all bans, dungeon
sentences, evidence, and each player's full audit history.

**Commands & tiers**

| Command | Who | What it does |
|---|---|---|
| `/ban user reason [duration] [display_reason] [include_alts] [evidence]` | **Senior staff** | Platform-level game ban via Roblox's User Restrictions API. Duration like `30m`, `2h`, `7d` — omit for permanent. Roblox enforces it and boots them mid-session. |
| `/unban user [reason]` | **Senior staff** | Lifts the ban. |
| `/dungeon user duration reason [evidence]` | Moderators | Sentences the player to the dungeon servers — 1 minute, 1 hour, 1 day, 1 week, or permanent. They're moved immediately if in game, and routed to the dungeon on every join until the sentence ends. |
| `/release user [reason]` | Moderators | Ends a dungeon sentence early and sends them back to the main game. |
| `/kick user [reason] [evidence]` | Moderators | Removes the player from the server they're in right now. |
| `/warn user reason [evidence]` | Moderators | Logs a warning to their record. |
| `/note user text [evidence]` | Moderators | Attaches a staff note to their record. |
| `/evidence user [file] [link] [context]` | Moderators | Adds evidence to a player's record on its own. |
| `/audit user` | Moderators | Full record: live ban + dungeon status, counts, recent history, dashboard link. |
| `/blacklist add\|remove\|list user [reason]` | Moderators | Blocks a Roblox user from sending in-game exploit reports (shadow-blocked: they still see "thanks", nothing arrives). One report per reporter per target is also enforced automatically. |
| `/ticketpanel [type] [report_image] [support_image]` | **Senior staff** | Posts the ticket panels in the current channel — the red "EXPLOITER REPORT" panel and/or the blue "GENERAL SUPPORT" panel, each with its own button. Attach banner images to match your server's look. Opening a ticket pings `TICKET_PING_ROLE_IDS` (or the mod roles if unset). |
| `/close [player] [evidence_link] [evidence] [reporter] [notes]` | Moderators | Closes the ticket you run it in. Support tickets need no options. **User-report tickets require** `player` (the reported Roblox username) and evidence (`evidence_link` or an `evidence` file); the reporter defaults to whoever opened the ticket. Closing files a "Player report" entry with the evidence on that player's record. |

`user` accepts a username, a numeric user ID, or a profile URL everywhere.
Server administrators always count as senior staff. Every command takes an
optional image/video attachment and/or a video link as evidence — files are
downloaded and stored by Warden (Discord's own links expire), then shown on
the dashboard.

**Tickets:** post the panel once with `/ticketpanel`. A member picks User
Report or Support Ticket, fills the little form, and a private channel opens
that only they + the mod roles can see — with a ping to the mod roles. Every
ticket mirrors live to the dashboard's **Tickets** page, where staff can read
the whole conversation and reply (replies appear in the Discord channel from
the bot). Support tickets close from the button, `/close`, or the dashboard.
User-report tickets only close via `/close` with the paperwork — that's what
writes the report onto the player's record. Closed ticket channels are
deleted; the transcript stays on the dashboard.

**In-game reports:** players report exploiters from inside the game (your
report dialog). Each report lands in `REPORT_CHANNEL_ID` with a **Join their
server** button that puts a mod into the exact server it came from, and on
the dashboard's **Reports** page with the same button. Mods mark them handled
there. Setup is one ModuleScript — see `roblox/WardenReportRelay.lua`, three
steps at the top of the file.

**Honeypot (fake remotes):** the game carries bait RemoteEvents no honest
player can ever fire — only exploiters reach them. Every catch posts to
`HONEYPOT_CHANNEL_ID` and stacks. One button — allowed only for
`HONEYPOT_ADMIN_ROLE_IDS` (plus the server owner) — sends the entire stack to
the dungeon (`HONEYPOT_SENTENCE`, default permanent), files a Dungeon entry
per player with the auto reason, and attaches everything they fired as text
evidence. Game side is one script: `roblox/4-Honeypot-Server.lua`.

**How the dungeon works:** the dungeon is a pool of hidden private servers of
your own game (reserved servers) — same map, always your latest version,
because it *is* your game. The bot writes the sentence to a DataStore and
pings live servers; the Warden game script teleports sentenced players into a
dungeon server (instantly if playing, or at their next join), spreads them
across the pool so big games scale, keeps everyone else out — matchmaking can
never place normal players there — and sends players back to a public server
when their time is up or they're released. Pool size is `DUNGEON_SERVERS` at
the top of the script (default 5); raise it any time.

---

## Setup

Four steps: Discord app, Roblox API key, one game script, deploy.
Ten minutes, give or take.

### 1. Discord application

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → *Reset Token* → copy it → that's `DISCORD_TOKEN`.
   - On the same page, enable the **Server Members Intent** (used to check
     staff roles for dashboard sign-in) **and the Message Content Intent**
     (used to mirror ticket messages to the dashboard).
3. **OAuth2** tab:
   - Copy the **Client ID** → `DISCORD_CLIENT_ID`.
   - *Reset Secret* → copy it → `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, add: `https://YOUR-APP-URL/auth/callback`
     (and `http://localhost:3000/auth/callback` for local testing).
4. Invite the bot: OAuth2 → URL Generator → scopes `bot` +
   `applications.commands`, bot permissions **Send Messages**, **Manage
   Channels** (creates/deletes ticket channels), and **Mention Everyone**
   (so ticket pings reach the mod roles) — open the generated URL and pick
   your server. Already invited? Re-invite with the new URL; it just updates
   permissions.
5. Grab IDs (enable *Developer Mode* in Discord settings → Advanced first):
   - Right-click your server → Copy Server ID → `GUILD_ID`.
   - Right-click each normal moderator role → Copy Role ID → `MOD_ROLE_IDS`
     (comma-separated).
   - Right-click each senior staff role → Copy Role ID → `SENIOR_ROLE_IDS`.
     Only these roles (and admins) can `/ban` and `/unban`.
   - Optional: a channel ID → `LOG_CHANNEL_ID` to mirror every action there.

### 2. Roblox Open Cloud API key

1. Go to https://create.roblox.com/dashboard/credentials → **Create API Key**.
   (If the game is group-owned, create the key under the group.)
2. Add your experience under **Access Permissions**, and grant:
   - **User Restrictions** → Read and Write — powers `/ban`, `/unban`, `/audit`
   - **Messaging Service** → Publish — powers `/kick` and instant dungeon moves
   - **DataStores** → read/write/delete entries — powers `/dungeon`, `/release`
3. Set *Accepted IP Addresses* to `0.0.0.0/0` unless your host has a static IP.
4. Copy the key → `ROBLOX_API_KEY`.
5. Find your **Universe ID** (not the place ID): Creator Dashboard → your
   experience → the `universeId` on the experience page/URL → `ROBLOX_UNIVERSE_ID`.

### 3. The game script (one script, done)

In Roblox Studio, add a **Script** (not Local/Module) to `ServerScriptService`
of your game, paste in `roblox/Warden.server.lua`, and publish. Nothing to
configure — no second place, no place IDs.

The dungeon is a hidden private server of your own game that the script
creates and manages by itself. Update your game like normal; the dungeon is
always identical because it's the same game.

Bans need no game changes at all — Roblox enforces those itself.

(Heads up: teleports don't run in Studio's Play test — test the dungeon in
the real published game.)

### 4. Run it

> **Heads up:** this isn't a static site — the dashboard is served by the app
> itself, so opening `public/index.html` from the folder shows a "can't reach
> the server" screen, and Netlify-style drag-and-drop hosting won't work. The
> whole thing (bot + website + database) is ONE Node process that has to stay
> running, which is why it deploys to Railway/Render from a GitHub repo.

**Just want to see the dashboard first?** No setup needed:

```bash
npm install
npm run preview        # sample data, no Discord/Roblox required
# then open http://localhost:4455/preview-login
```

**Run it for real, locally:**

```bash
cp .env.example .env   # fill it in
npm install
npm start              # bot connects + dashboard on http://localhost:3000
```

**Railway:**

1. Push this folder to a GitHub repo, then in Railway: New Project → Deploy
   from GitHub repo.
2. Add a **Volume** to the service, mounted at `/data`.
3. Set the variables from `.env.example`, with:
   - `DB_PATH=/data/warden.db`
   - `EVIDENCE_DIR=/data/evidence`
   - `BASE_URL=https://your-service.up.railway.app`
4. Add `https://your-service.up.railway.app/auth/callback` to the Discord
   app's OAuth2 redirects.

**Render:** same idea — a Web Service from the repo, a Persistent Disk at
`/data`, `DB_PATH=/data/warden.db`, `EVIDENCE_DIR=/data/evidence`, and the
env vars. Render uses the included `Dockerfile` automatically.

Back up by copying `/data` — the SQLite file plus the evidence folder is the
entire moderation record.

## The dashboard

A public entrance page (storm, longship, GUILD CAT) with an ENTER button that
goes to Discord sign-in — restricted to `MOD_ROLE_IDS` + `SENIOR_ROLE_IDS`.
Inside: an overview with activity stats; searchable ban and dungeon lists
(active/expired); the full action log; and a profile page per player with
live ban + dungeon status, their complete timeline, and every piece of
attached evidence (images inline, videos playable, links out).

The dashboard also **acts**, with the same rules as Discord — roles re-checked
against your server on every single request:

| Web control | Who |
|---|---|
| New ban / Unban buttons | Senior staff |
| Delete a log entry (✕) — blocked while it backs an active ban/sentence | Senior staff |
| Send to dungeon / Release / Kick / Warn / Note | All mods |

Buttons senior staff can use simply don't render for normal mods — and the
server would refuse them anyway. Works on phones: the sidebar becomes a
bottom tab bar.

## Audit webhooks

Two optional Discord webhook feeds, so every judgment is witnessed:

- `DISCORD_AUDIT_WEBHOOK` — every action run through **Discord commands**
- `WEB_AUDIT_WEBHOOK` — everything done on the **website**: web bans, unbans,
  dungeon sends, releases, kicks, warns, notes, and **deleted log entries**
  (the deletion post shows what the entry said and who deleted it)

Create each in Discord: pick a channel → Edit Channel → Integrations →
Webhooks → New Webhook → Copy Webhook URL → paste into the env var. Set one,
both, or neither. Posts are fire-and-forget — a down webhook never blocks or
slows an action.

## Troubleshooting

- **`/ban` returns 401/403** — the API key is missing User Restrictions write
  for *this* experience, the IP allowlist blocks your host, or the key was
  created under the wrong owner (personal vs. group).
- **`/dungeon` works but players aren't routed** — the Warden script isn't in
  `ServerScriptService` of the *published* game, the API key lacks DataStores
  permissions, or you're testing in Studio (teleports only work in the real
  game).
- **`/kick` succeeds but nobody gets kicked** — script missing from the
  published place, topic names don't match, or the player already left.
- **Evidence won't save** — only images/videos are accepted, the file exceeds
  `EVIDENCE_MAX_MB`, or `EVIDENCE_DIR` isn't writable (on Railway/Render,
  point it at the mounted volume).
- **Dashboard says you're not staff** — your account lacks a `MOD_ROLE_IDS` /
  `SENIOR_ROLE_IDS` role in the guild, or the Server Members Intent is off.
- **OAuth error on sign-in** — the exact `BASE_URL/auth/callback` URL isn't in
  the Discord app's redirect list.
- **Commands don't appear** — the bot was invited without the
  `applications.commands` scope, or you're in a different server than `GUILD_ID`.

## Layout

```
src/index.js         boot: config → db → bot → web
src/config.js        env loading + validation
src/db.js            SQLite schema/migrations + queries (actions, bans, dungeons, evidence)
src/roblox.js        Open Cloud client (restrictions, messaging, datastores, lookups)
src/bot/             discord.js client + slash commands (tiered permissions)
src/web/             Express API + Discord OAuth staff login + evidence serving
public/              the dashboard (vanilla JS, no build step)
roblox/              one game script (kicks + dungeon via hidden private server)
```
