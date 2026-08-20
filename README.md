# Warden

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

`user` accepts a username, a numeric user ID, or a profile URL everywhere.
Server administrators always count as senior staff. Every command takes an
optional image/video attachment and/or a video link as evidence — files are
downloaded and stored by Warden (Discord's own links expire), then shown on
the dashboard.

