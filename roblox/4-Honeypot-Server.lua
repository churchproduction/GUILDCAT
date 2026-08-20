--[[
	WARDEN HONEYPOT — SERVER SCRIPT

	Where it goes: ServerScriptService, as a normal Script (NOT a LocalScript).

	What it does: watches your fake (bait) RemoteEvents. No honest player can
	ever fire them — the game never uses them — so anyone who does is running
	an exploit. Every catch is sent to Warden, stacks up in your Discord
	honeypot channel, and one button dungeons the whole stack.

	SETUP:
	1. Fill in WARDEN_URL and SECRET below (same values as your reports script).
	2. Put the names of your fake remotes in REMOTE_NAMES. The script finds
	   them anywhere under ReplicatedStorage. If one doesn't exist yet and
	   CREATE_MISSING is true, it creates it in ReplicatedStorage for you —
	   juicy names attract exploiters.
	3. Publish. Nothing else — your real code never touches these remotes.
]]

-- ▼▼ FILL THESE IN ▼▼
local WARDEN_URL = "https://YOUR-APP.onrender.com" -- your Render URL, no slash at the end
local SECRET = "PASTE-YOUR-GAME_REPORT_SECRET-HERE" -- same as on Render

local REMOTE_NAMES = { -- your fake remotes (names as they appear in ReplicatedStorage)
	"GiveCoins",
	"SetWalkSpeed",
	"AdminCommand",
	"AwardKill",
}
local CREATE_MISSING = true -- create any of the above that don't exist yet
-- ▲▲ FILL THESE IN ▲▲

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

-- One report per player per server session — a looping exploit firing 500
-- times doesn't need 500 posts. (Warden stacks by player anyway.)
local caught = {} -- [userId] = true

-- Turn whatever the exploiter fired into a readable string for evidence.
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

local function report(player, remoteName, argsText)
	local body = HttpService:JSONEncode({
		player = { id = player.UserId, name = player.Name },
		remote = remoteName,
		args = argsText,
		placeId = tostring(game.PlaceId),
		jobId = game.JobId,
	})
	local function post()
		local ok, result = pcall(function()
			return HttpService:RequestAsync({
				Url = WARDEN_URL .. "/api/game/honeypot",
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["x-warden-key"] = SECRET,
				},
				Body = body,
			})
		end)
		if not ok then
			warn("[WardenHoneypot] request failed:", result)
			return false
		end
		if not result.Success then
			warn("[WardenHoneypot] Warden said:", result.StatusCode, result.Body)
			return false
		end
		return true
	end
	if not post() then
		task.wait(3)
		post()
	end
end

local function springTrap(remoteName, player, argsText)
	if not player or not player:IsA("Player") then
		return
	end
	warn(('[WardenHoneypot] %s (%d) fired fake remote "%s" — %s'):format(
		player.Name, player.UserId, remoteName, argsText
	))
	if caught[player.UserId] then
		return -- already reported this session; just keep quiet
	end
	caught[player.UserId] = true
	task.spawn(report, player, remoteName, argsText)
end

local function arm(remote)
	if remote:IsA("RemoteEvent") then
		remote.OnServerEvent:Connect(function(player, ...)
			springTrap(remote.Name, player, describeArgs(...))
		end)
	elseif remote:IsA("RemoteFunction") then
		remote.OnServerInvoke = function(player, ...)
			springTrap(remote.Name, player, describeArgs(...))
			return nil -- give the exploiter nothing
		end
	end
end

local wanted = {}
for _, name in REMOTE_NAMES do
	wanted[name] = true
end

-- Arm the fakes that exist anywhere under ReplicatedStorage…
local armed = {}
for _, inst in ReplicatedStorage:GetDescendants() do
	if wanted[inst.Name] and (inst:IsA("RemoteEvent") or inst:IsA("RemoteFunction")) then
		arm(inst)
		armed[inst.Name] = true
	end
end
-- …and create any that are missing.
if CREATE_MISSING then
	for name in wanted do
		if not armed[name] then
			local fake = Instance.new("RemoteEvent")
			fake.Name = name
			fake.Parent = ReplicatedStorage
			arm(fake)
			armed[name] = true
		end
	end
end

local count = 0
for _ in armed do
	count += 1
end
print(("[WardenHoneypot] %d trap%s armed"):format(count, count == 1 and "" or "s"))

Players.PlayerRemoving:Connect(function(player)
	caught[player.UserId] = nil
end)
