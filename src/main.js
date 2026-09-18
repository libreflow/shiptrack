const { invoke } = window.__TAURI__.core;
const { save, open } = window.__TAURI__.dialog;
const { openUrl } = window.__TAURI__.opener;
const { writeText } = window.__TAURI__.clipboardManager;
import { normalizeAccents, normalizeAgainstExisting, buildShipmentIndex, normalizeShipmentPayload } from "./normalize.js";
import { monthLabel, isMonthCollapsed, toggleMonthOverride, groupByMonth } from "./months.js";
import { sortShipments, isLate, filterShipments } from "./shipments.js";
import { buildTrackingUrl } from "./tracking.js";

const STATUS_LABELS = {
  ordered: "Commandé",
  shipped: "Expédié",
  received: "Reçu",
  verified: "Vérifié",
};
const STATUS_ORDER = ["shipped", "ordered", "received", "verified"];
// Cycle rapide au clic sur le badge d'une ligne : envoyé -> reçu -> vérifié -> commandé -> ...
const STATUS_CYCLE = { shipped: "received", received: "verified", verified: "ordered", ordered: "shipped" };

const TECH_STORAGE_KEY = "shiptrack.lastTech";
const FILTERS_STORAGE_KEY = "shiptrack.filters";
const COLLAPSED_MONTHS_KEY = "shiptrack.collapsedMonths";
const THEME_STORAGE_KEY = "shiptrack.theme";
const COLUMN_WIDTHS_KEY = "shiptrack.columnWidths";
const KNOWN_TECHS = ["julie", "Amine", "Flo", "Marie", "Robin", "Samuel", "Benoit"];

/* ---------- Thème clair / sombre ---------- */

function applyStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") {
    document.documentElement.dataset.theme = stored;
  } else {
    delete document.documentElement.dataset.theme; // suit prefers-color-scheme
  }
}

function currentEffectiveTheme() {
  const stored = document.documentElement.dataset.theme;
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function toggleTheme() {
  const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_STORAGE_KEY, next);
  updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
  const btn = document.getElementById("btn-theme-toggle");
  if (!btn) return;
  btn.textContent = currentEffectiveTheme() === "dark" ? "☀️" : "🌙";
}

applyStoredTheme(); // appliqué immédiatement, avant le premier rendu

let allShipments = [];
let quickStatus = "shipped";
let selectedTech = localStorage.getItem(TECH_STORAGE_KEY) || "";
let technicianFilterActive = false;
let lastCreated = null;
let searchDebounceTimer = null;
let selectedIds = new Set();
let collapsedOverrides = loadCollapsedMonths();

const PAGE_SIZE = 150;
let visibleCount = PAGE_SIZE;
let sortKey = "expected_date";
let sortDir = "asc"; // "asc" | "desc"

const el = (id) => document.getElementById(id);

/* ---------- Utils ---------- */

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- Persistance des filtres ---------- */

function saveFiltersToStorage() {
  const state = {
    search: el("search").value,
    status: el("filter-status").value,
    late: el("filter-late").checked,
    groupByMonth: el("group-by-month").checked,
    sortKey,
    sortDir,
  };
  localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(state));
}

function restoreFiltersFromStorage() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state.search) el("search").value = state.search;
    if (state.status) el("filter-status").value = state.status;
    if (state.late) el("filter-late").checked = true;
    if (state.groupByMonth) el("group-by-month").checked = true;
    if (state.sortKey) sortKey = state.sortKey;
    if (state.sortDir) sortDir = state.sortDir;
  } catch (err) {
    console.warn("Impossible de restaurer les filtres", err);
  }
}

/* ---------- Regroupement par mois ---------- */

function currentMonthKey() {
  return todayIso().slice(0, 7);
}

function loadCollapsedMonths() {
  try {
    const raw = localStorage.getItem(COLLAPSED_MONTHS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedMonths() {
  localStorage.setItem(COLLAPSED_MONTHS_KEY, JSON.stringify([...collapsedOverrides]));
}

function toggleMonth(key) {
  collapsedOverrides = toggleMonthOverride(key, currentMonthKey(), collapsedOverrides);
  saveCollapsedMonths();
}

let toastTimer = null;
function showToast(message, { error = false, onUndo = null } = {}) {
  const toast = el("toast");
  const undoBtn = el("toast-undo");
  el("toast-message").textContent = message;
  toast.classList.remove("hidden");
  toast.classList.toggle("error", error);

  undoBtn.onclick = null;
  if (onUndo) {
    undoBtn.classList.remove("hidden");
    undoBtn.onclick = () => {
      toast.classList.add("hidden");
      onUndo();
    };
  } else {
    undoBtn.classList.add("hidden");
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), error ? 5000 : onUndo ? 4000 : 2500);
}

async function safeInvoke(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    console.error(cmd, err);
    showToast(`Erreur : ${err}`, { error: true });
    throw err;
  }
}

/* ---------- Chargement des données ---------- */

async function loadShipments() {
  try {
    allShipments = await invoke("list_shipments");
  } catch (err) {
    console.error(err);
    showToast(`Erreur de chargement : ${err}`, { error: true });
    return;
  }
  renderTable();
  updateLateBadge();
  refreshDatalists();
}

async function updateLateBadge() {
  let count = 0;
  try {
    count = await invoke("count_late_shipments");
  } catch (err) {
    console.error(err);
  }
  const badge = el("late-badge");
  if (count > 0) {
    badge.textContent = `${count} en retard`;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function refreshDatalists() {
  const uniq = (key) => [...new Set(allShipments.map((s) => s[key]).filter(Boolean))].sort();

  el("agences-list").innerHTML = uniq("supplier").map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  el("materials-list").innerHTML = uniq("material").map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  el("recipients-list").innerHTML = uniq("recipient").map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
}

/* ---------- Tableau ---------- */

function updateSortHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function hasActiveFilters() {
  return (
    Boolean(el("search").value.trim()) ||
    Boolean(el("filter-status").value) ||
    el("filter-late").checked ||
    technicianFilterActive
  );
}

function updateFilterControls() {
  el("search-clear").classList.toggle("hidden", !el("search").value);
  el("btn-reset-filters").classList.toggle("hidden", !hasActiveFilters());
}

let lastFilteredIds = [];
let focusedRowId = null;
let rowClickTimer = null;
let activeInlineEditCleanup = null;

function renderTable() {
  const search = normalizeAccents(el("search").value.trim());
  const statusFilter = el("filter-status").value;
  const lateOnly = el("filter-late").checked;
  updateFilterControls();

  const filtered = filterShipments(allShipments, {
    statusFilter,
    lateOnly,
    normalizedSearch: search,
    normalizeFn: normalizeAccents,
    technicianFilter: technicianFilterActive ? selectedTech : null,
  });

  const sorted = sortShipments(filtered, sortKey, sortDir);
  updateSortHeaders();
  lastFilteredIds = sorted.map((s) => s.id);

  // Purge les sélections dont la ligne a disparu (suppression, rechargement...).
  const allIds = new Set(allShipments.map((s) => s.id));
  for (const id of selectedIds) {
    if (!allIds.has(id)) selectedIds.delete(id);
  }

  el("row-count").textContent = `${filtered.length} / ${allShipments.length}`;
  renderStatsBar();
  renderBulkBar();
  saveFiltersToStorage();

  const body = el("shipments-body");
  if (sorted.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="empty">Aucune expédition</td></tr>`;
    el("load-more-wrap").classList.add("hidden");
    updateSelectAllCheckbox();
    return;
  }

  const groupByMonth = el("group-by-month").checked;

  if (groupByMonth) {
    renderGroupedBody(sorted);
    el("load-more-wrap").classList.add("hidden");
  } else {
    renderFlatBody(sorted);
  }

  wireRowInteractions();
  updateSelectAllCheckbox();
}

function shipmentRowHtml(s) {
  const late = isLate(s);
  const checked = selectedIds.has(s.id) ? "checked" : "";
  const cell = (field, value) =>
    `<td data-field="${field}" title="${escapeHtml(value || "Double-clic pour modifier")}">${escapeHtml(value ?? "")}</td>`;
  const trackingCell = s.tracking_number
    ? `<td data-field="tracking_number" title="${escapeHtml(s.tracking_number)}"><button type="button" class="tracking-copy-btn" data-copy-id="${s.id}" title="Copier le numéro de suivi">${escapeHtml(s.tracking_number)}</button><button type="button" class="tracking-link-btn" data-track-id="${s.id}" title="Suivre ce colis (17TRACK)">📦</button></td>`
    : cell("tracking_number", s.tracking_number);
  return `
    <tr class="${late ? "row-late" : ""}" data-id="${s.id}">
      <td><input type="checkbox" class="row-checkbox" data-select-id="${s.id}" ${checked} /></td>
      <td><button type="button" class="status-pill status-pill-clickable status-${s.status}" data-cycle-id="${s.id}" title="Cliquer pour changer le statut">${STATUS_LABELS[s.status]}</button></td>
      ${cell("supplier", s.supplier)}
      <td class="material-cell" data-field="material" title="${escapeHtml(s.material)}">${escapeHtml(s.material)}</td>
      ${trackingCell}
      ${cell("carrier", s.carrier)}
      ${cell("recipient", s.recipient)}
      ${cell("expected_date", s.expected_date)}
      ${cell("received_date", s.received_date)}
      <td class="row-edit-hint" title="Cliquer la ligne pour tout modifier">✎</td>
    </tr>`;
}

function renderFlatBody(sorted) {
  const body = el("shipments-body");
  const page = sorted.slice(0, visibleCount);
  body.innerHTML = page.map(shipmentRowHtml).join("");

  const loadMoreWrap = el("load-more-wrap");
  if (sorted.length > page.length) {
    loadMoreWrap.classList.remove("hidden");
    el("btn-load-more").textContent = `Charger plus (${sorted.length - page.length} restantes)`;
  } else {
    loadMoreWrap.classList.add("hidden");
  }
}

// Regroupe par mois de date prévue, dans l'ordre de rencontre du tri courant.
// Les mois passés sont repliés par défaut pour ne pas surcharger l'affichage ;
// le mois en cours, les mois futurs et "sans date" restent ouverts.
function renderGroupedBody(sorted) {
  const body = el("shipments-body");
  const groups = groupByMonth(sorted);
  const curMonth = currentMonthKey();

  const html = [];
  for (const { key, items } of groups) {
    const collapsed = isMonthCollapsed(key, curMonth, collapsedOverrides);
    const lateCount = items.filter((s) => isLate(s)).length;
    html.push(`
      <tr class="month-header-row" data-month-key="${key}">
        <td colspan="10">
          <button type="button" class="month-toggle" data-month-toggle="${key}">
            <span class="month-chevron ${collapsed ? "collapsed" : ""}">▾</span>
            <span class="month-name">${monthLabel(key)}</span>
            <span class="month-count">${items.length}</span>
            ${lateCount > 0 ? `<span class="month-late-count">${lateCount} en retard</span>` : ""}
          </button>
        </td>
      </tr>`);
    if (!collapsed) {
      html.push(items.map(shipmentRowHtml).join(""));
    }
  }
  body.innerHTML = html.join("");

  body.querySelectorAll("[data-month-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleMonth(btn.dataset.monthToggle);
      renderTable();
    });
  });
}

/* ---------- Ouverture d'un lien de suivi externe (17TRACK, aucune requête réseau depuis l'app) ---------- */

async function openTrackingLink(id) {
  const s = allShipments.find((x) => x.id === id);
  if (!s) return;
  const url = buildTrackingUrl(s.tracking_number);
  if (!url) return;
  try {
    await openUrl(url);
  } catch (err) {
    console.error("openTrackingLink", err);
    showToast("Impossible d'ouvrir le lien de suivi", { error: true });
  }
}

/* ---------- Copie du numéro de suivi dans le presse-papier ---------- */

async function copyTrackingNumber(id) {
  const s = allShipments.find((x) => x.id === id);
  if (!s || !s.tracking_number) return;
  try {
    await writeText(s.tracking_number);
    showToast(`N° de suivi copié : ${s.tracking_number}`);
  } catch (err) {
    console.error("copyTrackingNumber", err);
    showToast("Impossible de copier le numéro de suivi", { error: true });
  }
}

function wireRowInteractions() {
  const body = el("shipments-body");

  body.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-cycle-id]")) return; // géré séparément
      if (e.target.closest("[data-select-id]")) return; // géré séparément
      if (e.target.closest("[data-track-id]")) return; // géré séparément
      if (e.target.closest("[data-copy-id]")) return; // géré séparément
      if (e.detail > 1) return; // laisse dblclick gérer l'édition inline sur les cellules éditables
      focusedRowId = tr.dataset.id;
      updateRowFocusHighlight();
      // Simple clic hors cellule éditable : ouvre le dialog complet, avec un
      // léger délai pour laisser le temps à un éventuel 2e clic d'annuler
      // l'ouverture si la cellule ciblée est éditable inline.
      const field = e.target.closest("[data-field]");
      if (field) return; // dblclick prend le relais sur ces cellules
      clearTimeout(rowClickTimer);
      rowClickTimer = setTimeout(() => openEditDialog(tr.dataset.id), 180);
    });

    tr.querySelectorAll("[data-field]").forEach((cell) => {
      cell.addEventListener("dblclick", (e) => {
        if (e.target.closest("[data-track-id]")) return; // le bouton de suivi gère son propre clic
        if (e.target.closest("[data-copy-id]")) return; // le bouton copier gère son propre clic
        e.stopPropagation();
        clearTimeout(rowClickTimer);
        startInlineEdit(cell, tr.dataset.id);
      });
    });
  });

  body.querySelectorAll("[data-copy-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyTrackingNumber(btn.dataset.copyId);
    });
    btn.addEventListener("dblclick", (e) => e.stopPropagation());
  });

  body.querySelectorAll("[data-track-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTrackingLink(btn.dataset.trackId);
    });
    btn.addEventListener("dblclick", (e) => e.stopPropagation());
  });

  body.querySelectorAll("[data-cycle-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleStatus(btn.dataset.cycleId);
    });
  });

  body.querySelectorAll("[data-select-id]").forEach((cb) => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      const id = cb.dataset.selectId;
      if (cb.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      renderBulkBar();
      updateSelectAllCheckbox();
    });
  });

  updateRowFocusHighlight();
}

function updateRowFocusHighlight() {
  const body = el("shipments-body");
  body.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.classList.toggle("row-focused", tr.dataset.id === focusedRowId);
  });
}

/* ---------- Édition inline (double-clic sur une cellule) ---------- */

const INLINE_TEXT_FIELDS = new Set(["supplier", "material", "tracking_number", "recipient"]);
const INLINE_DATE_FIELDS = new Set(["expected_date", "received_date"]);
const INLINE_REQUIRED_FIELDS = { supplier: "Agence", material: "Matériel" };

function buildUpdatePayload(s, overrides) {
  return {
    id: s.id,
    supplier: s.supplier,
    tracking_number: s.tracking_number,
    carrier: s.carrier,
    recipient: s.recipient,
    material: s.material,
    status: s.status,
    expected_date: s.expected_date,
    received_date: s.received_date,
    notes: s.notes,
    ...overrides,
  };
}

function startInlineEdit(cell, id) {
  if (activeInlineEditCleanup) activeInlineEditCleanup();

  const s = allShipments.find((x) => x.id === id);
  if (!s) return;
  const field = cell.dataset.field;
  const originalHtml = cell.innerHTML;
  const originalValue = s[field] ?? "";

  let input;
  if (field === "carrier") {
    input = document.createElement("select");
    input.innerHTML = `<option value="">—</option><option value="TNT">TNT</option><option value="DPD">DPD</option>`;
    // Valeur historique hors TNT/DPD (donnée héritée) : ajoute une option dédiée
    // pour ne pas la faire disparaître silencieusement au premier Entrée.
    if (originalValue && !["", "TNT", "DPD"].includes(originalValue)) {
      const legacyOption = document.createElement("option");
      legacyOption.value = originalValue;
      legacyOption.textContent = `${originalValue} (valeur existante)`;
      input.appendChild(legacyOption);
    }
    input.value = originalValue;
  } else {
    input = document.createElement("input");
    input.type = INLINE_DATE_FIELDS.has(field) ? "date" : "text";
    input.value = originalValue;
  }
  input.className = "inline-edit-input";

  cell.innerHTML = "";
  cell.appendChild(input);
  input.focus();
  if (input.select) input.select();

  let settled = false;
  const cleanup = () => {
    activeInlineEditCleanup = null;
  };

  const cancel = () => {
    if (settled) return;
    settled = true;
    cell.innerHTML = originalHtml;
    cleanup();
  };

  const commit = async () => {
    if (settled) return;
    settled = true;

    let nextValue = input.value.trim() || null;
    if (INLINE_TEXT_FIELDS.has(field) && nextValue) {
      const index = buildShipmentIndex(allShipments);
      nextValue = normalizeAgainstExisting(nextValue, index[field] ?? [], {
        titleCase: field === "supplier",
      });
    }

    if (!nextValue && INLINE_REQUIRED_FIELDS[field]) {
      settled = false; // laisse l'utilisateur corriger sans perdre sa saisie
      showToast(`Le champ "${INLINE_REQUIRED_FIELDS[field]}" est requis`, { error: true });
      input.focus();
      return;
    }

    if (nextValue === (originalValue || null)) {
      cell.innerHTML = originalHtml;
      cleanup();
      return;
    }

    try {
      await safeInvoke("update_shipment", { shipment: buildUpdatePayload(s, { [field]: nextValue }) });
    } catch {
      cell.innerHTML = originalHtml;
      cleanup();
      return;
    }
    cleanup();
    focusedRowId = id;
    await loadShipments();
    showToast("Modification enregistrée");
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", () => commit());

  activeInlineEditCleanup = cancel;
}

/* ---------- Navigation clavier entre lignes ---------- */

function isTypingInFormField() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

function setupRowKeyboardNavigation() {
  document.addEventListener("keydown", (e) => {
    if (el("shipment-dialog").open || el("import-dialog").open) return;
    if (isTypingInFormField()) return;
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;

    const rows = [...document.querySelectorAll("#shipments-body tr[data-id]")];
    if (rows.length === 0) return;

    if (e.key === "Enter" && focusedRowId) {
      e.preventDefault();
      openEditDialog(focusedRowId);
      return;
    }

    e.preventDefault();
    const currentIndex = rows.findIndex((tr) => tr.dataset.id === focusedRowId);
    let nextIndex;
    if (currentIndex === -1) {
      nextIndex = 0;
    } else if (e.key === "ArrowDown") {
      nextIndex = Math.min(currentIndex + 1, rows.length - 1);
    } else {
      nextIndex = Math.max(currentIndex - 1, 0);
    }
    focusedRowId = rows[nextIndex].dataset.id;
    updateRowFocusHighlight();
    rows[nextIndex].scrollIntoView?.({ block: "nearest" });
  });
}

/* ---------- Sélection multiple / actions groupées ---------- */

function renderBulkBar() {
  const bar = el("bulk-bar");
  const count = selectedIds.size;
  if (count === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  el("bulk-count").textContent = count === 1 ? "1 sélectionnée" : `${count} sélectionnées`;
}

function updateSelectAllCheckbox() {
  const cb = el("select-all-checkbox");
  if (lastFilteredIds.length === 0) {
    cb.checked = false;
    cb.indeterminate = false;
    return;
  }
  const selectedCount = lastFilteredIds.filter((id) => selectedIds.has(id)).length;
  cb.checked = selectedCount === lastFilteredIds.length;
  cb.indeterminate = selectedCount > 0 && selectedCount < lastFilteredIds.length;
}

function clearSelection() {
  selectedIds.clear();
  renderTable();
}

async function bulkSetStatus(status) {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  if (!confirm(`Passer ${ids.length} expédition(s) au statut "${STATUS_LABELS[status]}" ?`)) return;

  const receivedDate = status === "received" || status === "verified" ? todayIso() : null;

  let failCount = 0;
  for (const id of ids) {
    const s = allShipments.find((x) => x.id === id);
    if (!s) continue;
    try {
      await invoke("update_shipment", {
        shipment: {
          id: s.id,
          supplier: s.supplier,
          tracking_number: s.tracking_number,
          carrier: s.carrier,
          recipient: s.recipient,
          material: s.material,
          status,
          expected_date: s.expected_date,
          received_date: receivedDate ?? (status === s.status ? s.received_date : null),
          notes: s.notes,
        },
      });
    } catch (err) {
      console.error("bulkSetStatus", id, err);
      failCount++;
    }
  }

  showToast(
    failCount > 0
      ? `${ids.length - failCount} mise(s) à jour, ${failCount} échec(s)`
      : `${ids.length} expédition(s) mise(s) à jour`,
    { error: failCount > 0 }
  );
  selectedIds.clear();
  await loadShipments();
}

async function bulkDelete() {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  if (!confirm(`Supprimer définitivement ${ids.length} expédition(s) ? Cette action est irréversible.`)) return;

  let failCount = 0;
  for (const id of ids) {
    try {
      await invoke("delete_shipment", { id });
    } catch (err) {
      console.error("bulkDelete", id, err);
      failCount++;
    }
  }

  showToast(
    failCount > 0
      ? `${ids.length - failCount} supprimée(s), ${failCount} échec(s)`
      : `${ids.length} expédition(s) supprimée(s)`,
    { error: failCount > 0 }
  );
  selectedIds.clear();
  await loadShipments();
}

/* ---------- Barre de compteurs par statut ---------- */

function renderStatsBar() {
  const container = el("stats-bar");
  const activeStatus = el("filter-status").value;

  container.innerHTML = STATUS_ORDER.map((status) => {
    const count = allShipments.filter((s) => s.status === status).length;
    const active = status === activeStatus;
    return `<button type="button" class="stat-chip ${active ? "active" : ""}" data-stat-status="${status}">
      <span class="stat-dot stat-dot-${status}"></span>
      <span class="stat-count">${count}</span>
      <span>${STATUS_LABELS[status]}</span>
    </button>`;
  }).join("");

  container.querySelectorAll("[data-stat-status]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const status = chip.dataset.statStatus;
      el("filter-status").value = el("filter-status").value === status ? "" : status;
      visibleCount = PAGE_SIZE;
      renderTable();
    });
  });
}

async function cycleStatus(id) {
  const s = allShipments.find((x) => x.id === id);
  if (!s) return;
  const previousStatus = s.status;
  const previousReceived = s.received_date;
  const nextStatus = STATUS_CYCLE[s.status] ?? "shipped";
  const receivedDate =
    nextStatus === "received" || nextStatus === "verified" ? s.received_date || todayIso() : null;

  const applyStatus = async (status, receivedDateValue) => {
    await safeInvoke("update_shipment", {
      shipment: {
        id: s.id,
        supplier: s.supplier,
        tracking_number: s.tracking_number,
        carrier: s.carrier,
        recipient: s.recipient,
        material: s.material,
        status,
        expected_date: s.expected_date,
        received_date: receivedDateValue,
        notes: s.notes,
      },
    });
    await loadShipments();
  };

  await applyStatus(nextStatus, receivedDate);
  showToast(`Statut → ${STATUS_LABELS[nextStatus]}`, {
    onUndo: () => applyStatus(previousStatus, previousReceived),
  });
}

/* ---------- Barre technicien ---------- */

function renderTechButtons() {
  const container = el("tech-buttons");
  container.innerHTML = KNOWN_TECHS.map(
    (t) =>
      `<button type="button" class="tech-btn ${t === selectedTech ? "active" : ""} ${t === selectedTech && technicianFilterActive ? "filter-active" : ""}" data-tech="${escapeHtml(t)}" title="Clic : sélectionner pour la saisie et filtrer le tableau">${escapeHtml(t)}</button>`
  ).join("");

  container.querySelectorAll(".tech-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tech = btn.dataset.tech;
      if (tech === selectedTech && technicianFilterActive) {
        // Reclic sur le technicien déjà actif : désactive le filtre (garde la présélection saisie).
        technicianFilterActive = false;
      } else {
        selectedTech = tech;
        technicianFilterActive = true;
        localStorage.setItem(TECH_STORAGE_KEY, selectedTech);
        el("tech-custom").value = "";
      }
      renderTechButtons();
      visibleCount = PAGE_SIZE;
      renderTable();
    });
  });
}

function currentTechnician() {
  const custom = el("tech-custom").value.trim();
  return custom || selectedTech || null;
}

/* ---------- Pills de statut (ligne rapide) ---------- */

function renderQuickStatusPills() {
  const container = el("quick-status-pills");
  container.innerHTML = STATUS_ORDER.map(
    (s) =>
      `<button type="button" class="status-pill-btn status-${s} ${s === quickStatus ? "active" : ""}" data-status="${s}">${STATUS_LABELS[s]}</button>`
  ).join("");

  container.querySelectorAll(".status-pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      quickStatus = btn.dataset.status;
      renderQuickStatusPills();
    });
  });
}

/* ---------- Ligne de saisie rapide ---------- */

const QUICK_FIELDS = ["q-supplier", "q-material", "q-tracking", "q-carrier", "q-recipient", "q-expected"];

function resetQuickRow() {
  QUICK_FIELDS.forEach((id) => (el(id).value = ""));
  el("q-expected").value = todayIso();
  el("q-duplicate-warning").classList.add("hidden");
}

function checkDuplicateTracking() {
  const value = el("q-tracking").value.trim();
  const warning = el("q-duplicate-warning");
  if (!value) {
    warning.classList.add("hidden");
    return;
  }
  const exists = allShipments.some((s) => s.tracking_number && s.tracking_number.trim() === value);
  warning.classList.toggle("hidden", !exists);
}

async function submitQuickRow() {
  const index = buildShipmentIndex(allShipments);
  const { values, errors } = normalizeShipmentPayload(
    {
      supplier: el("q-supplier").value,
      material: el("q-material").value,
      carrier: el("q-carrier").value,
      recipient: el("q-recipient").value,
    },
    index
  );

  if (errors.length > 0) {
    if (!values.supplier) el("q-supplier").focus();
    else el("q-material").focus();
    showToast(`Champ(s) requis manquant(s) : ${errors.join(", ")}`, { error: true });
    return;
  }

  const tech = currentTechnician();
  const payload = {
    ...values,
    tracking_number: el("q-tracking").value.trim() || null,
    expected_date: el("q-expected").value || null,
    notes: tech ? `Traité par: ${tech}` : null,
  };

  let created;
  try {
    created = await safeInvoke("create_shipment", { shipment: payload });

    if (quickStatus !== "ordered") {
      await safeInvoke("update_shipment", {
        shipment: {
          id: created.id,
          supplier: created.supplier,
          tracking_number: created.tracking_number,
          carrier: created.carrier,
          recipient: created.recipient,
          material: created.material,
          status: quickStatus,
          expected_date: created.expected_date,
          received_date:
            quickStatus === "received" || quickStatus === "verified" ? todayIso() : null,
          notes: created.notes,
        },
      });
    }
  } catch {
    return; // erreur déjà affichée par safeInvoke
  }

  lastCreated = { ...payload, status: quickStatus };
  resetQuickRow();
  await loadShipments();
  showToast("Expédition ajoutée");
  el("q-supplier").focus();
}

function duplicateLastRow() {
  if (!lastCreated) {
    showToast("Aucune ligne précédente à dupliquer", { error: true });
    return;
  }
  el("q-supplier").value = lastCreated.supplier ?? "";
  el("q-material").value = lastCreated.material ?? "";
  el("q-tracking").value = "";
  el("q-carrier").value = lastCreated.carrier ?? "";
  el("q-recipient").value = lastCreated.recipient ?? "";
  el("q-expected").value = todayIso();
  quickStatus = lastCreated.status ?? "shipped";
  renderQuickStatusPills();
  el("q-supplier").focus();
}

function setupQuickRowKeyboard() {
  const row = el("quick-add-row");

  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitQuickRow();
    } else if (e.key === "Escape") {
      e.preventDefault();
      resetQuickRow();
      el("q-supplier").focus();
    }
  });

  document.addEventListener("keydown", (e) => {
    // Ne pas intercepter Ctrl+N/D si l'utilisateur tape dans le dialog d'édition
    if (el("shipment-dialog").open) return;

    // Ctrl+N : focus la ligne de saisie rapide depuis n'importe où
    if (e.ctrlKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      el("q-supplier").focus();
    }
    // Ctrl+D : dupliquer la dernière ligne créée
    if (e.ctrlKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateLastRow();
    }
  });

  el("q-submit").addEventListener("click", submitQuickRow);
}

/* ---------- Colonnes redimensionnables ---------- */

const MIN_COLUMN_WIDTH = 50;

function loadColumnWidths() {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveColumnWidths(widths) {
  localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths));
}

function applyColumnWidths() {
  const widths = loadColumnWidths();
  for (const [col, width] of Object.entries(widths)) {
    const colEl = document.querySelector(`#shipments-table col[data-col="${col}"]`);
    if (colEl) colEl.style.width = `${width}px`;
  }
}

function setupColumnResizing() {
  const table = el("shipments-table");
  let dragState = null;

  table.querySelectorAll(".col-resize-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = handle.closest("th");
      const colKey = th.dataset.col;
      const colEl = document.querySelector(`#shipments-table col[data-col="${colKey}"]`);
      if (!colEl) return;

      dragState = {
        colKey,
        colEl,
        startX: e.clientX,
        startWidth: th.getBoundingClientRect().width,
      };
      handle.classList.add("resizing");
      table.classList.add("col-resizing");
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragState) return;
      const delta = e.clientX - dragState.startX;
      const newWidth = Math.max(MIN_COLUMN_WIDTH, Math.round(dragState.startWidth + delta));
      dragState.colEl.style.width = `${newWidth}px`;
    });

    const endDrag = (e) => {
      if (!dragState) return;
      const widths = loadColumnWidths();
      widths[dragState.colKey] = parseInt(dragState.colEl.style.width, 10);
      saveColumnWidths(widths);
      handle.classList.remove("resizing");
      table.classList.remove("col-resizing");
      dragState = null;
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);

    // Empêche le déclenchement du tri au clic quand on relâche sur la poignée.
    handle.addEventListener("click", (e) => e.stopPropagation());
  });
}

/* ---------- Dialog d'édition / suppression ---------- */

function updateTrackingLinkButton() {
  const btn = el("f-tracking-link");
  const url = buildTrackingUrl(el("f-tracking").value);
  btn.classList.toggle("hidden", !url);
}

function openEditDialog(id) {
  const s = allShipments.find((x) => x.id === id);
  if (!s) return;
  el("dialog-title").textContent = "Modifier l'expédition";
  el("f-id").value = s.id;
  el("f-supplier").value = s.supplier;
  el("f-material").value = s.material;
  el("f-tracking").value = s.tracking_number ?? "";
  el("f-carrier").value = s.carrier ?? "";
  el("f-recipient").value = s.recipient ?? "";
  el("f-status").value = s.status;
  el("f-expected").value = s.expected_date ?? "";
  el("f-received").value = s.received_date ?? "";
  el("f-notes").value = s.notes ?? "";
  el("btn-delete").classList.remove("hidden");
  updateTrackingLinkButton();
  el("shipment-dialog").showModal();
}

async function saveShipment(e) {
  e.preventDefault();
  const id = el("f-id").value;
  if (!id) return;

  const index = buildShipmentIndex(allShipments);
  const { values, errors } = normalizeShipmentPayload(
    {
      supplier: el("f-supplier").value,
      material: el("f-material").value,
      carrier: el("f-carrier").value,
      recipient: el("f-recipient").value,
    },
    index
  );

  if (errors.length > 0) {
    showToast(`Champ(s) requis manquant(s) : ${errors.join(", ")}`, { error: true });
    return;
  }

  try {
    await safeInvoke("update_shipment", {
      shipment: {
        id,
        ...values,
        tracking_number: el("f-tracking").value.trim() || null,
        status: el("f-status").value,
        expected_date: el("f-expected").value || null,
        received_date: el("f-received").value || null,
        notes: el("f-notes").value.trim() || null,
      },
    });
  } catch {
    return;
  }

  el("shipment-dialog").close();
  showToast("Modifications enregistrées");
  await loadShipments();
}

async function deleteShipment() {
  const id = el("f-id").value;
  if (!id) return;
  if (!confirm("Supprimer cette expédition ?")) return;
  try {
    await safeInvoke("delete_shipment", { id });
  } catch {
    return;
  }
  el("shipment-dialog").close();
  showToast("Expédition supprimée");
  await loadShipments();
}

async function exportXlsx(shipmentIds = null) {
  const path = await save({
    defaultPath: "shiptrack-export.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!path) return;
  try {
    await safeInvoke("export_shipments_xlsx", { filePath: path, shipmentIds });
  } catch {
    return;
  }
  showToast("Export terminé : " + path);
}

/* ---------- Import Excel ---------- */

let pendingImportPath = null;

async function startImport() {
  const path = await open({
    multiple: false,
    filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
  });
  if (!path) return;

  let sheets;
  try {
    sheets = await safeInvoke("list_excel_sheets", { filePath: path });
  } catch {
    return;
  }

  if (!sheets || sheets.length === 0) {
    showToast("Aucune feuille trouvée dans ce fichier", { error: true });
    return;
  }

  pendingImportPath = path;
  const select = el("import-sheet-select");
  select.innerHTML = sheets.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  el("import-dialog").showModal();
}

async function confirmImport(e) {
  e.preventDefault();
  const sheetName = el("import-sheet-select").value;
  if (!pendingImportPath || !sheetName) return;

  el("btn-import-confirm").disabled = true;
  try {
    const result = await safeInvoke("import_excel_sheet", {
      filePath: pendingImportPath,
      sheetName,
    });
    el("import-dialog").close();
    showToast(
      result.skipped > 0
        ? `${result.inserted} expédition(s) importée(s), ${result.skipped} ligne(s) vide(s) ignorée(s)`
        : `${result.inserted} expédition(s) importée(s)`
    );
    await loadShipments();
  } catch {
    // erreur déjà affichée par safeInvoke
  } finally {
    el("btn-import-confirm").disabled = false;
    pendingImportPath = null;
  }
}

/* ---------- Init ---------- */

window.addEventListener("DOMContentLoaded", () => {
  restoreFiltersFromStorage();
  updateThemeToggleIcon();
  el("btn-theme-toggle").addEventListener("click", toggleTheme);

  renderTechButtons();
  renderQuickStatusPills();
  setupQuickRowKeyboard();
  setupRowKeyboardNavigation();
  applyColumnWidths();
  setupColumnResizing();
  el("q-expected").value = todayIso();

  el("btn-cancel").addEventListener("click", () => el("shipment-dialog").close());
  el("btn-delete").addEventListener("click", deleteShipment);
  el("shipment-form").addEventListener("submit", saveShipment);

  // Menu export : tout / vue filtrée
  el("btn-export").addEventListener("click", (e) => {
    e.stopPropagation();
    el("export-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", () => el("export-menu").classList.add("hidden"));
  el("export-all").addEventListener("click", () => {
    el("export-menu").classList.add("hidden");
    exportXlsx(null);
  });
  el("export-filtered").addEventListener("click", () => {
    el("export-menu").classList.add("hidden");
    exportXlsx(lastFilteredIds);
  });

  el("q-tracking").addEventListener("input", checkDuplicateTracking);
  el("f-tracking").addEventListener("input", updateTrackingLinkButton);
  el("f-tracking-link").addEventListener("click", () => {
    const url = buildTrackingUrl(el("f-tracking").value);
    if (url) {
      openUrl(url).catch((err) => {
        console.error("openTrackingLink (dialog)", err);
        showToast("Impossible d'ouvrir le lien de suivi", { error: true });
      });
    }
  });

  el("search").addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      visibleCount = PAGE_SIZE;
      renderTable();
    }, 150);
  });
  el("search-clear").addEventListener("click", () => {
    el("search").value = "";
    visibleCount = PAGE_SIZE;
    renderTable();
    el("search").focus();
  });
  el("filter-status").addEventListener("change", () => {
    visibleCount = PAGE_SIZE;
    renderTable();
  });
  el("filter-late").addEventListener("change", () => {
    visibleCount = PAGE_SIZE;
    renderTable();
  });
  el("group-by-month").addEventListener("change", () => {
    renderTable();
  });
  el("btn-reset-filters").addEventListener("click", () => {
    el("search").value = "";
    el("filter-status").value = "";
    el("filter-late").checked = false;
    technicianFilterActive = false;
    renderTechButtons();
    visibleCount = PAGE_SIZE;
    renderTable();
  });

  el("btn-load-more").addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    renderTable();
  });

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = "asc";
      }
      visibleCount = PAGE_SIZE;
      renderTable();
    });
  });

  el("select-all-checkbox").addEventListener("change", (e) => {
    if (e.target.checked) {
      lastFilteredIds.forEach((id) => selectedIds.add(id));
    } else {
      lastFilteredIds.forEach((id) => selectedIds.delete(id));
    }
    renderTable();
  });

  el("bulk-clear").addEventListener("click", clearSelection);
  el("bulk-delete").addEventListener("click", bulkDelete);
  el("bulk-export").addEventListener("click", () => {
    if (selectedIds.size === 0) return;
    exportXlsx([...selectedIds]);
  });
  document.querySelectorAll("[data-bulk-status]").forEach((btn) => {
    btn.addEventListener("click", () => bulkSetStatus(btn.dataset.bulkStatus));
  });

  el("btn-import").addEventListener("click", startImport);
  el("btn-import-cancel").addEventListener("click", () => {
    el("import-dialog").close();
    pendingImportPath = null;
  });
  el("import-form").addEventListener("submit", confirmImport);

  loadShipments();
  el("q-supplier").focus();
});
