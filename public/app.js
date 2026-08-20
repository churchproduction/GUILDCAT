/* Warden panel — GuildCat viking theme. Vanilla JS, hash router, no build step. */
"use strict";

const $ = (q) => document.querySelector(q);
const main = $("#main");

/* ── helpers ─────────────────────────────────────────────── */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showEntrance();
    throw new Error("unauthenticated");
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
const api = (path) => send("GET", path);

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

const LBL = {
  ban: "Ban", unban: "Unban", kick: "Kick", warn: "Warn",
  note: "Note", dungeon: "Dungeon", release: "Release",
};
const badge = (t, l) =>
  `<span class="badge b-${esc(t)}">${esc(l ?? LBL[t] ?? t)}</span>`;

function pcell(row) {
  const name = row.display_name || row.current_username || row.username;
  const handle = row.current_username || row.username;
  const av = row.avatar_url
    ? `<span class="pav"><img src="${esc(row.avatar_url)}" alt="" loading="lazy"></span>`
    : `<span class="pav">${esc((handle || "?")[0].toUpperCase())}</span>`;
  return `<a class="pcell" href="#/user/${row.user_id}">${av}
    <span><span class="n1">${esc(name)}</span><br>
    <span class="n2">@${esc(handle)} · ${row.user_id}</span></span></a>`;
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

/* ── toasts & modals ─────────────────────────────────────── */

function toast(msg, isError) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3800);
}

function openModal(html) { $("#modal").innerHTML = html; $("#overlay").classList.add("open"); }
function closeModal() { $("#overlay").classList.remove("open"); }
$("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModal(); });

async function runAction(btn, fn, successMsg) {
  btn.disabled = true;
  try {
    await fn();
    closeModal();
    toast(successMsg);
    route();
  } catch (err) {
    if (err.message !== "unauthenticated") toast(err.message, true);
    btn.disabled = false;
  }
}

function banModal(prefill) {
  openModal(`
  <div class="mhead">Banish a player</div>
  <div class="msub">Real platform ban — Roblox enforces it and removes them mid-session.</div>
  <div class="mbody">
    <div class="field"><label>Roblox username or ID</label><input id="f_user" type="text" value="${esc(prefill || "")}" placeholder="e.g. xX_Blitz_Xx"></div>
    <div class="field"><label>Reason (internal)</label><textarea id="f_reason" placeholder="What they did"></textarea></div>
    <div class="mgrid2">
      <div class="field"><label>Duration</label><select id="f_dur">
        <option value="">Permanent</option><option value="1h">1 hour</option>
        <option value="1d">1 day</option><option value="1w">1 week</option><option value="30d">30 days</option>
      </select></div>
      <div class="field"><label>Shown to player</label><input id="f_disp" type="text" placeholder="defaults to reason"></div>
    </div>
    <label class="check"><input id="f_alts" type="checkbox" checked> Also ban suspected alt accounts</label>
  </div>
  <div class="mfoot"><button class="btn ghost" onclick="closeModal()">Cancel</button>
  <button class="btn danger" id="f_go">Ban player</button></div>`);
  $("#f_go").onclick = () =>
    runAction($("#f_go"), () => send("POST", "/api/mod/ban", {
      user: $("#f_user").value,
      reason: $("#f_reason").value,
      duration: $("#f_dur").value,
      display_reason: $("#f_disp").value,
      include_alts: $("#f_alts").checked,
    }), "Ban issued");
}

function dungeonModal(prefill) {
  openModal(`
  <div class="mhead">Send to the dungeon</div>
  <div class="msub">Moved to a dungeon server now, and on every join until released.</div>
  <div class="mbody">
    <div class="field"><label>Roblox username or ID</label><input id="f_user" type="text" value="${esc(prefill || "")}"></div>
    <div class="field"><label>Reason</label><textarea id="f_reason" placeholder="What they did"></textarea></div>
    <div class="field"><label>Duration</label><select id="f_dur">
      <option value="1m">1 minute</option><option value="1h">1 hour</option>
      <option value="1d" selected>1 day</option><option value="1w">1 week</option>
      <option value="permanent">Permanent</option>
    </select></div>
  </div>
  <div class="mfoot"><button class="btn ghost" onclick="closeModal()">Cancel</button>
  <button class="btn primary" id="f_go">Send</button></div>`);
  $("#f_go").onclick = () =>
    runAction($("#f_go"), () => send("POST", "/api/mod/dungeon", {
      user: $("#f_user").value,
      reason: $("#f_reason").value,
      duration: $("#f_dur").value,
    }), "Sent to the dungeon");
}

/** Generic single-reason modal → POST endpoint with {user, reason|text}. */
function reasonModal({ title, sub, label = "Reason", required = false, endpoint, field = "reason", user, submit, danger, success }) {
  openModal(`
  <div class="mhead">${esc(title)}</div>
  ${sub ? `<div class="msub">${esc(sub)}</div>` : ""}
  <div class="mbody">
    <div class="field"><label>${esc(label)}${required ? "" : " (optional)"}</label>
    <textarea id="f_reason"></textarea></div>
  </div>
  <div class="mfoot"><button class="btn ghost" onclick="closeModal()">Cancel</button>
  <button class="btn ${danger ? "danger" : "primary"}" id="f_go">${esc(submit)}</button></div>`);
  $("#f_go").onclick = () => {
    const value = $("#f_reason").value.trim();
    if (required && !value) return toast(`${label} is required`, true);
    runAction($("#f_go"), () => send("POST", endpoint, { user, [field]: value }), success);
  };
}

function confirmDelete(actionId, extraWarning) {
  openModal(`
  <div class="mhead">Delete this log entry?</div>
  <div class="msub">${esc(extraWarning || "Removes it and its evidence from the record forever. Senior staff only.")}</div>
  <div class="mfoot" style="padding-top:18px">
    <button class="btn ghost" onclick="closeModal()">Cancel</button>
    <button class="btn danger" id="f_go">Delete</button></div>`);
  $("#f_go").onclick = () =>
    runAction($("#f_go"), () => send("DELETE", `/api/mod/actions/${actionId}`), "Log entry deleted");
}

/* expose for inline handlers */
window.closeModal = closeModal;
window.banModal = banModal;
window.dungeonModal = dungeonModal;
window.reasonModal = reasonModal;
window.confirmDelete = confirmDelete;

/* ── evidence rendering ──────────────────────────────────── */

const evnote = (list) =>
  list?.length ? `<div class="evnote">${list.length} evidence</div>` : "";

function evidenceHtml(list) {
  if (!list?.length) return "";
  const items = list.map((e) => {
    if (e.kind === "link" && e.url) {
      let host = e.url;
      try { host = new URL(e.url).hostname.replace(/^www\./, ""); } catch {}
      return `<a class="evlink" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(host)} ↗</a>`;
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
  return `<div class="evwrap">${items.join("")}</div>`;
}

/* ── entrance / session ──────────────────────────────────── */

let me = null;
let entranceInited = false;

function initEntranceFx() {
  if (entranceInited) return;
  entranceInited = true;
  const el = $("#gctitle");
  el.innerHTML = [...el.textContent].map((ch, i) =>
    ch === " " ? `<span style="width:.45em"></span>`
      : `<span style="animation-delay:${120 + i * 85}ms">${ch}</span>`).join("");
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const layer = $("#rainlayer");
    let html = "";
    for (let i = 0; i < 130; i++) {
      const far = Math.random() < 0.45;
      const left = Math.random() * 104 - 2;
      const h = far ? 9 + Math.random() * 8 : 14 + Math.random() * 14;
      const dur = (far ? 0.9 + Math.random() * 0.35 : 0.55 + Math.random() * 0.3).toFixed(2);
      const delay = (-Math.random() * 2).toFixed(2);
      const op = (far ? 0.35 : 0.5 + Math.random() * 0.5).toFixed(2);
      html += `<span class="drop${far ? " far" : ""}" style="left:${left}%;height:${h}px;animation-duration:${dur}s;animation-delay:${delay}s;opacity:${op}"></span>`;
    }
    layer.innerHTML = html;
  }
}

function showEntrance() {
  me = null;
  $("#shell").hidden = true;
  $("#mtop").hidden = true;
  $("#mnav").hidden = true;
  $("#enter").hidden = false;
  initEntranceFx();
}

function showOffline(openedAsFile) {
  $("#enter").hidden = true;
  $("#shell").hidden = true;
  $("#mtop").hidden = true;
  $("#mnav").hidden = true;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="center-stage"><div class="plain-card">
      <h1>WARDEN</h1>
      ${openedAsFile
        ? `<p>This page is the front end of the Warden app — it only works when the app's server is behind it.</p>
           <p>Run <code>npm run preview</code> for a sample-data demo, or <code>npm start</code> with your <code>.env</code> filled in.</p>`
        : `<p>Can't reach the Warden server right now.</p>
           <p>If it's supposed to be running, refresh in a moment — otherwise start it with <code>npm start</code>.</p>`}
    </div></div>`);
}

function showPanel() {
  $("#enter").hidden = true;
  $("#shell").hidden = false;
  $("#mtop").hidden = false;
  $("#mnav").hidden = false;
  const who = $("#whoami");
  who.innerHTML = `
    ${me.avatar ? `<img class="av" src="${esc(me.avatar)}" alt="">` : `<span class="av">${esc((me.username || "?")[0].toUpperCase())}</span>`}
    <span><span class="nm">${esc(me.displayName || me.username)}</span><br>
    <span class="tier">${me.senior ? "Senior staff" : "Moderator"}</span></span>
    <button class="out" id="logoutBtn">Sign out</button>`;
  $("#logoutBtn").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    showEntrance();
  });
  $("#mav").innerHTML = me.avatar
    ? `<img src="${esc(me.avatar)}" alt="">`
    : esc((me.username || "?")[0].toUpperCase());
  route();
}

/* ── chart (single series → forged gold, no legend) ──────── */

function activityChart(byDay) {
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    days.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  const map = Object.fromEntries((byDay || []).map((r) => [r.day, r.count]));
  const values = days.map((d) => map[d] || 0);
  const max = Math.max(...values);
  if (max === 0) return `<div class="chart-empty">No actions in the last 30 days.</div>`;

  const W = 880, H = 170, padL = 28, padT = 12, padB = 20;
  const plotW = W - padL - 8, plotH = H - padT - padB;
  const step = plotW / days.length;
  const bw = Math.max(4, step - 5);
  const yMax = Math.max(4, Math.ceil(max * 1.15));
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  let bars = "", hits = "", ticks = "";
  days.forEach((day, i) => {
    const v = values[i];
    const x = padL + i * step + (step - bw) / 2;
    if (v > 0) {
      const r = Math.min(4, bw / 2, y(0) - y(v));
      const yt = y(v), yb = y(0);
      bars += `<path d="M${x},${yb} L${x},${yt + r} Q${x},${yt} ${x + r},${yt} L${x + bw - r},${yt} Q${x + bw},${yt} ${x + bw},${yt + r} L${x + bw},${yb} Z" fill="url(#goldbar)"/>`;
    }
    hits += `<rect class="hit" data-i="${i}" x="${padL + i * step}" y="${padT}" width="${step}" height="${plotH}" fill="transparent"/>`;
    if (new Date(day + "T00:00:00").getDay() === 1) {
      ticks += `<text x="${padL + i * step + step / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#7d7a70">${new Date(day + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`;
    }
  });

  return `
  <div class="chartbox" data-days='${esc(JSON.stringify(days))}' data-values='${esc(JSON.stringify(values))}'>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Moderation actions per day, last 30 days">
      <defs><linearGradient id="goldbar" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e7bc6e"/><stop offset="1" stop-color="#b3822f"/></linearGradient></defs>
      <line x1="${padL}" y1="${y(0)}" x2="${W - 8}" y2="${y(0)}" stroke="#333b4e"/>
      <line x1="${padL}" y1="${y(yMax / 2)}" x2="${W - 8}" y2="${y(yMax / 2)}" stroke="#242a38"/>
      <line x1="${padL}" y1="${y(yMax)}" x2="${W - 8}" y2="${y(yMax)}" stroke="#242a38"/>
      <text x="${padL - 8}" y="${y(0) + 4}" text-anchor="end" font-size="10" fill="#7d7a70">0</text>
      <text x="${padL - 8}" y="${y(yMax) + 4}" text-anchor="end" font-size="10" fill="#7d7a70">${yMax}</text>
      ${bars}${ticks}${hits}</svg>
    <div class="tip"></div>
  </div>`;
}

function wireChart(container) {
  const box = container.querySelector(".chartbox");
  if (!box) return;
  const days = JSON.parse(box.dataset.days);
  const values = JSON.parse(box.dataset.values);
  const tip = box.querySelector(".tip");
  const svg = box.querySelector("svg");
  svg.addEventListener("mousemove", (e) => {
    const h = e.target.closest(".hit");
    if (!h) { tip.style.opacity = 0; return; }
    const i = Number(h.dataset.i);
    const r = box.getBoundingClientRect(), hr = h.getBoundingClientRect();
    tip.innerHTML = `<b>${values[i]}</b> action${values[i] === 1 ? "" : "s"} · ${fmtDay(days[i])}`;
    tip.style.left = hr.left - r.left + hr.width / 2 + "px";
    tip.style.top = hr.top - r.top + 6 + "px";
    tip.style.opacity = 1;
  });
  svg.addEventListener("mouseleave", () => { tip.style.opacity = 0; });
}

/* ── shared pieces ───────────────────────────────────────── */

function searchboxHtml(id, ph) {
  return `<div class="searchbox">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input id="${id}" type="search" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false">
    <div class="search-pop" id="${id}Pop"></div>
  </div>`;
}

const head = (title, sub, extra) => `
  <div class="pagehead"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
  <span class="grow"></span>${extra || ""}</div>
  <div class="runeline"><span>ᛉ ᛟ ᚦ</span></div>`;

function pagerHtml(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (pages <= 1) return "";
  return `<div class="pager">
    <button type="button" class="btn ghost sm" data-pg="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>‹ Prev</button>
    <span>Page ${data.page} of ${pages}</span>
    <button type="button" class="btn ghost sm" data-pg="${data.page + 1}" ${data.page >= pages ? "disabled" : ""}>Next ›</button>
  </div>`;
}
function wirePager(el, go) {
  el.querySelectorAll("[data-pg]").forEach((b) =>
    b.addEventListener("click", () => go(Number(b.dataset.pg))));
}

function feedRow(a) {
  const extra = a.type === "ban" || a.type === "dungeon"
    ? ` <span class="bydim">${esc(fmtDur(a.duration_seconds))}</span>` : "";
  const del = me?.senior
    ? `<button class="btn ghost sm" title="Delete log entry" onclick="confirmDelete(${a.id})">✕</button>` : "";
  return `<div class="row g-feed">
    <div>${badge(a.type)}${extra}</div>
    <div>${pcell(a)}</div>
    <div><span class="reason">${esc(a.reason || "—")}</span>${evnote(a.evidence)}</div>
    <div class="bydim">by ${esc(a.moderator_name)}<div class="when" title="${esc(fmtDate(a.created_at))}">${rel(a.created_at)}</div></div>
    <div class="rowactions">${del}</div>
  </div>`;
}

function wireGlobalSearch(inputId) {
  const input = document.getElementById(inputId);
  const pop = document.getElementById(inputId + "Pop");
  if (!input || !pop) return;
  const close = () => { pop.innerHTML = ""; };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    let data;
    try { data = await api(`/api/search?q=${encodeURIComponent(q)}`); }
    catch { return close(); }

    const rows = [];
    const rowHtml = (pl, meta) => `
      <button type="button" class="search-row" data-goto="${pl.user_id}">
        ${pl.avatar_url ? `<img src="${esc(pl.avatar_url)}" alt="">` : `<span class="pav">${esc((pl.username || "?")[0].toUpperCase())}</span>`}
        <span>${esc(pl.display_name || pl.username)} <span class="bydim">@${esc(pl.username)}</span></span>
        <span class="meta">${meta}</span>
      </button>`;
    for (const pl of data.local) {
      const flags = [pl.banned ? "banned" : "", pl.dungeoned ? "dungeon" : ""].filter(Boolean).join(" · ");
      rows.push(rowHtml(pl, `${flags ? flags + " · " : ""}${pl.action_count} action${pl.action_count === 1 ? "" : "s"}`));
    }
    if (data.remote) rows.push(rowHtml(data.remote, "on Roblox — no record"));
    pop.innerHTML = rows.length ? rows.join("") : `<div class="hint">No player found for “${esc(q)}”.</div>`;
    pop.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => {
        close(); input.value = "";
        location.hash = `#/user/${b.dataset.goto}`;
      }));
  }, 280);

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); input.blur(); } });
  document.addEventListener("click", (e) => { if (!e.target.closest(".searchbox")) close(); });
}

/* ── views ───────────────────────────────────────────────── */

async function renderOverview() {
  document.title = "Warden — overview";
  main.innerHTML = `<div class="loading">Loading…</div>`;
  const [stats, recent] = await Promise.all([api("/api/stats"), api("/api/actions?page=1")]);
  const typeCount = (t) => stats.byType.find((r) => r.type === t)?.count ?? 0;

  main.innerHTML = `
  ${head("Overview", "The last 30 days in your realm", searchboxHtml("globalSearch", "Search player, ID, or profile link"))}
  <div class="tiles">
    <div class="tile"><div class="label">Active bans</div><div class="value ember">${stats.activeBans}</div><div class="subv">${typeCount("ban")} issued all-time</div></div>
    <div class="tile"><div class="label">In the dungeon</div><div class="value rune">${stats.activeDungeons}</div><div class="subv">${typeCount("dungeon")} sentences all-time</div></div>
    <div class="tile"><div class="label">Actions · 30 days</div><div class="value gold">${stats.actions30d}</div><div class="subv">${stats.totalActions} all-time</div></div>
    <div class="tile"><div class="label">Players on record</div><div class="value">${stats.playersTouched}</div><div class="subv">${typeCount("warn")} warnings · ${typeCount("kick")} kicks</div></div>
  </div>
  <div class="card"><div class="chead"><h2>ACTIVITY</h2></div><div class="cbody">${activityChart(stats.byDay)}</div></div>
  <div class="card"><div class="chead"><h2>LATEST</h2><span class="grow"></span><a class="btn ghost sm" href="#/actions">View all →</a></div>
  <div class="list" style="margin-top:8px">${recent.rows.slice(0, 8).map(feedRow).join("") || `<div class="empty">Nothing yet — actions will show up here.</div>`}</div></div>`;
  wireChart(main);
  wireGlobalSearch("globalSearch");
}

function makeStateListView({ title, endpoint, activeLabel, badgeType, emptyNoun, newButton, rowAction }) {
  const state = { status: "active", q: "", page: 1 };

  return async function render() {
    document.title = `Warden — ${title.toLowerCase()}`;
    main.innerHTML = `
    ${head(title, "", newButton ? newButton() : "")}
    <div class="toolbar">
      <div class="seg">${["active", "expired", "all"].map((s) =>
        `<button type="button" data-status="${s}" class="${s === state.status ? "active" : ""}">${s === "active" ? esc(activeLabel) : s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
      ${searchboxHtml("listFilter", "Filter by player, ID, or reason")}
      <span class="count" id="listCount"></span>
    </div>
    <div class="card" id="listCard"><div class="loading">Loading…</div></div>`;

    main.querySelectorAll("[data-status]").forEach((b) =>
      b.addEventListener("click", () => { state.status = b.dataset.status; state.page = 1; render(); }));
    document.getElementById("listFilter").addEventListener("input", debounce((e) => {
      state.q = e.target.value.trim(); state.page = 1; load();
    }, 300));
    document.getElementById("listFilter").value = state.q;

    await load();

    async function load() {
      const data = await api(`${endpoint}?status=${state.status}&q=${encodeURIComponent(state.q)}&page=${state.page}`);
      $("#listCount").textContent = `${data.total} ${emptyNoun}${data.total === 1 ? "" : "s"}`;
      const el = $("#listCard");
      if (!data.rows.length) {
        el.innerHTML = `<div class="empty">No ${state.status === "all" ? "" : state.status + " "}${emptyNoun}s${state.q ? " matching that filter" : ""}.</div>`;
        return;
      }
      el.innerHTML = `<div class="list">${data.rows.map((b) => {
        const active = b.state_expires_at === null || b.state_expires_at > data.now;
        const statusCell = active
          ? `${badge(badgeType, activeLabel)}${b.state_expires_at ? `<div class="when" style="margin-top:5px">ends ${rel(b.state_expires_at)}</div>` : ""}`
          : `${badge("neutral", "Expired")}<div class="when" style="margin-top:5px">${rel(b.state_expires_at)}</div>`;
        return `<div class="row g-state">
          <div>${pcell(b)}</div>
          <div><span class="reason">${esc(b.reason || "—")}</span>${evnote(b.evidence)}</div>
          <div class="bydim">${esc(fmtDur(b.duration_seconds))}${b.exclude_alts ? `<div class="when">+ alt accounts</div>` : ""}</div>
          <div>${statusCell}<div class="when" style="margin-top:3px">${rel(b.state_since)} · by ${esc(b.moderator_name)}</div></div>
          <div class="rowactions">${active && rowAction ? rowAction(b) : ""}</div>
        </div>`;
      }).join("")}</div>${pagerHtml(data)}`;
      wirePager(el, (p) => { state.page = p; load(); });
    }
  };
}

const renderBans = makeStateListView({
  title: "Bans", endpoint: "/api/bans", activeLabel: "Banished", badgeType: "ban", emptyNoun: "ban",
  newButton: () => me?.senior ? `<button class="btn danger" onclick="banModal()">＋ New ban</button>` : "",
  rowAction: (b) => me?.senior
    ? `<button class="btn sm" onclick="reasonModal({title:'Unban ${esc(b.current_username)}?',endpoint:'/api/mod/unban',user:'${b.user_id}',submit:'Unban',success:'Unbanned ${esc(b.current_username)}'})">Unban</button>`
    : "",
});

const renderDungeon = makeStateListView({
  title: "The Dungeon", endpoint: "/api/dungeon", activeLabel: "Serving", badgeType: "dungeon", emptyNoun: "sentence",
  newButton: () => `<button class="btn primary" onclick="dungeonModal()">＋ Send to dungeon</button>`,
  rowAction: (b) =>
    `<button class="btn sm" onclick="reasonModal({title:'Release ${esc(b.current_username)}?',endpoint:'/api/mod/release',user:'${b.user_id}',submit:'Release',success:'Released ${esc(b.current_username)}'})">Release</button>`,
});

const actionsState = { type: "", q: "", page: 1 };

async function renderActions() {
  document.title = "Warden — ledger";
  main.innerHTML = `
  ${head("The Ledger", "Every ban, dungeon, kick, warning, and note")}
  <div class="toolbar">
    <div class="seg">${[["", "All"], ["ban", "Bans"], ["unban", "Unbans"], ["dungeon", "Dungeon"], ["release", "Releases"], ["kick", "Kicks"], ["warn", "Warns"], ["note", "Notes"]]
      .map(([val, label]) => `<button type="button" data-type="${val}" class="${val === actionsState.type ? "active" : ""}">${label}</button>`).join("")}</div>
    ${searchboxHtml("actionsFilter", "Filter by player, reason, or moderator")}
    <span class="count" id="actionsCount"></span>
  </div>
  <div class="card" id="actionsCard"><div class="loading">Loading…</div></div>`;

  main.querySelectorAll("[data-type]").forEach((b) =>
    b.addEventListener("click", () => { actionsState.type = b.dataset.type; actionsState.page = 1; renderActions(); }));
  const filter = document.getElementById("actionsFilter");
  filter.value = actionsState.q;
  filter.addEventListener("input", debounce((e) => {
    actionsState.q = e.target.value.trim(); actionsState.page = 1; load();
  }, 300));

  await load();

  async function load() {
    const data = await api(`/api/actions?type=${actionsState.type}&q=${encodeURIComponent(actionsState.q)}&page=${actionsState.page}`);
    $("#actionsCount").textContent = `${data.total} action${data.total === 1 ? "" : "s"}`;
    const el = $("#actionsCard");
    el.innerHTML = data.rows.length
      ? `<div class="list">${data.rows.map(feedRow).join("")}</div>${pagerHtml(data)}`
      : `<div class="empty">No matching actions.</div>`;
    wirePager(el, (p) => { actionsState.page = p; load(); });
  }
}

async function renderUser(userId) {
  main.innerHTML = `<div class="loading">Loading…</div>`;
  let data;
  try {
    data = await api(`/api/users/${userId}`);
  } catch (err) {
    if (err.message === "unauthenticated") return;
    main.innerHTML = `${head("Player")}<div class="card"><div class="empty">${esc(err.message)}</div></div>`;
    return;
  }
  const p = data.profile;
  document.title = `Warden — ${p.username ?? p.user_id}`;
  const name = p.display_name || p.username || String(p.user_id);
  const handle = p.username ?? "unknown";

  // status pills
  let pills = "";
  if (data.robloxStatus === null) {
    pills += data.currentBan?.active ? badge("ban", "Banned · local records") : badge("neutral", "Ban unknown");
  } else if (data.robloxStatus.active) {
    pills += badge("ban", data.robloxStatus.duration ? "Banned · temp" : "Banned · permanent");
  } else {
    pills += badge("unban", "Not banned");
  }
  const ds = data.dungeonStatus;
  if (ds === null) {
    if (data.currentDungeon?.active) pills += " " + badge("dungeon", "In the dungeon · local records");
  } else if (ds.active) {
    pills += " " + badge("dungeon", ds.permanent
      ? "In the dungeon · permanent"
      : `In the dungeon · until ${fmtDate(new Date(ds.expiresAt * 1000).toISOString())}`);
  }

  const countFor = (t) => data.counts.find((c) => c.type === t)?.count ?? 0;
  const uq = `'${p.user_id}'`;

  const actionBar = `
  <div class="actionrow">
    ${me?.senior ? `<button class="btn danger" onclick="banModal('${p.user_id}')">Ban</button>` : ""}
    ${me?.senior ? `<button class="btn" onclick="reasonModal({title:'Unban ${esc(handle)}?',endpoint:'/api/mod/unban',user:${uq},submit:'Unban',success:'Unbanned'})">Unban</button>` : ""}
    <button class="btn" onclick="dungeonModal('${p.user_id}')">Dungeon</button>
    <button class="btn" onclick="reasonModal({title:'Release ${esc(handle)}?',endpoint:'/api/mod/release',user:${uq},submit:'Release',success:'Released'})">Release</button>
    <button class="btn" onclick="reasonModal({title:'Kick ${esc(handle)}?',sub:'Only works if they are in a server right now.',endpoint:'/api/mod/kick',user:${uq},submit:'Kick',success:'Kick sent'})">Kick</button>
    <button class="btn" onclick="reasonModal({title:'Warn ${esc(handle)}',endpoint:'/api/mod/warn',user:${uq},required:true,submit:'Warn',success:'Warning logged'})">Warn</button>
    <button class="btn ghost" onclick="reasonModal({title:'Add note',label:'Note',field:'text',endpoint:'/api/mod/note',user:${uq},required:true,submit:'Save note',success:'Note added'})">＋ Note</button>
  </div>`;

  const timeline = data.history.length
    ? `<ul class="timeline">${data.history.map((a) => `
        <li>
          <span class="when" title="${esc(fmtDate(a.created_at))}">${rel(a.created_at)}</span>
          <span>
            <span class="thead">${badge(a.type)}
              ${a.type === "ban" || a.type === "dungeon"
                ? `<span class="bydim">${esc(fmtDur(a.duration_seconds))}${a.exclude_alts ? " · incl. alts" : ""}</span>` : ""}
              <span class="tby">by ${esc(a.moderator_name)}</span></span>
            ${a.reason ? `<div class="tbody">${esc(a.reason)}</div>` : ""}
            ${a.display_reason && a.display_reason !== a.reason
              ? `<div class="textra">Shown to player: ${esc(a.display_reason)}</div>` : ""}
            ${evidenceHtml(a.evidence)}
          </span>
          ${me?.senior ? `<button class="btn ghost sm del" onclick="confirmDelete(${a.id})">✕</button>` : "<span></span>"}
        </li>`).join("")}
      </ul>`
    : `<div class="empty">Clean record — nothing on file for this player.</div>`;

  main.innerHTML = `
  <div class="phead">
    <div class="bigav">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : esc((handle || "?")[0].toUpperCase())}</div>
    <div><h1>${esc(name)}</h1>
      <div class="meta"><span>@${esc(handle)}</span><span>ID ${p.user_id}</span>
        ${p.created_on ? `<span>on Roblox since ${esc(fmtDay(p.created_on))}</span>` : ""}
        <a href="https://www.roblox.com/users/${p.user_id}/profile" target="_blank" rel="noopener">Roblox profile ↗</a></div></div>
    <div class="stat">${pills}</div>
  </div>
  <div class="runeline"><span>ᛉ ᛟ ᚦ</span></div>
  ${actionBar}
  <div class="chips">
    ${[["ban", "ban", "bans"], ["dungeon", "dungeon", "dungeons"], ["kick", "kick", "kicks"], ["warn", "warning", "warnings"], ["note", "note", "notes"]]
      .map(([t, one, many]) => `<span class="chip"><b>${countFor(t)}</b> ${countFor(t) === 1 ? one : many}</span>`).join("")}
  </div>
  <div class="card"><div class="chead"><h2>HISTORY</h2></div>${timeline}</div>`;
}

/* ── router / boot ───────────────────────────────────────── */

const NAV = [["#/", "overview", "Overview"], ["#/bans", "bans", "Bans"], ["#/dungeon", "dungeon", "Dungeon"], ["#/actions", "actions", "The Ledger"]];
const ICONS = {
  overview: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>',
  bans: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m5.8 5.8 12.4 12.4"/></svg>',
  dungeon: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v15"/><path d="M2 21h20"/><path d="M9 21v-4m6 4v-4M8 9h.01M12 9h.01M16 9h.01"/></svg>',
  actions: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
};

function setNav(active) {
  $("#nav").innerHTML = NAV.map(([href, key, label]) =>
    `<a href="${href}" class="${key === active ? "active" : ""}">${ICONS[key]}${label}</a>`).join("");
  $("#mnav").innerHTML = NAV.map(([href, key, label]) =>
    `<a href="${href}" class="${key === active ? "active" : ""}">${ICONS[key]}${key === "actions" ? "Ledger" : label}</a>`).join("");
}

async function route() {
  if (!me) return;
  const hash = location.hash.replace(/^#/, "") || "/";
  const userMatch = hash.match(/^\/user\/(\d+)$/);
  try {
    if (userMatch) { setNav(""); await renderUser(userMatch[1]); }
    else if (hash === "/bans") { setNav("bans"); await renderBans(); }
    else if (hash === "/dungeon") { setNav("dungeon"); await renderDungeon(); }
    else if (hash === "/actions") { setNav("actions"); await renderActions(); }
    else { setNav("overview"); await renderOverview(); }
  } catch (err) {
    if (err.message !== "unauthenticated") {
      main.innerHTML = `<div class="card"><div class="error-note">${esc(err.message)}</div></div>`;
    }
  }
  window.scrollTo(0, 0);
}
window.route = route;
window.addEventListener("hashchange", route);

(async function boot() {
  try {
    const data = await api("/api/me");
    me = data.user;
    showPanel();
  } catch (err) {
    if (err.message === "unauthenticated") return; // entrance already shown
    showOffline(location.protocol === "file:");
  }
})();
