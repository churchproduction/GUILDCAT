--[[
	WARDEN REPORTS — SERVER SCRIPT

	Where it goes: ServerScriptService, as a normal Script (NOT a LocalScript).

	What it does: receives reports from the report button, checks them
	(cooldown, no self-reports, no spam), and sends them to Warden —
	which posts them in your Discord report channel (with the Join Server
	button) and on the dashboard's Reports page.

	FILL IN THE TWO VALUES BELOW, that's the only setup.
]]

-- ▼▼ FILL THESE IN ▼▼
local WARDEN_URL = "https://YOUR-APP.onrender.com" -- your Render URL, no slash at the end
local SECRET = "PASTE-YOUR-GAME_REPORT_SECRET-HERE" -- same value as on Render
-- ▲▲ FILL THESE IN ▲▲

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local COOLDOWN = 20 -- seconds a player must wait between reports
local MAX_REASON = 200
local MIN_REASON = 4

-- The client button talks to us through this.
local remote = Instance.new("RemoteEvent")
remote.Name = "WardenReport"
remote.Parent = ReplicatedStorage

local lastReport = {} -- [player] = clock time of their last report
local reported = {} -- [player] = { [targetUserId] = true } (once per target per session)

local function tell(player, message)
	remote:FireClient(player, "toast", message)
end

local function sendToWarden(reporter, target, description)
	local body = HttpService:JSONEncode({
		reporter = { id = reporter.UserId, name = reporter.Name },
		target = { id = target.UserId, name = target.Name },
		reason = description,
		placeId = tostring(game.PlaceId),
		jobId = game.JobId, -- lets mods join this exact server from Discord
	})
	local function post()
		local ok, result = pcall(function()
			return HttpService:RequestAsync({
				Url = WARDEN_URL .. "/api/game/report",
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["x-warden-key"] = SECRET,
				},
				Body = body,
			})
		end)
		if not ok then
			warn("[WardenReports] request failed:", result)
			return false
		end
		if not result.Success then
			warn("[WardenReports] Warden said:", result.StatusCode, result.Body)
			return false
		end
		return true
	end
	-- one retry if the first try hiccups
	if not post() then
		task.wait(3)
		post()
	end
end

remote.OnServerEvent:Connect(function(reporter, targetUserId, reason)
	-- basic checks (the client already checks these — never trust the client)
	if type(targetUserId) ~= "number" then
		return
	end
	local target = Players:GetPlayerByUserId(targetUserId)
	if not target then
		return
	end
	-- Reporting yourself is only allowed in Studio, so you can test the whole
	-- pipeline alone. In the real game it's blocked.
	local studioTest = target == reporter
	if studioTest and not RunService:IsStudio() then
		return
	end
	local description = if type(reason) == "string" then reason:sub(1, MAX_REASON) else ""
	if studioTest then
		description = "[Studio test] " .. description
	end
	if #description < MIN_REASON then
		tell(reporter, "Add a short description before reporting.")
		return
	end

	-- Studio tests skip the cooldown + duplicate rules so you can test freely.
	if not studioTest then
		local now = os.clock()
		if lastReport[reporter] and now - lastReport[reporter] < COOLDOWN then
			tell(reporter, "You're reporting too quickly — wait a moment.")
			return
		end

		local seen = reported[reporter]
		if not seen then
			seen = {}
			reported[reporter] = seen
		end
		if seen[target.UserId] then
			-- already reported this player this session — thank them the same
			-- way, but don't send a duplicate
			tell(reporter, ("Reported %s. Thanks."):format(target.DisplayName))
			return
		end
		seen[target.UserId] = true
		lastReport[reporter] = now
	end

	warn(('[Report] %s (%d) reported %s (%d): "%s"'):format(
		reporter.Name, reporter.UserId, target.Name, target.UserId, description
	))

	task.spawn(sendToWarden, reporter, target, description)
	tell(reporter, ("Reported %s. Thanks."):format(target.DisplayName))
end)

Players.PlayerRemoving:Connect(function(player)
	lastReport[player] = nil
	reported[player] = nil
end)
