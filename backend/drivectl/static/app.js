/* drivectl frontend — test-focused drive power control (plain JS) */
"use strict";

// ---------------------------------------------------------------- state ----
const state = {
  profiles: [],
  selectedId: null,
  drives: [],              // classified drives incl. role/role_reason/meta
  filter: "test",          // test | favorites | on | off | unknown | protected
  search: "",
  sortKey: "name",
  sortAsc: true,
  connStatus: {},          // profile_id -> "ok" | "error" | "unknown"
  editingId: null,
  autoRefreshTimer: null,
  pending: new Map(),      // "storage/drive" -> "on" | "off"
  drawerKey: null,
  protectedOpen: false,
  settings: loadSettings(),
};

const FILTERS = [
  { id: "test", label: "All test drives" },
  { id: "favorites", label: "Favorites" },
  { id: "on", label: "Powered on" },
  { id: "off", label: "Powered off" },
  { id: "unknown", label: "Unknown" },
  { id: "protected", label: "Protected" },
];

const $ = (id) => document.getElementById(id);

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("drivectl.settings") || "{}");
    return { allowUnknown: !!s.allowUnknown, adminOverride: !!s.adminOverride };
  } catch (e) {
    return { allowUnknown: false, adminOverride: false };
  }
}
function saveSettings() {
  localStorage.setItem("drivectl.settings", JSON.stringify(state.settings));
}

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

// Power state derived strictly from Redfish Status.State.
function powerOf(d) {
  const s = (d.state || "").toLowerCase();
  if (s === "enabled") return "on";
  if (["standbyoffline", "disabled", "offline"].includes(s)) return "off";
  return "unknown";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function powerBadge(d) {
  const p = powerOf(d);
  const cfg = {
    on:      { text: "On", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", dot: "bg-emerald-400" },
    off:     { text: "Off", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30", dot: "bg-zinc-500" },
    unknown: { text: `Unknown${d.state ? ` (${d.state})` : ""}`, cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", dot: "bg-amber-400" },
  }[p];
  return `<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.cls}">
    <span class="h-1.5 w-1.5 rounded-full ${cfg.dot}"></span>${esc(cfg.text)}</span>`;
}

function healthBadge(d) {
  const h = (d.health || "").toLowerCase();
  if (!h) return `<span class="text-zinc-600">—</span>`;
  const cls = h === "ok" ? "text-emerald-400" : "text-amber-400";
  return `<span class="${cls}">${esc(d.health)}</span>`;
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

// ----------------------------------------------------------- confirm modal ----
let confirmHandler = null;
function openConfirm({ title, bodyHtml, okLabel = "Confirm", okClass = "bg-red-600 hover:bg-red-500", onOk }) {
  $("confirm-title").textContent = title;
  $("confirm-body").innerHTML = bodyHtml;
  const ok = $("confirm-ok");
  ok.textContent = okLabel;
  ok.className = `rounded-lg px-4 py-2 text-sm font-medium transition text-white ${okClass}`;
  ok.disabled = false;
  $("confirm-cancel").disabled = false;
  confirmHandler = onOk;
  show("confirm-modal", true);
}
function closeConfirm() {
  confirmHandler = null;
  show("confirm-modal", false);
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
    const dotCls = { ok: "bg-emerald-400", error: "bg-red-500", unknown: "bg-zinc-600" }[status];
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
  state.drawerKey = null;
  closeDrawer();
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
    show("protected-section", false);
    $("drive-summary").textContent = "";
  }
  try {
    const drives = await api("GET", `/api/profiles/${profileId}/drives`);
    if (state.selectedId !== profileId) return;
    state.drives = drives;
    state.connStatus[profileId] = "ok";
    renderSidebar();
    renderMain();
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

function label(d) { return (d.meta && d.meta.label) || ""; }

function matchesSearch(d, q) {
  if (!q) return true;
  const hay = [
    d.drive_id, d.storage_id, d.model, d.serial_number, d.name,
    humanBytes(d.capacity_bytes), label(d),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

function visibleDrives() {
  const q = state.search.trim().toLowerCase();
  const isMain = (d) => d.role !== "protected"; // test + unknown live in main table
  let base;
  switch (state.filter) {
    case "favorites": base = state.drives.filter((d) => isMain(d) && d.meta && d.meta.favorite); break;
    case "on":        base = state.drives.filter((d) => isMain(d) && powerOf(d) === "on"); break;
    case "off":       base = state.drives.filter((d) => isMain(d) && powerOf(d) === "off"); break;
    case "unknown":   base = state.drives.filter((d) => isMain(d) && (powerOf(d) === "unknown" || d.role === "unknown")); break;
    case "protected": base = state.drives.filter((d) => d.role === "protected"); break;
    default:          base = state.drives.filter(isMain);
  }
  return base.filter((d) => matchesSearch(d, q));
}

function renderMain() {
  show("drives-loading", false);
  show("drives-error", false);

  const protectedDrives = state.drives.filter((d) => d.role === "protected");
  const testDrives = state.drives.filter((d) => d.role !== "protected");

  $("drive-summary").textContent =
    `${testDrives.length} test drive${testDrives.length === 1 ? "" : "s"} shown · ` +
    `${protectedDrives.length} protected drive${protectedDrives.length === 1 ? "" : "s"} hidden`;

  renderChips();
  renderTable();
  renderProtected(protectedDrives);
}

function renderChips() {
  const wrap = $("filter-chips");
  wrap.innerHTML = "";
  for (const f of FILTERS) {
    const active = state.filter === f.id;
    const btn = document.createElement("button");
    btn.className =
      `rounded-full px-3 py-1 text-xs font-medium border transition ` +
      (active ? "bg-indigo-600/25 border-indigo-500/50 text-indigo-200"
              : "border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800");
    btn.textContent = f.label;
    btn.addEventListener("click", () => { state.filter = f.id; renderMain(); });
    wrap.appendChild(btn);
  }
}

function actionCell(d) {
  const key = driveKey(d);
  if (state.pending.has(key)) {
    const verb = state.pending.get(key) === "on" ? "Powering on…" : "Powering off…";
    return `<span class="inline-flex items-center gap-2 text-xs text-indigo-300">
      <span class="inline-block h-3.5 w-3.5 rounded-full border-2 border-zinc-600 border-t-indigo-400 animate-spin"></span>${verb}</span>`;
  }
  if (d.role === "protected" && !state.settings.adminOverride) {
    return `<span class="text-xs text-zinc-600" title="${esc(d.role_reason || "")}">&#128274; Protected</span>`;
  }
  if (d.role === "unknown" && !state.settings.allowUnknown) {
    return `<span class="text-xs text-zinc-600" title="${esc(d.role_reason || "")}">Action blocked</span>`;
  }
  const p = powerOf(d);
  if (p === "unknown") {
    return `<button disabled class="rounded-lg px-3 py-1.5 text-xs font-medium bg-zinc-800 text-zinc-600 cursor-not-allowed">Refresh required</button>`;
  }
  // One primary action based on current state; verbs avoid state/action ambiguity.
  if (p === "on") {
    return `<button data-act="off" data-key="${esc(driveKey(d))}"
      class="rounded-lg px-3 py-1.5 text-xs font-medium border border-amber-700/70 text-amber-300 hover:bg-amber-950/40 transition">Power off</button>`;
  }
  return `<button data-act="on" data-key="${esc(driveKey(d))}"
    class="rounded-lg px-3 py-1.5 text-xs font-medium border border-emerald-700/70 text-emerald-300 hover:bg-emerald-950/40 transition">Power on</button>`;
}

function driveRowHtml(d, { subdued = false } = {}) {
  const fav = d.meta && d.meta.favorite ? `<span class="text-amber-400" title="Favorite">&#9733;</span> ` : "";
  const roleNote = d.role !== "test"
    ? `<span class="block text-[11px] ${d.role === "protected" ? "text-amber-600/80" : "text-zinc-600"}">${esc(d.role_reason || d.role)}</span>`
    : "";
  return `
    <td class="px-3 py-2.5">
      <div class="font-medium ${subdued ? "text-zinc-400" : ""}">${fav}${esc(d.name || d.drive_id)}</div>
      <div class="text-xs text-zinc-500 font-mono">${esc(d.storage_id)} / ${esc(d.drive_id)}</div>
      ${roleNote}
    </td>
    <td class="px-3 py-2.5 text-zinc-300">${label(d) ? esc(label(d)) : `<span class="text-zinc-600">—</span>`}</td>
    <td class="px-3 py-2.5 text-zinc-300">
      <div>${esc(d.model || "—")}</div>
      <div class="text-xs text-zinc-500 font-mono">${esc(d.serial_number || "no serial")}</div>
    </td>
    <td class="px-3 py-2.5 text-right text-zinc-300 tabular-nums">${humanBytes(d.capacity_bytes)}</td>
    <td class="px-3 py-2.5 text-zinc-300">${esc(d.media_type || "—")}${d.protocol ? ` <span class="text-zinc-500">· ${esc(d.protocol)}</span>` : ""}</td>
    <td class="px-3 py-2.5">${healthBadge(d)}</td>
    <td class="px-3 py-2.5">${powerBadge(d)}</td>
    <td class="px-3 py-2.5 text-right whitespace-nowrap">${actionCell(d)}</td>`;
}

function bindRow(tr, d) {
  tr.className = "hover:bg-zinc-900/50 transition cursor-pointer";
  tr.addEventListener("click", (e) => {
    if (e.target.closest("button")) return; // buttons handle themselves
    openDrawer(d);
  });
  tr.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => requestPower(d, btn.dataset.act));
  });
}

function renderTable() {
  const drives = visibleDrives();
  const empty = $("drives-empty");
  if (drives.length === 0) {
    empty.textContent = state.search
      ? "No drives match the current filter/search."
      : (state.filter === "protected" ? "No protected drives detected."
         : "No test drives found on this server.");
    show("drives-empty", true);
    show("drives-table-wrap", false);
    return;
  }
  show("drives-empty", false);
  show("drives-table-wrap", true);

  const k = state.sortKey;
  drives.sort((a, b) => {
    let va = k === "label" ? label(a) : a[k];
    let vb = k === "label" ? label(b) : b[k];
    if (va == null || va === "") return 1;
    if (vb == null || vb === "") return -1;
    if (typeof va === "string") { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return state.sortAsc ? cmp : -cmp;
  });

  const tbody = $("drives-tbody");
  tbody.innerHTML = "";
  for (const d of drives) {
    const tr = document.createElement("tr");
    tr.innerHTML = driveRowHtml(d, { subdued: d.role === "protected" });
    bindRow(tr, d);
    tbody.appendChild(tr);
  }
}

function renderProtected(protectedDrives) {
  if (state.filter === "protected" || protectedDrives.length === 0) {
    show("protected-section", false);
    return;
  }
  show("protected-section", true);
  $("protected-title").textContent =
    `Protected drives (${protectedDrives.length})`;
  $("protected-chevron").style.transform = state.protectedOpen ? "rotate(90deg)" : "";
  show("protected-body", state.protectedOpen);
  if (!state.protectedOpen) return;

  const tbody = $("protected-tbody");
  tbody.innerHTML = "";
  for (const d of protectedDrives) {
    const tr = document.createElement("tr");
    tr.innerHTML = driveRowHtml(d, { subdued: true });
    bindRow(tr, d);
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------- power actions ----
function driveFactsHtml(d, action) {
  const rows = [
    ["Drive", `${d.name || d.drive_id}${d.location ? ` (${d.location})` : ""}`],
    ["Redfish ID", `${d.storage_id} / ${d.drive_id}`],
    ["Model", d.model || "—"],
    ["Serial number", d.serial_number || "— (none)"],
    ["Capacity", humanBytes(d.capacity_bytes)],
    ["Current power state", { on: "On", off: "Off", unknown: "Unknown" }[powerOf(d)]],
    ["Requested action", action === "on" ? "Power on" : "Power off"],
  ];
  return `<dl class="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">` +
    rows.map(([k, v]) =>
      `<dt class="text-zinc-500">${esc(k)}</dt><dd class="font-mono text-zinc-200">${esc(v)}</dd>`).join("") +
    `</dl>`;
}

function requestPower(drive, action) {
  const server = state.profiles.find((p) => p.id === state.selectedId);
  const warn = action === "off"
    ? `<p class="mt-3 text-amber-300/90 text-xs">The drive will go offline on <b>${esc(server ? server.label : "")}</b>.</p>`
    : "";
  const protWarn = drive.role === "protected"
    ? `<p class="mt-3 text-red-300 text-xs">&#9888; This is a <b>PROTECTED</b> drive (${esc(drive.role_reason || "")}). You are using the admin override.</p>`
    : "";
  openConfirm({
    title: action === "on" ? "Power on drive?" : "Power off drive?",
    bodyHtml: driveFactsHtml(drive, action) + warn + protWarn,
    okLabel: action === "on" ? "Power on" : "Power off",
    okClass: action === "on" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-red-600 hover:bg-red-500",
    onOk: () => { closeConfirm(); doPower(drive, action); },
  });
}

function updateDriveInState(fresh) {
  const i = state.drives.findIndex(
    (d) => d.storage_id === fresh.storage_id && d.drive_id === fresh.drive_id);
  if (i >= 0) {
    // Preserve classification/meta computed at discovery time.
    state.drives[i] = { ...state.drives[i], ...fresh };
  }
}

// Poll a single drive until the expected power state appears or we time out.
async function pollDriveUntil(drive, expectedPower, tries = 5, intervalMs = 2500) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const fresh = await api("GET",
        `/api/profiles/${state.selectedId}/drives/${encodeURIComponent(drive.storage_id)}/${encodeURIComponent(drive.drive_id)}`);
      updateDriveInState(fresh);
      renderMain();
      if (powerOf(fresh) === expectedPower) return true;
    } catch (e) { /* transient poll errors are non-fatal */ }
  }
  return false;
}

async function doPower(drive, action, { quiet = false } = {}) {
  const key = driveKey(drive);
  const name = drive.name || drive.drive_id;
  state.pending.set(key, action);
  renderMain();
  try {
    const res = await api(
      "POST",
      `/api/profiles/${state.selectedId}/drives/${encodeURIComponent(drive.storage_id)}/${encodeURIComponent(drive.drive_id)}/power`,
      {
        action,
        override_protected: drive.role === "protected" && state.settings.adminOverride,
        allow_unknown: drive.role === "unknown" && state.settings.allowUnknown,
      });
    if (res.drive) updateDriveInState(res.drive);

    let confirmed = !!res.confirmed;
    if (!confirmed) {
      // Backend couldn't confirm within its backoff; keep polling briefly.
      confirmed = await pollDriveUntil(drive, action);
    }
    if (confirmed) {
      if (!quiet) toast(`Drive ${name}: powered ${action}`, "success");
      return true;
    }
    toast(`Drive ${name}: power ${action} sent but state is still unconfirmed — refresh to re-check`, "error", 8000);
    return false;
  } catch (e) {
    toast(`Power ${action} failed for ${name}: ${e.message}`, "error", 9000);
    return false;
  } finally {
    state.pending.delete(key);
    renderMain();
  }
}

// ------------------------------------------------------------- bulk restore ----
function powerOnAll() {
  // Strictly test-role drives that are currently off; protected/unknown excluded.
  const targets = state.drives.filter(
    (d) => d.role === "test" && powerOf(d) === "off");
  if (targets.length === 0) {
    toast("No test drives are powered off.", "info");
    return;
  }
  const list = targets.map((d) =>
    `<li class="flex items-center gap-2 py-1" data-bulk="${esc(driveKey(d))}">
       <span class="bulk-status text-zinc-500">&#9675;</span>
       <span class="font-mono text-xs">${esc(d.storage_id)}/${esc(d.drive_id)}</span>
       <span class="truncate">${esc(d.name || "")}</span>
       <span class="text-zinc-500 text-xs ml-auto">${esc(d.serial_number || "")}</span>
     </li>`).join("");
  openConfirm({
    title: `Power on ${targets.length} test drive${targets.length === 1 ? "" : "s"}?`,
    bodyHtml: `<p class="mb-2 text-zinc-400 text-xs">Protected and unknown drives are excluded. Actions run one at a time and are logged.</p>
               <ul class="divide-y divide-zinc-800/60">${list}</ul>`,
    okLabel: "Power on all",
    okClass: "bg-emerald-600 hover:bg-emerald-500",
    onOk: async () => {
      const ok = $("confirm-ok");
      ok.disabled = true;
      $("confirm-cancel").disabled = true;
      confirmHandler = null;
      let succeeded = 0;
      for (const d of targets) {
        const li = document.querySelector(`[data-bulk="${CSS.escape(driveKey(d))}"] .bulk-status`);
        if (li) { li.innerHTML = `<span class="inline-block h-3 w-3 rounded-full border-2 border-zinc-600 border-t-indigo-400 animate-spin"></span>`; }
        const success = await doPower(d, "on", { quiet: true });
        if (li) {
          li.innerHTML = success ? `<span class="text-emerald-400">&#10003;</span>`
                                 : `<span class="text-red-400">&#10007;</span>`;
        }
        if (success) succeeded++;
      }
      ok.textContent = "Close";
      ok.disabled = false;
      $("confirm-cancel").disabled = false;
      confirmHandler = () => closeConfirm();
      toast(`Power on all: ${succeeded}/${targets.length} succeeded`,
            succeeded === targets.length ? "success" : "error");
    },
  });
}

// -------------------------------------------------------------- drawer ----
function openDrawer(drive) {
  state.drawerKey = driveKey(drive);
  renderDrawer(drive);
  show("drawer-backdrop", true);
  show("drawer", true);
}
function closeDrawer() {
  state.drawerKey = null;
  show("drawer-backdrop", false);
  show("drawer", false);
}

function renderDrawer(d) {
  $("drawer-title").textContent = d.name || d.drive_id;
  const meta = d.meta || {};
  const facts = [
    ["Drive ID", d.drive_id],
    ["Redfish URI", d.redfish_uri],
    ["Model", d.model],
    ["Serial", d.serial_number],
    ["Capacity", humanBytes(d.capacity_bytes)],
    ["Media type", d.media_type],
    ["Protocol", d.protocol],
    ["Location", d.location],
    ["Controller", d.controller_name],
    ["Status / health", `${d.state || "—"} / ${d.health || "—"}`],
    ["Power state", { on: "On", off: "Off", unknown: "Unknown" }[powerOf(d)]],
    ["Role", d.role],
    ["Reason", d.role_reason],
  ];
  const rawFields = { ...d.raw };
  const noSerial = !d.serial_number;
  $("drawer-body").innerHTML = `
    <dl class="grid grid-cols-[9rem_1fr] gap-y-1.5 mb-5">
      ${facts.map(([k, v]) =>
        `<dt class="text-zinc-500">${esc(k)}</dt><dd class="font-mono text-xs pt-0.5 break-all text-zinc-200">${esc(v ?? "—")}</dd>`).join("")}
    </dl>

    <h4 class="text-xs uppercase tracking-wider text-zinc-500 mb-2">Local metadata ${noSerial ? "(unavailable — no serial number)" : "(stored by serial)"}</h4>
    <div class="space-y-3 mb-5 ${noSerial ? "opacity-50 pointer-events-none" : ""}">
      <div>
        <label class="block text-xs text-zinc-400 mb-1">Label</label>
        <input id="m-label" value="${esc(meta.label || "")}" placeholder="e.g. fio target, known good, do not touch"
          class="w-full rounded-lg bg-zinc-950 border border-zinc-700 focus:border-indigo-500 focus:outline-none px-3 py-2 text-sm">
      </div>
      <div>
        <label class="block text-xs text-zinc-400 mb-1">Notes</label>
        <textarea id="m-notes" rows="2"
          class="w-full rounded-lg bg-zinc-950 border border-zinc-700 focus:border-indigo-500 focus:outline-none px-3 py-2 text-sm">${esc(meta.notes || "")}</textarea>
      </div>
      <div class="flex items-center gap-4">
        <label class="flex items-center gap-2 text-sm select-none cursor-pointer">
          <input type="checkbox" id="m-fav" ${meta.favorite ? "checked" : ""} class="accent-amber-400">
          Favorite
        </label>
        <label class="flex items-center gap-2 text-sm select-none cursor-pointer ml-auto">
          <span class="text-xs text-zinc-400">Role override</span>
          <select id="m-role" class="rounded-lg bg-zinc-950 border border-zinc-700 px-2 py-1.5 text-sm">
            <option value="" ${!meta.role_override ? "selected" : ""}>auto</option>
            <option value="test" ${meta.role_override === "test" ? "selected" : ""}>test</option>
            <option value="protected" ${meta.role_override === "protected" ? "selected" : ""}>protected</option>
            <option value="unknown" ${meta.role_override === "unknown" ? "selected" : ""}>unknown</option>
          </select>
        </label>
      </div>
      <button id="m-save"
        class="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium transition">Save metadata</button>
    </div>

    <h4 class="text-xs uppercase tracking-wider text-zinc-500 mb-2">Raw Redfish fields</h4>
    <pre class="rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-[11px] leading-relaxed overflow-x-auto text-zinc-400">${esc(JSON.stringify(rawFields, null, 2))}</pre>`;

  if (!noSerial) {
    $("m-save").addEventListener("click", () => saveMeta(d));
  }
}

async function saveMeta(d) {
  const roleVal = $("m-role").value;
  const body = {
    label: $("m-label").value.trim() || null,
    notes: $("m-notes").value.trim() || null,
    favorite: $("m-fav").checked,
  };
  if (roleVal) body.role_override = roleVal;
  else body.clear_role_override = true;
  try {
    await api("PUT", `/api/drive-meta/${encodeURIComponent(d.serial_number)}`, body);
    toast(`Metadata saved for ${d.serial_number}`, "success");
    // Reload so role reclassification (override changes) takes effect.
    await loadDrives({ silent: true });
    renderMain();
    const fresh = state.drives.find((x) => driveKey(x) === driveKey(d));
    if (fresh && state.drawerKey === driveKey(d)) renderDrawer(fresh);
  } catch (e) {
    toast(`Failed to save metadata: ${e.message}`, "error");
  }
}

// -------------------------------------------------------------- history ----
async function openHistory() {
  show("hist-backdrop", true);
  show("hist-drawer", true);
  await renderHistory();
}
function closeHistory() {
  show("hist-backdrop", false);
  show("hist-drawer", false);
}

async function renderHistory() {
  const body = $("hist-body");
  body.innerHTML = `<p class="text-zinc-500 text-xs px-1 py-2">Loading…</p>`;
  let entries;
  try {
    entries = await api("GET", "/api/history?limit=50");
  } catch (e) {
    body.innerHTML = `<p class="text-red-400 text-xs px-1 py-2">${esc(e.message)}</p>`;
    return;
  }
  if (!entries.length) {
    body.innerHTML = `<p class="text-zinc-500 text-xs px-1 py-2">No power actions recorded yet.</p>`;
    return;
  }
  body.innerHTML = entries.map((e) => {
    const resCls = { success: "text-emerald-400", failure: "text-red-400",
                     blocked: "text-amber-400", unconfirmed: "text-amber-400" }[e.result] || "text-zinc-400";
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString() : "—";
    return `
      <div class="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
        <div class="flex items-center gap-2 text-xs">
          <span class="font-medium">${e.action === "on" ? "Power on" : "Power off"}</span>
          <span class="${resCls} font-medium">${esc(e.result || "?")}</span>
          <span class="ml-auto text-zinc-500">${esc(when)}</span>
        </div>
        <div class="text-xs text-zinc-400 mt-1 font-mono">
          ${esc(e.server || "?")} (${esc(e.bmc_ip || "?")}) · ${esc(e.storage_id)}/${esc(e.drive_id)}
        </div>
        <div class="text-xs text-zinc-500 font-mono">
          ${esc(e.model || "")} ${e.serial ? `· SN ${esc(e.serial)}` : ""} ${e.previous_state ? `· was ${esc(e.previous_state)}` : ""}
        </div>
        ${e.error ? `<div class="text-xs text-red-400/90 mt-1">${esc(e.error)}</div>` : ""}
      </div>`;
  }).join("");
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
  openConfirm({
    title: "Delete server?",
    bodyHtml: `Remove server <b>${esc(p.label)}</b> (<span class="font-mono">${esc(p.bmc_ip)}</span>)
      and its stored credentials? This does not touch the server itself.`,
    okLabel: "Delete",
    onOk: async () => {
      closeConfirm();
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
    },
  });
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
      if (state.selectedId && state.pending.size === 0) {
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
  $("power-all-btn").addEventListener("click", powerOnAll);
  $("server-form").addEventListener("submit", saveServer);
  $("modal-cancel").addEventListener("click", () => show("server-modal", false));
  $("test-btn").addEventListener("click", testFromModal);
  $("confirm-cancel").addEventListener("click", closeConfirm);
  $("confirm-ok").addEventListener("click", () => { if (confirmHandler) confirmHandler(); });
  $("auto-refresh").addEventListener("change", (e) => setAutoRefresh(e.target.checked));
  $("search-input").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderTable();
  });

  $("protected-toggle").addEventListener("click", () => {
    state.protectedOpen = !state.protectedOpen;
    renderMain();
  });

  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  $("history-btn").addEventListener("click", openHistory);
  $("hist-close").addEventListener("click", closeHistory);
  $("hist-backdrop").addEventListener("click", closeHistory);
  $("hist-refresh").addEventListener("click", renderHistory);

  $("settings-btn").addEventListener("click", () => {
    $("s-allow-unknown").checked = state.settings.allowUnknown;
    $("s-admin-override").checked = state.settings.adminOverride;
    show("settings-modal", true);
  });
  $("settings-close").addEventListener("click", () => show("settings-modal", false));
  $("s-allow-unknown").addEventListener("change", (e) => {
    state.settings.allowUnknown = e.target.checked;
    saveSettings();
    renderMain();
  });
  $("s-admin-override").addEventListener("change", (e) => {
    state.settings.adminOverride = e.target.checked;
    saveSettings();
    renderMain();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = true; }
      renderTable();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeConfirm();
      closeDrawer();
      closeHistory();
      show("server-modal", false);
      show("settings-modal", false);
    }
  });

  await loadProfiles();
  state.profiles.forEach((p) => probeConnection(p.id));
});
