/* Warden dashboard — vanilla JS, hash router, no build step. */
"use strict";

const view = document.getElementById("view");
const topbar = document.getElementById("topbar");

/* ── helpers ─────────────────────────────────────────────── */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (res.status === 401) {
    renderLogin();
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }) : "—";

const fmtDay = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  }) : "—";

function rel(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const abs = Math.abs(s);
  const units = [[31536000, "y"], [2592000, "mo"], [604800, "w"], [86400, "d"], [3600, "h"], [60, "m"]];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return s >= 0 ? `${n}${name} ago` : `in ${n}${name}`;
    }
  }
  return s >= 0 ? "just now" : "soon";
}

function fmtDur(seconds) {
  if (seconds === null || seconds === undefined) return "Permanent";
  const units = [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  const parts = [];
  let left = Math.floor(seconds);
  for (const [name, size] of units) {
    if (left >= size) {
      parts.push(`${Math.floor(left / size)}${name}`);
      left %= size;
      if (parts.length === 2) break;
    }
  }
  return parts.join(" ") || "0s";
}

const ACTION_LABEL = {
  ban: "Ban", unban: "Unban", kick: "Kick", warn: "Warn",
  note: "Note", dungeon: "Dungeon", release: "Release",
};

const badge = (type, label) =>
  `<span class="badge badge-${esc(type)}"><span class="dot" aria-hidden="true"></span>${esc(label ?? ACTION_LABEL[type] ?? type)}</span>`;

function playerCell(row) {
  const name = row.display_name || row.current_username || row.username;
  const handle = row.current_username || row.username;
  const avatar = row.avatar_url
    ? `<img src="${esc(row.avatar_url)}" alt="" loading="lazy">`
    : `<span class="avatar-fallback" aria-hidden="true">${esc((handle || "?")[0].toUpperCase())}</span>`;
  return `<a class="playercell" href="#/user/${row.user_id}">
    ${avatar}
    <span class="names">
      <span class="n1">${esc(name)}</span><br>
      <span class="n2">@${esc(handle)} · ${row.user_id}</span>
    </span>
  </a>`;
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/* ── evidence rendering ──────────────────────────────────── */

function evidenceCount(list) {
  if (!list?.length) return "";
  return `<div class="ev-count">${list.length} evidence attached</div>`;
}

function evidenceHtml(list) {
  if (!list?.length) return "";
  const items = list.map((e) => {
    if (e.kind === "link" && e.url) {
      let host = e.url;
      try { host = new URL(e.url).hostname.replace(/^www\./, ""); } catch {}
      return `<a class="ev-link" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(host)} ↗</a>`;
    }
    const src = `/evidence/${e.id}`;
    const type = e.content_type || "";
    const name = e.original_name || "evidence";
    if (type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(name)) {
      return `<video class="ev-video" controls preload="metadata" src="${src}"></video>`;
    }
    return `<a class="ev-thumb-link" href="${src}" target="_blank" rel="noopener" title="${esc(name)}">
      <img class="ev-thumb" src="${src}" alt="${esc(name)}" loading="lazy"></a>`;
  });
  return `<div class="ev-wrap">${items.join("")}</div>`;
}

/* ── session / login ─────────────────────────────────────── */

let me = null;

function renderLogin() {
  topbar.hidden = true;
  document.title = "Warden — sign in";
  view.innerHTML = `
    <div class="center-stage">
      <div class="login-card">
        <div class="mark" aria-hidden="true"></div>
        <h1>Warden</h1>
        <p>Moderation records for the game. Staff only.</p>
        <a class="btn-discord" href="/auth/login">
          <svg width="18" height="14" viewBox="0 0 127 96" fill="currentColor" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/></svg>
          Sign in with Discord
        </a>
      </div>
    </div>`;
}

function renderOffline(openedAsFile) {
  topbar.hidden = true;
  document.title = "Warden";
  view.innerHTML = `
    <div class="center-stage">
      <div class="login-card">
        <div class="mark" aria-hidden="true"></div>
        <h1>Warden</h1>
        ${openedAsFile
          ? `<p>This page is the front end of the Warden app — it only works when the
               app's server is behind it, so opening the file straight from the folder
               shows nothing.</p>
             <p>To see the dashboard: run <code>npm run preview</code> in the project
               folder for a sample-data demo, or <code>npm start</code> once your
               <code>.env</code> is filled in — then open the address it prints.</p>`
          : `<p>Can't reach the Warden server right now.</p>
             <p>If it's supposed to be running, refresh in a moment — otherwise start
               it with <code>npm start</code>.</p>`}
      </div>
    </div>`;
}

function renderUserchip() {
  const el = document.getElementById("userchip");
  el.innerHTML = `
    ${me.avatar ? `<img src="${esc(me.avatar)}" alt="">` : ""}
    <span>${esc(me.displayName || me.username)}</span>
    <button id="logoutBtn" type="button">Sign out</button>`;
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    me = null;
    renderLogin();
  });
}

/* ── activity chart (single series → one hue, no legend) ── */

function activityChart(byDay) {
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const map = Object.fromEntries((byDay || []).map((r) => [r.day, r.count]));
  const values = days.map((d) => map[d] || 0);
  const max = Math.max(...values);
  if (max === 0) return `<div class="chart-empty">No actions in the last 30 days.</div>`;

  const W = 920, H = 180, padL = 30, padR = 6, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const step = plotW / days.length;
  const barW = Math.max(4, step - 4);
  const yMax = Math.max(4, Math.ceil(max * 1.15));
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  const gridVals = [0, Math.round(yMax / 2), yMax];
  const grid = gridVals.map((v) => `
    <line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}"
      stroke="${v === 0 ? "var(--baseline)" : "var(--grid)"}" stroke-width="1"/>
    <text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" font-size="10"
      fill="var(--ink-3)">${v}</text>`).join("");

  const roundedTop = (x, yTop, w, h) => {
    const r = Math.min(4, w / 2, h);
    const yBase = yTop + h;
    return `M${x},${yBase} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + w - r},${yTop} Q${x + w},${yTop} ${x + w},${yTop + r} L${x + w},${yBase} Z`;
  };

  let bars = "", hits = "", ticks = "";
  days.forEach((day, i) => {
    const v = values[i];
    const x = padL + i * step + (step - barW) / 2;
    if (v > 0) {
      bars += `<path d="${roundedTop(x, y(v), barW, y(0) - y(v))}" fill="var(--series-1)"/>`;
    }
    hits += `<rect class="hit" data-i="${i}" x="${padL + i * step}" y="${padT}"
      width="${step}" height="${plotH}" fill="transparent"/>`;
    const dow = new Date(day + "T00:00:00").getDay();
    if (dow === 1) {
      ticks += `<text x="${padL + i * step + step / 2}" y="${H - 6}" text-anchor="middle"
        font-size="10" fill="var(--ink-3)">${new Date(day + "T00:00:00")
          .toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`;
    }
  });

  return `
    <div class="chart-box" data-days='${esc(JSON.stringify(days))}' data-values='${esc(JSON.stringify(values))}'>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Moderation actions per day, last 30 days">
        ${grid}${bars}${ticks}${hits}
      </svg>
      <div class="chart-tip" id="chartTip"></div>
    </div>`;
}

function wireChart(container) {
  const box = container.querySelector(".chart-box");
  if (!box) return;
  const days = JSON.parse(box.dataset.days);
  const values = JSON.parse(box.dataset.values);
  const tip = box.querySelector(".chart-tip");
  const svg = box.querySelector("svg");
  svg.addEventListener("mousemove", (e) => {
    const hit = e.target.closest(".hit");
    if (!hit) { tip.style.opacity = 0; return; }
    const i = Number(hit.dataset.i);
    const rect = box.getBoundingClientRect();
    const hitRect = hit.getBoundingClientRect();
    tip.innerHTML = `<span class="t-label">${fmtDay(days[i])}</span> · <b>${values[i]}</b> action${values[i] === 1 ? "" : "s"}`;
    tip.style.left = `${hitRect.left - rect.left + hitRect.width / 2}px`;
    tip.style.top = `${hitRect.top - rect.top + 6}px`;
    tip.style.opacity = 1;
  });
  svg.addEventListener("mouseleave", () => { tip.style.opacity = 0; });
}

/* ── views ───────────────────────────────────────────────── */

function setActiveNav(name) {
  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.dataset.nav === name));
}

async function renderOverview() {
  setActiveNav("overview");
  document.title = "Warden — overview";
  view.innerHTML = `<div class="wrap"><div class="loading">Loading…</div></div>`;
  const [stats, recent] = await Promise.all([
    api("/api/stats"),
    api("/api/actions?page=1"),
  ]);
  const typeCount = (t) => stats.byType.find((r) => r.type === t)?.count ?? 0;

  view.innerHTML = `
  <div class="wrap">
    <div class="tiles">
      <div class="tile accent">
        <div class="label">Active bans</div>
        <div class="value">${stats.activeBans}</div>
        <div class="sub">${typeCount("ban")} issued all-time</div>
      </div>
      <div class="tile accent-d">
        <div class="label">In the dungeon</div>
        <div class="value">${stats.activeDungeons}</div>
        <div class="sub">${typeCount("dungeon")} sentences all-time</div>
      </div>
      <div class="tile">
        <div class="label">Actions · 30 days</div>
        <div class="value">${stats.actions30d}</div>
        <div class="sub">${stats.totalActions} all-time</div>
      </div>
      <div class="tile">
        <div class="label">Players on record</div>
        <div class="value">${stats.playersTouched}</div>
        <div class="sub">${typeCount("warn")} warnings · ${typeCount("kick")} kicks</div>
      </div>
    </div>

    <div class="card">
      <h2>Actions — last 30 days</h2>
      ${activityChart(stats.byDay)}
    </div>

    <div class="card">
      <h2>Latest activity</h2>
      ${actionsTable(recent.rows.slice(0, 10))}
    </div>
  </div>`;
  wireChart(view);
}

function actionsTable(rows) {
  if (!rows.length) return `<div class="empty">Nothing yet. Actions from Discord will show up here.</div>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th>Action</th><th>Player</th><th>Reason</th><th>Moderator</th><th>When</th></tr></thead>
    <tbody>${rows.map((a) => `
      <tr>
        <td>${badge(a.type)}${a.type === "ban" || a.type === "dungeon" ? ` <span class="dim">${esc(fmtDur(a.duration_seconds))}</span>` : ""}</td>
        <td>${playerCell(a)}</td>
        <td class="reason-cell"><span class="txt">${esc(a.reason || "—")}</span>${evidenceCount(a.evidence)}</td>
        <td class="dim">${esc(a.moderator_name)}</td>
        <td class="num dim" title="${esc(fmtDate(a.created_at))}">${rel(a.created_at)}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

/* Shared list page for Bans and Dungeon (same shape, different endpoint). */
function makeStateListView({ nav, title, endpoint, activeBadgeType, activeLabel, sentColumn, emptyNoun }) {
  const state = { status: "active", q: "", page: 1 };

  return async function render() {
    setActiveNav(nav);
    document.title = `Warden — ${title.toLowerCase()}`;
    view.innerHTML = `
    <div class="wrap">
      <div class="page-title">${title}</div>
      <div class="filters">
        <div class="seg" role="tablist">
          ${["active", "expired", "all"].map((s) =>
            `<button type="button" data-status="${s}" class="${s === state.status ? "active" : ""}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}
        </div>
        <input type="search" id="listSearch" placeholder="Filter by player, ID, or reason" value="${esc(state.q)}">
        <span class="count" id="listCount"></span>
      </div>
      <div class="card" id="listTable"><div class="loading">Loading…</div></div>
    </div>`;

    document.querySelectorAll("[data-status]").forEach((b) =>
      b.addEventListener("click", () => {
        state.status = b.dataset.status;
        state.page = 1;
        render();
      }));
    document.getElementById("listSearch").addEventListener("input", debounce((e) => {
      state.q = e.target.value.trim();
      state.page = 1;
      load();
    }, 300));

    await load();

    async function load() {
      const data = await api(`${endpoint}?status=${state.status}&q=${encodeURIComponent(state.q)}&page=${state.page}`);
      document.getElementById("listCount").textContent =
        `${data.total} ${emptyNoun}${data.total === 1 ? "" : "s"}`;
      const el = document.getElementById("listTable");
      if (!data.rows.length) {
        el.innerHTML = `<div class="empty">No ${state.status === "all" ? "" : state.status + " "}${emptyNoun}s${state.q ? " matching that search" : ""}.</div>`;
        return;
      }
      el.innerHTML = `<div class="tablewrap"><table>
        <thead><tr><th>Player</th><th>Reason</th><th>Duration</th><th>By</th><th>${sentColumn}</th><th>Status</th></tr></thead>
        <tbody>${data.rows.map((b) => {
          const active = b.state_expires_at === null || b.state_expires_at > data.now;
          const statusCell = active
            ? (b.state_expires_at
                ? `${badge(activeBadgeType, activeLabel)}<div class="dim" style="margin-top:4px">ends ${rel(b.state_expires_at)}</div>`
                : badge(activeBadgeType, activeLabel))
            : `${badge("neutral", "Expired")}<div class="dim" style="margin-top:4px">${rel(b.state_expires_at)}</div>`;
          return `<tr>
            <td>${playerCell(b)}</td>
            <td class="reason-cell"><span class="txt">${esc(b.reason || "—")}</span>${evidenceCount(b.evidence)}</td>
            <td class="dim">${esc(fmtDur(b.duration_seconds))}${b.exclude_alts ? `<div class="dim" style="font-size:12px">+ alts</div>` : ""}</td>
            <td class="dim">${esc(b.moderator_name)}</td>
            <td class="num dim" title="${esc(fmtDate(b.state_since))}">${rel(b.state_since)}</td>
            <td>${statusCell}</td>
          </tr>`;
        }).join("")}</tbody></table></div>
        ${pager(data)}`;
      wirePager(el, data, (p) => { state.page = p; load(); });
    }
  };
}

const renderBans = makeStateListView({
  nav: "bans", title: "Bans", endpoint: "/api/bans",
  activeBadgeType: "ban", activeLabel: "Active", sentColumn: "Banned", emptyNoun: "ban",
});
const renderDungeon = makeStateListView({
  nav: "dungeon", title: "Dungeon", endpoint: "/api/dungeon",
  activeBadgeType: "dungeon", activeLabel: "Serving", sentColumn: "Sent", emptyNoun: "sentence",
});

const actionsState = { type: "", q: "", page: 1 };

async function renderActions() {
  setActiveNav("actions");
  document.title = "Warden — actions";
  const { type, q } = actionsState;
  view.innerHTML = `
  <div class="wrap">
    <div class="page-title">Action log <small>every ban, dungeon, kick, warning, and note</small></div>
    <div class="filters">
      <div class="seg">
        ${[["", "All"], ["ban", "Bans"], ["unban", "Unbans"], ["dungeon", "Dungeon"], ["release", "Releases"], ["kick", "Kicks"], ["warn", "Warns"], ["note", "Notes"]]
          .map(([val, label]) =>
            `<button type="button" data-type="${val}" class="${val === type ? "active" : ""}">${label}</button>`).join("")}
      </div>
      <input type="search" id="actionsSearch" placeholder="Filter by player, reason, or moderator" value="${esc(q)}">
      <span class="count" id="actionsCount"></span>
    </div>
    <div class="card" id="actionsTable"><div class="loading">Loading…</div></div>
  </div>`;

  document.querySelectorAll("[data-type]").forEach((b) =>
    b.addEventListener("click", () => {
      actionsState.type = b.dataset.type;
      actionsState.page = 1;
      renderActions();
    }));
  document.getElementById("actionsSearch").addEventListener("input", debounce((e) => {
    actionsState.q = e.target.value.trim();
    actionsState.page = 1;
    loadActions();
  }, 300));

  await loadActions();

  async function loadActions() {
    const data = await api(`/api/actions?type=${actionsState.type}&q=${encodeURIComponent(actionsState.q)}&page=${actionsState.page}`);
    document.getElementById("actionsCount").textContent =
      `${data.total} action${data.total === 1 ? "" : "s"}`;
    const el = document.getElementById("actionsTable");
    el.innerHTML = data.rows.length
      ? `${actionsTable(data.rows)}${pager(data)}`
      : `<div class="empty">No matching actions.</div>`;
    wirePager(el, data, (p) => { actionsState.page = p; loadActions(); });
  }
}

function pager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (pages <= 1) return "";
  return `<div class="pager">
    <button type="button" data-pg="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>‹ Prev</button>
    <span>Page ${data.page} of ${pages}</span>
    <button type="button" data-pg="${data.page + 1}" ${data.page >= pages ? "disabled" : ""}>Next ›</button>
  </div>`;
}

function wirePager(el, data, go) {
  el.querySelectorAll("[data-pg]").forEach((b) =>
    b.addEventListener("click", () => go(Number(b.dataset.pg))));
}

async function renderUser(userId) {
  setActiveNav("");
  view.innerHTML = `<div class="wrap"><div class="loading">Loading…</div></div>`;
  let data;
  try {
    data = await api(`/api/users/${userId}`);
  } catch (err) {
    if (err.message === "unauthenticated") return;
    view.innerHTML = `<div class="wrap"><div class="page-title">Player</div>
      <div class="card"><div class="empty">${esc(err.message)}</div></div></div>`;
    return;
  }
  const p = data.profile;
  document.title = `Warden — ${p.username ?? p.user_id}`;

  const name = p.display_name || p.username || String(p.user_id);
  const avatar = p.avatar_url
    ? `<img class="big" src="${esc(p.avatar_url)}" alt="">`
    : `<span class="avatar-fallback big">${esc((p.username || "?")[0].toUpperCase())}</span>`;

  // Ban pill
  let banPill, banDetail = "";
  if (data.robloxStatus === null) {
    banPill = data.currentBan?.active
      ? badge("ban", "Banned · local records")
      : badge("neutral", "Ban status unknown");
  } else if (data.robloxStatus.active) {
    banPill = badge("ban", "Banned in game");
    banDetail = data.robloxStatus.duration
      ? `temp — ${esc(fmtDur(parseInt(data.robloxStatus.duration, 10)))}`
      : "permanent";
  } else {
    banPill = badge("unban", "Not banned");
  }

  // Dungeon pill
  let dungeonPill = "", dungeonDetail = "";
  const ds = data.dungeonStatus;
  if (ds === null) {
    if (data.currentDungeon?.active) dungeonPill = badge("dungeon", "In the dungeon · local records");
  } else if (ds.active) {
    dungeonPill = badge("dungeon", "In the dungeon");
    dungeonDetail = ds.permanent
      ? "permanent"
      : `until ${fmtDate(new Date(ds.expiresAt * 1000).toISOString())}`;
  }

  const countFor = (t) => data.counts.find((c) => c.type === t)?.count ?? 0;

  const timeline = data.history.length
    ? `<ul class="timeline">${data.history.map((a) => `
        <li>
          <span class="when" title="${esc(fmtDate(a.created_at))}">${rel(a.created_at)}</span>
          <span class="what">
            <span class="head">
              ${badge(a.type)}
              ${a.type === "ban" || a.type === "dungeon"
                ? `<span class="dim">${esc(fmtDur(a.duration_seconds))}${a.exclude_alts ? " · incl. alts" : ""}</span>` : ""}
              <span class="by">by ${esc(a.moderator_name)}</span>
            </span>
            ${a.reason ? `<div class="body">${esc(a.reason)}</div>` : ""}
            ${a.display_reason && a.display_reason !== a.reason
              ? `<div class="extra">Shown to player: ${esc(a.display_reason)}</div>` : ""}
            ${evidenceHtml(a.evidence)}
          </span>
        </li>`).join("")}
      </ul>`
    : `<div class="empty">Clean record — nothing on file for this player.</div>`;

  view.innerHTML = `
  <div class="wrap">
    <div class="profile-head">
      ${avatar}
      <div class="who">
        <h1>${esc(name)}</h1>
        <div class="sub">
          <span>@${esc(p.username ?? "unknown")}</span>
          <span>ID ${p.user_id}</span>
          ${p.created_on ? `<span>joined Roblox ${esc(fmtDay(p.created_on))}</span>` : ""}
          <a href="https://www.roblox.com/users/${p.user_id}/profile" target="_blank" rel="noopener">Roblox profile ↗</a>
        </div>
      </div>
      <div class="status">
        ${banPill}
        ${banDetail ? `<span class="dim" style="font-size:12px">${banDetail}</span>` : ""}
        ${dungeonPill}
        ${dungeonDetail ? `<span class="dim" style="font-size:12px">${dungeonDetail}</span>` : ""}
      </div>
    </div>

    <div class="countchips">
      ${[["ban", "ban", "bans"], ["dungeon", "dungeon", "dungeons"], ["kick", "kick", "kicks"], ["warn", "warning", "warnings"], ["note", "note", "notes"]]
        .map(([t, one, many]) =>
          `<span class="countchip"><b>${countFor(t)}</b> ${countFor(t) === 1 ? one : many}</span>`).join("")}
    </div>

    <div class="card">
      <h2>Audit history</h2>
      ${timeline}
    </div>
  </div>`;
}

/* ── global search ───────────────────────────────────────── */

function wireSearch() {
  const input = document.getElementById("globalSearch");
  const pop = document.getElementById("searchPop");

  const close = () => { pop.innerHTML = ""; };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    let data;
    try { data = await api(`/api/search?q=${encodeURIComponent(q)}`); }
    catch { return close(); }

    const rows = [];
    for (const pl of data.local) {
      const flags = [pl.banned ? "banned" : "", pl.dungeoned ? "dungeon" : ""].filter(Boolean).join(" · ");
      rows.push(`<button type="button" class="search-row" data-goto="${pl.user_id}">
        ${pl.avatar_url ? `<img class="avatar-fallback" style="object-fit:cover" src="${esc(pl.avatar_url)}" alt="">` : `<span class="avatar-fallback">${esc(pl.username[0].toUpperCase())}</span>`}
        <span>${esc(pl.display_name || pl.username)} <span class="dim">@${esc(pl.username)}</span></span>
        <span class="meta">${flags ? flags + " · " : ""}${pl.action_count} action${pl.action_count === 1 ? "" : "s"}</span>
      </button>`);
    }
    if (data.remote) {
      rows.push(`<button type="button" class="search-row" data-goto="${data.remote.user_id}">
        ${data.remote.avatar_url ? `<img class="avatar-fallback" style="object-fit:cover" src="${esc(data.remote.avatar_url)}" alt="">` : `<span class="avatar-fallback">${esc(data.remote.username[0].toUpperCase())}</span>`}
        <span>${esc(data.remote.display_name || data.remote.username)} <span class="dim">@${esc(data.remote.username)}</span></span>
        <span class="meta">on Roblox — no record</span>
      </button>`);
    }
    pop.innerHTML = rows.length ? rows.join("") : `<div class="hint">No player found for “${esc(q)}”.</div>`;
    pop.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => {
        close();
        input.value = "";
        location.hash = `#/user/${b.dataset.goto}`;
      }));
  }, 280);

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); input.blur(); } });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".searchbox")) close();
  });
}

/* ── router / boot ───────────────────────────────────────── */

async function route() {
  if (!me) return;
  const hash = location.hash.replace(/^#/, "") || "/";
  const userMatch = hash.match(/^\/user\/(\d+)$/);
  try {
    if (userMatch) await renderUser(userMatch[1]);
    else if (hash === "/bans") await renderBans();
    else if (hash === "/dungeon") await renderDungeon();
    else if (hash === "/actions") await renderActions();
    else await renderOverview();
  } catch (err) {
    if (err.message !== "unauthenticated") {
      view.innerHTML = `<div class="wrap"><div class="card"><div class="error-note">${esc(err.message)}</div></div></div>`;
    }
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);

(async function boot() {
  try {
    const data = await api("/api/me");
    me = data.user;
  } catch (err) {
    // 401 → renderLogin already showed the sign-in card. Anything else means
    // there's no server behind this page (opened as a file, or app not running).
    if (err.message !== "unauthenticated") {
      renderOffline(location.protocol === "file:");
    }
    return;
  }
  topbar.hidden = false;
  renderUserchip();
  wireSearch();
  route();
})();
