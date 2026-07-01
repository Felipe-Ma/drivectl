/* drivectl frontend — plain JS single-page app */
"use strict";

// ---------------------------------------------------------------- state ----
const state = {
  profiles: [],
  selectedId: null,
  drives: [],
  sortKey: "name",
  sortAsc: true,
  connStatus: {},        // profile_id -> "ok" | "error" | "unknown"
  editingId: null,       // profile being edited in the modal, or null
  autoRefreshTimer: null,
  pendingPower: new Set(), // "storage/drive" keys with an in-flight power action
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ api ----
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (e) {
    throw new Error("Cannot reach the drivectl backend — is it running?");
  }
  if (resp.status === 204) return null;
  let data = null;
  try { data = await resp.json(); } catch (e) { /* no body */ }
  if (!resp.ok) {
    const msg = (data && (data.detail || data.error)) || `HTTP ${resp.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

// --------------------------------------------------------------- helpers ----
function humanBytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function driveKey(d) { return `${d.storage_id}/${d.drive_id}`; }

function powerStatus(d) {
  const s = (d.state || "").toLowerCase();
  const h = (d.health || "").toLowerCase();
  if (s === "enabled" && (h === "ok" || h === "")) return "on";
  if (["standbyoffline", "disabled", "offline", "absent"].includes(s)) return "off";
  return "warn";
}

function badge(d) {
  const p = powerStatus(d);
  const label = d.state || "Unknown";
  const health = d.health ? ` · ${d.health}` : "";
  const cls = {
    on:   "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    off:  "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  }[p];
  const dot = { on: "bg-emerald-400", off: "bg-zinc-500", warn: "bg-amber-400" }[p];
  return `<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}">
    <span class="h-1.5 w-1.5 rounded-full ${dot}"></span>${esc(label)}${esc(health)}</span>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- toasts ----
function toast(message, kind = "info", timeout = 5000) {
  const el = document.createElement("div");
  const styles = {
    info:    "border-zinc-700 bg-zinc-900 text-zinc-200",
    success: "border-emerald-800 bg-emerald-950/90 text-emerald-200",
    error:   "border-red-900 bg-red-950/90 text-red-200",
  }[kind];
  el.className = `rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur transition ${styles}`;
  el.textContent = message;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// --------------------------------------------------------------- sidebar ----
function renderSidebar() {
  const list = $("server-list");
  list.innerHTML = "";
  if (state.profiles.length === 0) {
    list.innerHTML = `<p class="px-3 py-2 text-xs text-zinc-500">No servers yet.</p>`;
    return;
  }
  for (const p of state.profiles) {
    const selected = p.id === state.selectedId;
    const status = state.connStatus[p.id] || "unknown";
    const dotCls = {
      ok: "bg-emerald-400", error: "bg-red-500", unknown: "bg-zinc-600",
    }[status];
    const btn = document.createElement("button");
    btn.className =
      `w-full text-left rounded-lg px-3 py-2.5 transition flex items-center gap-2.5 ` +
      (selected ? "bg-indigo-600/20 border border-indigo-500/40"
                : "hover:bg-zinc-800/70 border border-transparent");
    btn.innerHTML = `
      <span class="h-2 w-2 rounded-full shrink-0 ${dotCls}" title="Connection: ${status}"></span>
      <span class="min-w-0">
        <span class="block text-sm font-medium truncate">${esc(p.label)}</span>
        <span class="block text-xs text-zinc-500 font-mono truncate">${esc(p.bmc_ip)}</span>
      </span>`;
    btn.addEventListener("click", () => selectServer(p.id));
    list.appendChild(btn);
  }
}

async function probeConnection(profileId) {
  try {
    const res = await api("POST", `/api/profiles/${profileId}/test`);
    state.connStatus[profileId] = res && res.ok ? "ok" : "error";
  } catch (e) {
    state.connStatus[profileId] = "error";
  }
  renderSidebar();
}

// ------------------------------------------------------------ main panel ----
function show(id, visible) { $(id).classList.toggle("hidden", !visible); }

async function selectServer(profileId) {
  state.selectedId = profileId;
  renderSidebar();
  const p = state.profiles.find((x) => x.id === profileId);
  if (!p) return;
  show("main-empty", false);
  show("main-panel", true);
  $("server-title").textContent = p.label;
  $("server-ip").textContent = p.bmc_ip;
  await loadDrives();
}

async function loadDrives({ silent = false } = {}) {
  const profileId = state.selectedId;
  if (!profileId) return;
  if (!silent) {
    show("drives-loading", true);
    show("drives-table-wrap", false);
    show("drives-error", false);
    show("drives-empty", false);
    $("drive-count").textContent = "";
  }
  try {
    const drives = await api("GET", `/api/profiles/${profileId}/drives`);
    if (state.selectedId !== profileId) return; // user switched servers meanwhile
    state.drives = drives;
    state.connStatus[profileId] = "ok";
    renderSidebar();
    renderDrives();
  } catch (e) {
    if (state.selectedId !== profileId) return;
    state.connStatus[profileId] = "error";
    renderSidebar();
    if (silent) return;
    show("drives-loading", false);
    show("drives-error", true);
    $("drives-error").textContent = e.message;
  }
}

function renderDrives() {
  show("drives-loading", false);
  show("drives-error", false);
  const drives = [...state.drives];
  $("drive-count").textContent =
    `${drives.length} drive${drives.length === 1 ? "" : "s"} discovered`;
  if (drives.length === 0) {
    show("drives-empty", true);
    show("drives-table-wrap", false);
    return;
  }
  show("drives-empty", false);
  show("drives-table-wrap", true);

  const k = state.sortKey;
  drives.sort((a, b) => {
    let va = a[k], vb = b[k];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return state.sortAsc ? cmp : -cmp;
  });

  const tbody = $("drives-tbody");
  tbody.innerHTML = "";
  for (const d of drives) {
    const p = powerStatus(d);
    const key = driveKey(d);
    const busy = state.pendingPower.has(key);
    const tr = document.createElement("tr");
    tr.className = "hover:bg-zinc-900/50 transition";
    tr.innerHTML = `
      <td class="px-4 py-3">
        <div class="font-medium">${esc(d.name || d.drive_id)}</div>
        <div class="text-xs text-zinc-500 font-mono">${esc(d.storage_id)} / ${esc(d.drive_id)}</div>
      </td>
      <td class="px-4 py-3 text-zinc-300">
        <div>${esc(d.model || "—")}</div>
        <div class="text-xs text-zinc-500 font-mono">${esc(d.serial_number || "")}</div>
      </td>
      <td class="px-4 py-3 text-right text-zinc-300 tabular-nums">${humanBytes(d.capacity_bytes)}</td>
      <td class="px-4 py-3 text-zinc-300">${esc(d.media_type || "—")}${d.protocol ? ` <span class="text-zinc-500">· ${esc(d.protocol)}</span>` : ""}</td>
      <td class="px-4 py-3">${badge(d)}</td>
      <td class="px-4 py-3 text-right whitespace-nowrap">
        ${busy
          ? `<span class="inline-block h-4 w-4 rounded-full border-2 border-zinc-600 border-t-indigo-400 animate-spin align-middle"></span>`
          : `<button data-act="on" data-key="${esc(key)}" ${p === "on" ? "disabled" : ""}
               class="rounded-lg px-3 py-1.5 text-xs font-medium transition mr-1.5
                      ${p === "on" ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                                   : "bg-emerald-600/90 hover:bg-emerald-500 text-white"}">On</button>
             <button data-act="off" data-key="${esc(key)}" ${p === "off" ? "disabled" : ""}
               class="rounded-lg px-3 py-1.5 text-xs font-medium transition
                      ${p === "off" ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                                    : "bg-red-600/90 hover:bg-red-500 text-white"}">Off</button>`}
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [storageId, driveId] = btn.dataset.key.split("/");
      const drive = state.drives.find(
        (d) => d.storage_id === storageId && d.drive_id === driveId);
      if (drive) requestPower(drive, btn.dataset.act);
    });
  });
}

// ---------------------------------------------------------- power actions ----
function requestPower(drive, action) {
  if (action === "off") {
    const server = state.profiles.find((p) => p.id === state.selectedId);
    $("confirm-title").textContent = "Power off drive?";
    $("confirm-body").innerHTML =
      `You are about to power <b>OFF</b> drive
       <b>${esc(drive.name || drive.drive_id)}</b>
       (<span class="font-mono">${esc(drive.drive_id)}</span>) on server
       <b>${esc(server ? server.label : "")}</b>. The drive will go offline.`;
    show("confirm-modal", true);
    $("confirm-ok").onclick = () => {
      show("confirm-modal", false);
      doPower(drive, "off");
    };
  } else {
    doPower(drive, "on");
  }
}

async function doPower(drive, action) {
  const profileId = state.selectedId;
  const key = driveKey(drive);
  state.pendingPower.add(key);
  renderDrives();
  try {
    const res = await api(
      "POST",
      `/api/profiles/${profileId}/drives/${encodeURIComponent(drive.storage_id)}/${encodeURIComponent(drive.drive_id)}/power`,
      { action });
    const newState = res && res.drive && res.drive.state;
    if (res && res.drive && res.drive.drive_id) {
      const i = state.drives.findIndex((d) => driveKey(d) === key);
      if (i >= 0) state.drives[i] = res.drive;
    }
    toast(
      `Drive ${drive.name || drive.drive_id}: power ${action} sent` +
      (newState ? ` — state is now "${newState}"` : ""),
      "success");
  } catch (e) {
    toast(`Power ${action} failed for ${drive.name || drive.drive_id}: ${e.message}`, "error", 8000);
  } finally {
    state.pendingPower.delete(key);
    renderDrives();
  }
}

// ------------------------------------------------------------ server CRUD ----
function openServerModal(profile) {
  state.editingId = profile ? profile.id : null;
  $("modal-title").textContent = profile ? `Edit server — ${profile.label}` : "Add server";
  $("f-label").value = profile ? profile.label : "";
  $("f-ip").value = profile ? profile.bmc_ip : "";
  $("f-user").value = profile ? profile.username : "";
  $("f-pass").value = "";
  $("f-pass").placeholder = profile ? "(unchanged)" : "";
  $("f-pass").required = !profile;
  $("f-verify").checked = profile ? !!profile.verify_tls : false;
  show("test-result", false);
  show("server-modal", true);
  $("f-label").focus();
}

async function saveServer(e) {
  e.preventDefault();
  const body = {
    label: $("f-label").value.trim(),
    bmc_ip: $("f-ip").value.trim(),
    username: $("f-user").value.trim(),
    password: $("f-pass").value,
    verify_tls: $("f-verify").checked,
  };
  const saveBtn = $("modal-save");
  saveBtn.disabled = true;
  try {
    let saved;
    if (state.editingId) {
      saved = await api("PUT", `/api/profiles/${state.editingId}`, body);
      toast(`Server "${saved.label}" updated`, "success");
    } else {
      saved = await api("POST", "/api/profiles", body);
      toast(`Server "${saved.label}" added`, "success");
    }
    show("server-modal", false);
    await loadProfiles();
    selectServer(saved.id);
    probeConnection(saved.id);
  } catch (err) {
    toast(`Save failed: ${err.message}`, "error", 8000);
  } finally {
    saveBtn.disabled = false;
  }
}

async function testFromModal() {
  const el = $("test-result");
  const btn = $("test-btn");
  btn.disabled = true;
  el.className = "text-sm rounded-lg px-3 py-2 bg-zinc-800/80 text-zinc-300";
  el.textContent = "Testing connection…";
  show("test-result", true);
  try {
    let res;
    const password = $("f-pass").value;
    if (state.editingId && !password) {
      // Editing without a new password: test the saved profile server-side.
      res = await api("POST", `/api/profiles/${state.editingId}/test`);
    } else {
      res = await api("POST", "/api/test-connection", {
        label: $("f-label").value.trim() || "test",
        bmc_ip: $("f-ip").value.trim(),
        username: $("f-user").value.trim(),
        password,
        verify_tls: $("f-verify").checked,
      });
    }
    if (res.ok) {
      el.className = "text-sm rounded-lg px-3 py-2 bg-emerald-950/70 text-emerald-300 border border-emerald-900";
      el.textContent = `✓ Connected${res.model ? ` — ${res.model}` : ""}${res.power_state ? ` (host power: ${res.power_state})` : ""}`;
    } else {
      el.className = "text-sm rounded-lg px-3 py-2 bg-red-950/70 text-red-300 border border-red-900";
      el.textContent = `✗ ${res.error || "Connection failed"}`;
    }
  } catch (err) {
    el.className = "text-sm rounded-lg px-3 py-2 bg-red-950/70 text-red-300 border border-red-900";
    el.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function deleteServer() {
  const p = state.profiles.find((x) => x.id === state.selectedId);
  if (!p) return;
  $("confirm-title").textContent = "Delete server?";
  $("confirm-body").innerHTML =
    `Remove server <b>${esc(p.label)}</b> (<span class="font-mono">${esc(p.bmc_ip)}</span>)
     and its stored credentials? This does not touch the server itself.`;
  show("confirm-modal", true);
  $("confirm-ok").onclick = async () => {
    show("confirm-modal", false);
    try {
      await api("DELETE", `/api/profiles/${p.id}`);
      toast(`Server "${p.label}" removed`, "success");
      state.selectedId = null;
      show("main-panel", false);
      show("main-empty", true);
      await loadProfiles();
    } catch (e) {
      toast(`Delete failed: ${e.message}`, "error");
    }
  };
}

async function loadProfiles() {
  try {
    state.profiles = await api("GET", "/api/profiles");
  } catch (e) {
    toast(e.message, "error");
    state.profiles = [];
  }
  renderSidebar();
}

// ------------------------------------------------------------------ init ----
function setAutoRefresh(enabled) {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (enabled) {
    state.autoRefreshTimer = setInterval(() => {
      if (state.selectedId && state.pendingPower.size === 0) {
        loadDrives({ silent: true });
      }
    }, 30000);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  $("add-server-btn").addEventListener("click", () => openServerModal(null));
  $("edit-server-btn").addEventListener("click", () => {
    const p = state.profiles.find((x) => x.id === state.selectedId);
    if (p) openServerModal(p);
  });
  $("delete-server-btn").addEventListener("click", deleteServer);
  $("refresh-btn").addEventListener("click", () => loadDrives());
  $("server-form").addEventListener("submit", saveServer);
  $("modal-cancel").addEventListener("click", () => show("server-modal", false));
  $("test-btn").addEventListener("click", testFromModal);
  $("confirm-cancel").addEventListener("click", () => show("confirm-modal", false));
  $("auto-refresh").addEventListener("change", (e) => setAutoRefresh(e.target.checked));

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = true; }
      renderDrives();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      show("server-modal", false);
      show("confirm-modal", false);
    }
  });

  await loadProfiles();
  state.profiles.forEach((p) => probeConnection(p.id));
});
