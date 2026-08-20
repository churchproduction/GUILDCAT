--!strict
--[[
	WardenReportRelay — sends in-game exploit reports to Warden.

	What it does: when a player submits a report, this posts it to your
	Warden server. Warden then puts it in the Discord report channel (with a
	"Join their server" button) and on the dashboard's Reports page.

	SETUP (3 steps):

	1. In Roblox Studio: Game Settings → Security → turn ON
	   "Allow HTTP Requests".

	2. Fill in the two values below:
	   - WARDEN_URL — your Render URL, no slash at the end
	   - SECRET     — the same value you put in GAME_REPORT_SECRET on Render

	3. Put this ModuleScript in ServerScriptService (or ReplicatedStorage —
	   anywhere your server code can require it), then connect it to your
	   ReportService. In the script where ReportService starts, add:

	       local WardenReportRelay = require(game.ServerScriptService.WardenReportRelay)
	       ReportService.submitted:Connect(WardenReportRelay.send)

	   (ReportService.submitted already fires (reporter, target, description)
	   on every accepted report — that's exactly what .send takes.)
]]

local HttpService = game:GetService("HttpService")

-- ▼▼ FILL THESE IN ▼▼
local WARDEN_URL = "https://YOUR-APP.onrender.com"
local SECRET = "PASTE-YOUR-GAME_REPORT_SECRET-HERE"
-- ▲▲ FILL THESE IN ▲▲

local WardenReportRelay = {}

local function post(body: string): boolean
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
		warn("[WardenReportRelay] request failed:", result)
		return false
	end
	if not result.Success then
		warn("[WardenReportRelay] Warden said:", result.StatusCode, result.Body)
		return false
	end
	return true
end

-- Matches ReportService.submitted: (reporter, target, description)
function WardenReportRelay.send(reporter: Player, target: Player, description: string)
	-- Run in its own thread so a slow request never blocks the report flow.
	task.spawn(function()
		local body = HttpService:JSONEncode({
			reporter = { id = reporter.UserId, name = reporter.Name },
			target = { id = target.UserId, name = target.Name },
			reason = description,
			placeId = tostring(game.PlaceId),
			jobId = game.JobId, -- lets mods join this exact server from Discord
		})
		-- One retry — enough for a hiccup, no endless loop.
		if not post(body) then
			task.wait(3)
			post(body)
		end
	end)
end

return WardenReportRelay
