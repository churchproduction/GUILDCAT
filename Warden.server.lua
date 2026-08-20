--[[
	Warden — one script, one place, zero setup.

	Put this Script in ServerScriptService of your game and publish.
	That's it. No second place, no place IDs to fill in.

	How the dungeon works here:
	  The dungeon is a POOL of hidden private servers of your own game
	  (reserved servers). They're always your real, latest game — because
	  they ARE your game. Normal matchmaking can never put players in them,
	  and players can't join them on their own; only this script sends
	  people there.

	  Dungeoned players are spread across the pool by user id, so big games
	  work fine. DUNGEON_SERVERS below is the pool size — 5 servers ≈ room
	  for a few hundred sinners at once. Raise it any time; new servers are
	  created automatically when first needed.

	  • /dungeon  → teleported into a dungeon server (instantly if playing,
	                or the moment they join later)
	  • /release  → sent back to a normal public server
	  • sentence expires → sent back automatically
	  • normal players can never end up in a dungeon server
	  • /kick works everywhere

	Bans need no script at all — Roblox enforces those platform-wide.
	The topic/datastore names must match the bot's .env (defaults shown).

	Attributes set on sentenced players (for your own UI, optional):
	    player:GetAttribute("DungeonReason")     → string
	    player:GetAttribute("DungeonExpiresAt")  → unix seconds (0 = permanent)

	Note: teleports don't work in Studio's Play test — test in the real game.
]]

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local MessagingService = game:GetService("MessagingService")
local TeleportService = game:GetService("TeleportService")
local HttpService = game:GetService("HttpService")

-- ── CONFIG ────────────────────────────────────────────────
local DUNGEON_SERVERS = 5                 -- size of the dungeon server pool
local KICK_TOPIC = "WardenKick"           -- matches ROBLOX_KICK_TOPIC
local DUNGEON_TOPIC = "WardenDungeon"     -- matches ROBLOX_DUNGEON_TOPIC
local DUNGEON_DATASTORE = "WardenDungeon" -- matches DUNGEON_DATASTORE
-- ──────────────────────────────────────────────────────────

local POOL_KEY = "__dungeon_servers" -- where the pool's access codes live

local dungeonStore = DataStoreService:GetDataStore(DUNGEON_DATASTORE)

local READY = false
local IS_DUNGEON = false

-- player → unix seconds their sentence ends (math.huge = permanent). Dungeon only.
local sentenceEnds = {}

local function sentenceIsActive(entry)
	if type(entry) ~= "table" then
		return false
	end
	if entry.permanent == true then
		return true
	end
	return type(entry.expiresAt) == "number" and entry.expiresAt > os.time()
end

local function getSentence(userId)
	local ok, entry = pcall(function()
		return dungeonStore:GetAsync(tostring(userId))
	end)
	if not ok then
		warn("[Warden] Dungeon DataStore read failed for", userId, entry)
		return nil, false
	end
	return entry, true
end

-- ── dungeon server pool ───────────────────────────────────
-- Stored as { ["1"] = {code=..., id=...}, ["2"] = ... }

local function readPool()
	local ok, pool = pcall(function()
		return dungeonStore:GetAsync(POOL_KEY)
	end)
	if ok and type(pool) == "table" then
		return pool
	end
	return {}
end

-- Get slot N of the pool, reserving a new server for it if needed.
local function getPoolSlot(n)
	local key = tostring(n)
	local pool = readPool()
	if type(pool[key]) == "table" and pool[key].code then
		return pool[key]
	end

	local okReserve, code, privateServerId = pcall(function()
		return TeleportService:ReserveServer(game.PlaceId)
	end)
	if not okReserve then
		warn("[Warden] Couldn't reserve dungeon server " .. key .. ":", code)
		return nil
	end
	local record = { code = code, id = privateServerId }

	local okSave, saved = pcall(function()
		return dungeonStore:UpdateAsync(POOL_KEY, function(current)
			if type(current) ~= "table" then
				current = {}
			end
			if type(current[key]) == "table" and current[key].code then
				return current -- another server beat us to this slot; keep theirs
			end
			current[key] = record
			return current
		end)
	end)
	if okSave and type(saved) == "table" and type(saved[key]) == "table" then
		return saved[key]
	end
	return record
end

local function sendToDungeon(player, reason)
	-- Spread players across the pool by user id; step to the next slot if
	-- a server is full or the teleport fails.
	local start = (player.UserId % DUNGEON_SERVERS) + 1
	for step = 0, DUNGEON_SERVERS - 1 do
		local slot = ((start + step - 1) % DUNGEON_SERVERS) + 1
		local server = getPoolSlot(slot)
		if server then
			local opts = Instance.new("TeleportOptions")
			opts.ReservedServerAccessCode = server.code
			local ok, err = pcall(function()
				TeleportService:TeleportAsync(game.PlaceId, { player }, opts)
			end)
			if ok then
				print(("[Warden] Sending %s (%d) to dungeon server %d"):format(player.Name, player.UserId, slot))
				return
			end
			warn("[Warden] Teleport to dungeon server " .. slot .. " failed:", err)
			task.wait(1)
		end
	end
	player:Kick(reason and ("You've been sent to the dungeon: " .. tostring(reason))
		or "You've been sent to the dungeon. Rejoin to be placed there.")
end

local function sendHome(player)
	print(("[Warden] Sending %s (%d) back to a normal server"):format(player.Name, player.UserId))
	for attempt = 1, 2 do
		local ok, err = pcall(function()
			TeleportService:TeleportAsync(game.PlaceId, { player })
		end)
		if ok then
			return
		end
		warn("[Warden] Teleport home failed (attempt " .. attempt .. "):", err)
		task.wait(2)
	end
	player:Kick("Your dungeon time is over — rejoin the game normally.")
end

local function markSentenced(player, permanent, expiresAt, reason)
	sentenceEnds[player] = permanent and math.huge or (expiresAt or math.huge)
	player:SetAttribute("DungeonReason", tostring(reason or ""))
	player:SetAttribute("DungeonExpiresAt", permanent and 0 or (expiresAt or 0))
end

-- ── figure out which kind of server this is ───────────────
task.spawn(function()
	if game.PrivateServerId ~= "" and game.PrivateServerOwnerId == 0 then
		-- We're in SOME reserved server; is it one of the dungeon pool?
		local pool = readPool()
		for _, record in pairs(pool) do
			if type(record) == "table" and record.id == game.PrivateServerId then
				IS_DUNGEON = true
				break
			end
		end
	end
	READY = true
	print("[Warden] Running in " .. (IS_DUNGEON and "DUNGEON" or "NORMAL") .. " mode")
end)

-- ── joins ─────────────────────────────────────────────────
Players.PlayerAdded:Connect(function(player)
	while not READY do
		task.wait(0.1)
	end
	local entry = getSentence(player.UserId)
	local active = sentenceIsActive(entry)

	if IS_DUNGEON then
		if active then
			markSentenced(player, entry.permanent == true, entry.expiresAt, entry.reason)
		else
			-- No sentence (or unreadable) → not their server. Don't trap innocents.
			sendHome(player)
		end
	else
		if active then
			sendToDungeon(player, entry.reason)
		end
	end
end)

Players.PlayerRemoving:Connect(function(player)
	sentenceEnds[player] = nil
end)

-- ── dungeon: free players whose time is up ────────────────
task.spawn(function()
	while true do
		task.wait(30)
		if IS_DUNGEON then
			local now = os.time()
			for player, endsAt in pairs(sentenceEnds) do
				if endsAt ~= math.huge and now >= endsAt then
					sentenceEnds[player] = nil
					sendHome(player)
				end
			end
		end
	end
end)

-- ── bot messages: dungeon moves ───────────────────────────
local okDgn, errDgn = pcall(function()
	MessagingService:SubscribeAsync(DUNGEON_TOPIC, function(message)
		local ok, data = pcall(function()
			return HttpService:JSONDecode(message.Data)
		end)
		if not ok or type(data) ~= "table" or type(data.userId) ~= "number" then
			return
		end
		local player = Players:GetPlayerByUserId(data.userId)
		if not player then
			return
		end
		while not READY do
			task.wait(0.1)
		end
		if IS_DUNGEON then
			if data.action == "release" then
				sentenceEnds[player] = nil
				sendHome(player)
			elseif data.action == "send" then
				-- Sentence changed while they're already here — update the clock.
				markSentenced(player, data.permanent == true, data.expiresAt, data.reason)
			end
		else
			if data.action == "send" then
				sendToDungeon(player, data.reason)
			end
		end
	end)
end)
if not okDgn then
	warn("[Warden] Failed to subscribe to dungeon topic:", errDgn)
end

-- ── bot messages: kicks (work everywhere) ─────────────────
local okKick, errKick = pcall(function()
	MessagingService:SubscribeAsync(KICK_TOPIC, function(message)
		local ok, data = pcall(function()
			return HttpService:JSONDecode(message.Data)
		end)
		if not ok or type(data) ~= "table" or type(data.userId) ~= "number" then
			return
		end
		local player = Players:GetPlayerByUserId(data.userId)
		if player then
			local reason = data.reason
			if type(reason) ~= "string" or #reason == 0 then
				reason = "Kicked by a moderator."
			end
			print(("[Warden] Kicking %s (%d): %s"):format(player.Name, data.userId, reason))
			player:Kick(reason)
		end
	end)
end)
if not okKick then
	warn("[Warden] Failed to subscribe to kick topic:", errKick)
end
