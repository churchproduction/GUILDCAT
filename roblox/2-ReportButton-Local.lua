--[[
	WARDEN REPORTS — REPORT BUTTON (CLIENT)

	Where it goes: StarterPlayer → StarterPlayerScripts, as a LocalScript
	(NOT a normal Script).

	What it does: puts a small "Report" button on the right edge of the
	screen (out of the way of the leaderboard). Tap it → pick a player →
	describe what they were doing → send. Nothing to fill in here.

	In Studio you can test alone: the picker shows a "Studio test" row that
	reports yourself, so the whole pipeline runs (Discord + dashboard).
	That row never appears in the real game.
]]

local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local remote = ReplicatedStorage:WaitForChild("WardenReport")
local LocalPlayer = Players.LocalPlayer

-- same style values as the report dialog design
local PANEL = Color3.fromRGB(18, 18, 21)
local TEXT = Color3.fromRGB(247, 247, 248)
local SUBTEXT = Color3.fromRGB(188, 190, 200)
local DIVIDER = Color3.fromRGB(208, 217, 251)
local DANGER = Color3.fromRGB(214, 74, 74)
local FIELD = Color3.fromRGB(30, 30, 34)
local BUTTON_GREY = Color3.fromRGB(45, 45, 50)
local BUILDER_SANS = Font.new("rbxasset://fonts/families/BuilderSans.json")
local BUILDER_SANS_BOLD = Font.new("rbxasset://fonts/families/BuilderSans.json", Enum.FontWeight.Bold)
local CORNER = 7
local TWEEN = TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local MAX_CHARS = 200
local MIN_CHARS = 4

local screen = Instance.new("ScreenGui")
screen.Name = "WardenReportUI"
screen.ResetOnSpawn = false
screen.IgnoreGuiInset = true
screen.DisplayOrder = 20
screen.Parent = LocalPlayer:WaitForChild("PlayerGui")

local function corner(parent, radius)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius or CORNER)
	c.Parent = parent
	return c
end

local function label(parent, text, size, pos, textSize, colour, bold)
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Size = size
	l.Position = pos
	l.FontFace = if bold then BUILDER_SANS_BOLD else BUILDER_SANS
	l.TextSize = textSize
	l.TextColor3 = colour
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextTruncate = Enum.TextTruncate.AtEnd
	l.Text = text
	l.Parent = parent
	return l
end

-- modal shell: dark shade + centered panel, both animated in
local function modal(width, height)
	local holder = Instance.new("Frame")
	holder.Size = UDim2.fromScale(1, 1)
	holder.BackgroundTransparency = 1
	holder.Parent = screen

	local shade = Instance.new("TextButton")
	shade.Size = UDim2.fromScale(1, 1)
	shade.BackgroundColor3 = Color3.new(0, 0, 0)
	shade.BackgroundTransparency = 1
	shade.AutoButtonColor = false
	shade.Text = ""
	shade.Active = true
	shade.Parent = holder
	TweenService:Create(shade, TWEEN, { BackgroundTransparency = 0.5 }):Play()

	local panel = Instance.new("Frame")
	panel.Size = UDim2.fromOffset(width, height)
	panel.Position = UDim2.fromScale(0.5, 0.5)
	panel.AnchorPoint = Vector2.new(0.5, 0.5)
	panel.BackgroundColor3 = PANEL
	panel.BackgroundTransparency = 0.05
	panel.BorderSizePixel = 0
	panel.Parent = holder
	corner(panel)
	local scale = Instance.new("UIScale")
	scale.Scale = 0.9
	scale.Parent = panel
	TweenService:Create(scale, TWEEN, { Scale = 1 }):Play()

	return holder, panel, shade
end

local function panelButton(parent, text, x, y, colour, bold)
	local b = Instance.new("TextButton")
	b.Size = UDim2.fromOffset(160, 40)
	b.Position = UDim2.fromOffset(x, y)
	b.BackgroundColor3 = colour
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.FontFace = if bold then BUILDER_SANS_BOLD else BUILDER_SANS
	b.TextSize = 16
	b.TextColor3 = TEXT
	b.Text = text
	b.Parent = parent
	corner(b)
	return b
end

local function hover(b, base)
	b.MouseEnter:Connect(function()
		if b.Active then
			b.BackgroundColor3 = base:Lerp(Color3.new(1, 1, 1), 0.12)
		end
	end)
	b.MouseLeave:Connect(function()
		if b.Active then
			b.BackgroundColor3 = base
		end
	end)
end

-- ── little toast messages (top of the screen) ──────────────
local function toast(message)
	local t = Instance.new("TextLabel")
	t.AnchorPoint = Vector2.new(0.5, 0)
	t.Position = UDim2.new(0.5, 0, 0, 50)
	t.AutomaticSize = Enum.AutomaticSize.XY
	t.Size = UDim2.fromOffset(0, 0)
	t.BackgroundColor3 = PANEL
	t.BackgroundTransparency = 0.08
	t.BorderSizePixel = 0
	t.FontFace = BUILDER_SANS
	t.TextSize = 15
	t.TextColor3 = TEXT
	t.Text = message
	t.TextTransparency = 1
	t.Parent = screen
	corner(t)
	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, 9)
	pad.PaddingBottom = UDim.new(0, 9)
	pad.PaddingLeft = UDim.new(0, 14)
	pad.PaddingRight = UDim.new(0, 14)
	pad.Parent = t
	TweenService:Create(t, TWEEN, { TextTransparency = 0 }):Play()
	task.delay(3, function()
		TweenService:Create(t, TWEEN, { TextTransparency = 1, BackgroundTransparency = 1 }):Play()
		task.delay(0.25, function() t:Destroy() end)
	end)
end

remote.OnClientEvent:Connect(function(kind, message)
	if kind == "toast" then
		toast(message)
	end
end)

-- ── the report dialog (the design you were given) ──────────
local dialog = nil
local function closeDialog()
	if dialog then
		dialog:Destroy()
		dialog = nil
	end
end

local function openDialog(target)
	closeDialog()
	local WIDTH, HEIGHT = 380, 300
	local holder, panel, shade = modal(WIDTH, HEIGHT)
	dialog = holder

	local avatar = Instance.new("ImageLabel")
	avatar.Size = UDim2.fromOffset(48, 48)
	avatar.Position = UDim2.fromOffset(20, 20)
	avatar.BackgroundTransparency = 1
	avatar.Image = ("rbxthumb://type=AvatarHeadShot&id=%d&w=150&h=150"):format(target.UserId)
	avatar.Parent = panel

	label(panel, "Report Exploiting", UDim2.new(1, -88, 0, 22), UDim2.fromOffset(80, 22), 20, TEXT, true)
	label(panel, ("%s  @%s"):format(target.DisplayName, target.Name), UDim2.new(1, -88, 0, 18), UDim2.fromOffset(80, 46), 15, SUBTEXT)

	local divider = Instance.new("Frame")
	divider.Size = UDim2.new(1, -40, 0, 1)
	divider.Position = UDim2.fromOffset(20, 84)
	divider.BackgroundColor3 = DIVIDER
	divider.BackgroundTransparency = 0.84
	divider.BorderSizePixel = 0
	divider.Parent = panel

	label(panel, "What were they doing?", UDim2.new(1, -40, 0, 18), UDim2.fromOffset(20, 96), 15, SUBTEXT)

	local boxFrame = Instance.new("Frame")
	boxFrame.Size = UDim2.new(1, -40, 0, 100)
	boxFrame.Position = UDim2.fromOffset(20, 120)
	boxFrame.BackgroundColor3 = FIELD
	boxFrame.BorderSizePixel = 0
	boxFrame.Parent = panel
	corner(boxFrame)

	local box = Instance.new("TextBox")
	box.Size = UDim2.new(1, -20, 1, -12)
	box.Position = UDim2.fromOffset(10, 6)
	box.BackgroundTransparency = 1
	box.ClearTextOnFocus = false
	box.MultiLine = true
	box.TextWrapped = true
	box.FontFace = BUILDER_SANS
	box.TextSize = 15
	box.TextColor3 = TEXT
	box.PlaceholderColor3 = Color3.fromRGB(120, 122, 130)
	box.PlaceholderText = "e.g. flying, killing through walls, moving too fast..."
	box.Text = ""
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.TextYAlignment = Enum.TextYAlignment.Top
	box.Parent = boxFrame

	local counter = label(panel, ("0/%d"):format(MAX_CHARS), UDim2.new(0, 80, 0, 16), UDim2.fromOffset(WIDTH - 100, 224), 13, SUBTEXT)
	counter.TextXAlignment = Enum.TextXAlignment.Right

	local cancel = panelButton(panel, "Cancel", 20, HEIGHT - 56, BUTTON_GREY)
	local submit = panelButton(panel, "Send Report", WIDTH - 180, HEIGHT - 56, DANGER, true)

	local function refresh()
		local length = #box.Text
		counter.Text = ("%d/%d"):format(length, MAX_CHARS)
		local ready = length >= MIN_CHARS
		submit.BackgroundColor3 = if ready then DANGER else Color3.fromRGB(70, 40, 40)
		submit.TextTransparency = if ready then 0 else 0.4
		submit.Active = ready
	end
	box:GetPropertyChangedSignal("Text"):Connect(function()
		if #box.Text > MAX_CHARS then
			box.Text = box.Text:sub(1, MAX_CHARS)
			return
		end
		refresh()
	end)
	refresh()
	hover(cancel, BUTTON_GREY)
	hover(submit, DANGER)

	cancel.Activated:Connect(closeDialog)
	shade.Activated:Connect(closeDialog)
	submit.Activated:Connect(function()
		if not submit.Active then
			return
		end
		local reason = box.Text
		closeDialog()
		remote:FireServer(target.UserId, reason)
	end)
end

-- ── player picker, same design language ────────────────────
local picker = nil
local function closePicker()
	if picker then
		picker:Destroy()
		picker = nil
	end
end

local function openPicker()
	closePicker()
	closeDialog()

	local entries = {}
	for _, player in Players:GetPlayers() do
		if player ~= LocalPlayer then
			table.insert(entries, { player = player, sub = "@" .. player.Name })
		end
	end
	-- Alone in Studio? Offer a test row so the whole pipeline can be tried.
	if RunService:IsStudio() and #entries == 0 then
		table.insert(entries, { player = LocalPlayer, sub = "Studio test — reports you" })
	end

	local WIDTH = 380
	local visible = math.max(1, math.min(#entries, 5))
	local listHeight = visible * 54 - 6
	local HEIGHT = 96 + listHeight + 72

	local holder, panel, shade = modal(WIDTH, HEIGHT)
	picker = holder
	shade.Activated:Connect(closePicker)

	label(panel, "Report a player", UDim2.new(1, -40, 0, 22), UDim2.fromOffset(20, 22), 20, TEXT, true)
	label(panel, "Who are you reporting?", UDim2.new(1, -40, 0, 18), UDim2.fromOffset(20, 46), 15, SUBTEXT)

	local divider = Instance.new("Frame")
	divider.Size = UDim2.new(1, -40, 0, 1)
	divider.Position = UDim2.fromOffset(20, 84)
	divider.BackgroundColor3 = DIVIDER
	divider.BackgroundTransparency = 0.84
	divider.BorderSizePixel = 0
	divider.Parent = panel

	local list = Instance.new("ScrollingFrame")
	list.Size = UDim2.new(1, -40, 0, listHeight)
	list.Position = UDim2.fromOffset(20, 96)
	list.BackgroundTransparency = 1
	list.BorderSizePixel = 0
	list.ScrollBarThickness = 4
	list.ScrollBarImageColor3 = SUBTEXT
	list.CanvasSize = UDim2.fromOffset(0, #entries * 54 - 6)
	list.Parent = panel

	if #entries == 0 then
		local empty = label(list, "Nobody else is in this server.", UDim2.new(1, 0, 0, 40), UDim2.fromOffset(0, 4), 15, SUBTEXT)
		empty.TextXAlignment = Enum.TextXAlignment.Center
	end

	for i, entry in entries do
		local player = entry.player
		local row = Instance.new("TextButton")
		row.Size = UDim2.new(1, 0, 0, 48)
		row.Position = UDim2.fromOffset(0, (i - 1) * 54)
		row.BackgroundColor3 = FIELD
		row.AutoButtonColor = false
		row.BorderSizePixel = 0
		row.Text = ""
		row.Parent = list
		corner(row)
		hover(row, FIELD)

		local face = Instance.new("ImageLabel")
		face.Size = UDim2.fromOffset(34, 34)
		face.Position = UDim2.fromOffset(8, 7)
		face.BackgroundColor3 = PANEL
		face.BorderSizePixel = 0
		face.Image = ("rbxthumb://type=AvatarHeadShot&id=%d&w=100&h=100"):format(player.UserId)
		face.Parent = row
		corner(face, 17)

		label(row, player.DisplayName, UDim2.new(1, -64, 0, 18), UDim2.fromOffset(54, 7), 15, TEXT, true)
		label(row, entry.sub, UDim2.new(1, -64, 0, 14), UDim2.fromOffset(54, 26), 13, SUBTEXT)

		row.Activated:Connect(function()
			closePicker()
			if player.Parent then -- still in the server
				openDialog(player)
			end
		end)
	end

	local cancel = panelButton(panel, "Cancel", 20, HEIGHT - 56, BUTTON_GREY)
	hover(cancel, BUTTON_GREY)
	cancel.Activated:Connect(closePicker)
end

-- ── the on-screen Report button (right edge, middle) ───────
local btn = Instance.new("TextButton")
btn.AnchorPoint = Vector2.new(1, 0.5)
btn.Position = UDim2.new(1, -10, 0.5, 0)
btn.Size = UDim2.fromOffset(92, 36)
btn.BackgroundColor3 = PANEL
btn.BackgroundTransparency = 0.15
btn.BorderSizePixel = 0
btn.AutoButtonColor = false
btn.FontFace = BUILDER_SANS_BOLD
btn.TextSize = 15
btn.TextColor3 = TEXT
btn.Text = "Report"
btn.Parent = screen
corner(btn, 8)
local stroke = Instance.new("UIStroke")
stroke.Color = DANGER
stroke.Transparency = 0.55
stroke.Thickness = 1
stroke.Parent = btn

btn.MouseEnter:Connect(function()
	TweenService:Create(btn, TWEEN, { BackgroundTransparency = 0 }):Play()
	TweenService:Create(stroke, TWEEN, { Transparency = 0.2 }):Play()
end)
btn.MouseLeave:Connect(function()
	TweenService:Create(btn, TWEEN, { BackgroundTransparency = 0.15 }):Play()
	TweenService:Create(stroke, TWEEN, { Transparency = 0.55 }):Play()
end)
btn.Activated:Connect(openPicker)
