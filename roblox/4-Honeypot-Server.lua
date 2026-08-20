--[[
	WARDEN HONEYPOT / TRAPS — SERVER SCRIPT

	Where it goes: ServerScriptService, as a normal Script (NOT a LocalScript).
	ONLY needed if nobody else wrote the game side of the traps. If the game
	already has code that posts to /api/game/trap, skip this script entirely.

	What it does: watches fake (bait) RemoteEvents. The game never uses them,
	so no honest player can fire them — anyone who does is exploiting.
	Every catch goes to Warden → stacks in your Discord honeypot channel →
	one button dungeons the whole stack.

	It keeps each player's RUNNING TOTAL of trap fires in a DataStore, so the
	count survives rejoins and server hops (that's what the dedupe uses).

	SETUP:
	1. Fill in WARDEN_URL and SECRET below (same values as the reports script).
	2. List your fake remotes in TRAPS. Two ways to write one:
	     "GiveCash"        → a remote named GiveCash anywhere in ReplicatedStorage
	     "Kits/Unlock"     → ReplicatedStorage.Kits.Unlock exactly (folder path)
	   Use the path style if the name could clash with a REAL remote.
	3. If CREATE_MISSING is true, any trap that doesn't exist yet gets created
	   (folders too). Publish. Your real code must never touch these remotes.
]]

-- ▼▼ FILL THESE IN ▼▼
local WARDEN_URL = "https://YOUR-APP.onrender.com" -- your Render URL, no slash at the end
local SECRET = "PASTE-YOUR-GAME_REPORT_SECRET-HERE" -- same as on Render

local TRAPS = {
	"GiveCash",
	"Kits/Unlock",
	"Market/GrantProduct",
	"Admin/Run",
	"SetWalkSpeed",
	"SetElo",
}
local CREATE_MISSING = true
-- ▲▲ FILL THESE IN ▲▲

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local totalsStore = DataStoreService:GetDataStore("WardenTraps")

-- A looping exploit can fire hundreds of times a second. Every fire counts
-- toward their total, but we send Warden at most one update per player per
-- REPORT_EVERY seconds (always carrying the newest total).
local REPORT_EVERY = 8
local lastSent = {} -- [userId] = os.clock() of last send
local pendingSend = {} -- [userId] = true while a delayed send is queued

-- Bump the player's all-time trap total in the DataStore. Falls back to a
-- session counter if the DataStore hiccups.
local sessionTotals = {} -- [userId] = count this session (fallback)
local function bumpTotal(userId)
	sessionTotals[userId] = (sessionTotals[userId] or 0) + 1
	local ok, total = pcall(function()
		return totalsStore:UpdateAsync(tostring(userId), function(current)
			return (type(current) == "number" and current or 0) + 1
		end)
	end)
	if ok and type(total) == "number" then
		return total
	end
	return sessionTotals[userId]
end

local function describeArgs(...)
	local parts = {}
	local n = select("#", ...)
	for i = 1, math.min(n, 8) do
		local v = select(i, ...)
		local ok, text = pcall(function()
			if typeof(v) == "Instance" then
				return "Instance<" .. v.ClassName .. "> " .. v:GetFullName()
			end
			return typeof(v) .. " " .. tostring(v)
		end)
		parts[i] = ok and text:sub(1, 120) or "?"
	end
	if n > 8 then
		parts[#parts + 1] = ("(+%d more)"):format(n - 8)
	end
	return if n == 0 then "(nothing)" else table.concat(parts, " · ")
end

local function postToWarden(player, remoteName, total, argsText)
	local body = HttpService:JSONEncode({
		user = { id = player.UserId, name = player.Name },
		remote = remoteName,
		total = total,
		args = argsText,
		placeId = tostring(game.PlaceId),
		jobId = game.JobId,
	})
	local function post()
		local ok, result = pcall(function()
			return HttpService:RequestAsync({
				Url = WARDEN_URL .. "/api/game/trap",
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["x-warden-key"] = SECRET,
				},
				Body = body,
			})
		end)
		if not ok then
			warn("[WardenTraps] request failed:", result)
			return false
		end
		if not result.Success then
			warn("[WardenTraps] Warden said:", result.StatusCode, result.Body)
			return false
		end
		return true
	end
	if not post() then
		task.wait(3)
		post()
	end
end

local function springTrap(trapName, player, argsText)
	if not player or not player:IsA("Player") then
		return
	end
	local userId = player.UserId
	local total = bumpTotal(userId)
	warn(('[WardenTraps] %s (%d) fired trap "%s" (total %d) — %s'):format(
		player.Name, userId, trapName, total, argsText
	))

	local now = os.clock()
	if lastSent[userId] and now - lastSent[userId] < REPORT_EVERY then
		-- Too soon — queue ONE delayed send that carries the newest total.
		if not pendingSend[userId] then
			pendingSend[userId] = true
			task.delay(REPORT_EVERY, function()
				pendingSend[userId] = nil
				lastSent[userId] = os.clock()
				local latest = sessionTotals[userId] and select(2, pcall(function()
					return totalsStore:GetAsync(tostring(userId))
				end)) or total
				postToWarden(player, trapName, type(latest) == "number" and latest or total, argsText)
			end)
		end
		return
	end
	lastSent[userId] = now
	task.spawn(postToWarden, player, trapName, total, argsText)
end

local function arm(remote, trapName)
	if remote:IsA("RemoteEvent") then
		remote.OnServerEvent:Connect(function(player, ...)
			springTrap(trapName, player, describeArgs(...))
		end)
	elseif remote:IsA("RemoteFunction") then
		remote.OnServerInvoke = function(player, ...)
			springTrap(trapName, player, describeArgs(...))
			return nil -- give the exploiter nothing
		end
	end
end

-- Find (or create) each trap. "A/B" means ReplicatedStorage.A.B exactly;
-- a bare name means any remote with that name under ReplicatedStorage.
local armedCount = 0
for _, trapName in TRAPS do
	local found = nil
	if trapName:find("/") then
		local node = ReplicatedStorage
		for part in trapName:gmatch("[^/]+") do
			node = node and node:FindFirstChild(part)
		end
		found = node
	else
		for _, inst in ReplicatedStorage:GetDescendants() do
			if inst.Name == trapName and (inst:IsA("RemoteEvent") or inst:IsA("RemoteFunction")) then
				found = inst
				break
			end
		end
	end

	if not found and CREATE_MISSING then
		local node = ReplicatedStorage
		local parts = {}
		for part in trapName:gmatch("[^/]+") do
			parts[#parts + 1] = part
		end
		for i = 1, #parts - 1 do
			local next = node:FindFirstChild(parts[i])
			if not next then
				next = Instance.new("Folder")
				next.Name = parts[i]
				next.Parent = node
			end
			node = next
		end
		found = Instance.new("RemoteEvent")
		found.Name = parts[#parts]
		found.Parent = node
	end

	if found and (found:IsA("RemoteEvent") or found:IsA("RemoteFunction")) then
		arm(found, trapName)
		armedCount += 1
	else
		warn(('[WardenTraps] Couldn\'t find or create trap "%s"'):format(trapName))
	end
end
print(("[WardenTraps] %d trap%s armed"):format(armedCount, armedCount == 1 and "" or "s"))

Players.PlayerRemoving:Connect(function(player)
	local id = player.UserId
	lastSent[id] = nil
	pendingSend[id] = nil
	sessionTotals[id] = nil
end)
