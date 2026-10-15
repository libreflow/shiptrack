const { invoke } = window.__TAURI__.core;
const { save, open } = window.__TAURI__.dialog;
const { openUrl } = window.__TAURI__.opener;
const { writeText } = window.__TAURI__.clipboardManager;
import { normalizeAccents, normalizeAgainstExisting, buildShipmentIndex, normalizeShipmentPayload, findSimilarValue } from "./normalize.js";
import { monthLabel, isMonthCollapsed, toggleMonthOverride, groupByMonth, formatDateFr } from "./months.js";
import { sortShipments, filterShipments } from "./shipments.js";
import { buildTrackingUrl, isValidTrackingValue, inferCarrier, isNumericTrackingValue } from "./tracking.js";
import { DEFAULT_MATERIAL_PLACEHOLDER, batchResultsToRows, includedRows, rowToNewShipmentPayload, summarizeRows } from "./pdf_batch.js";

const STATUS_LABELS = {
  ordered: "Commandé",
  shipped: "Expédié",
  received: "Reçu",
};
const STATUS_ORDER = ["shipped", "ordered", "received"];
// Cycle rapide au clic sur le badge d'une ligne : envoyé -> reçu -> commandé -> ...
const STATUS_CYCLE = { shipped: "received", received: "ordered", ordered: "shipped" };

// Option de bon de transport TNT : avec/sans ramassage occasionnel — voir
// demande utilisateur du 2026-09-23. PICKUP_LABELS_SHORT pour le badge du
// tableau (espace limité), PICKUP_LABELS_FULL pour le dialog d'édition et
// l'export Excel (texte complet demandé explicitement).
const PICKUP_LABELS_SHORT = { with_pickup: "Avec ramassage", without_pickup: "Sans ramassage" };
const PICKUP_LABELS_FULL = {
  with_pickup: "Avec ramassage occasionnel",
  without_pickup: "Sans ramassage occasionnel",
};
const PICKUP_ORDER = ["with_pickup", "without_pickup"];

// Techniciens dynamiques : extraits des notes existantes (« Traité par: X »)
// plutôt qu'une liste codée en dur — un nouvel arrivant apparaît dès sa
// première saisie via « Autre… », sans modifier le code. (Voir
// rowToNewShipmentPayload dans pdf_batch.js et submitQuickRow pour le
// format des notes.)
function knownTechs() {
  const names = new Set();
  for (const s of allShipments) {
    if (!s.notes) continue;
    const match = s.notes.match(/^Trait\u00e9 par:\s*(.+)$/i);
    if (match) {
      const name = match[1].trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, "fr"));
}
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
let selectedTech = localStorage.getItem(TECH_STORAGE_KEY) || "";
// Décision produit explicite : contrairement aux autres filtres (recherche,
// statut, retard — voir FILTERS_STORAGE_KEY), le filtre technicien n'est
// JAMAIS persisté entre sessions. L'app repart toujours sur "Tous" au
// démarrage, pour ne jamais masquer silencieusement des expéditions à la
// réouverture. selectedTech (le nom présélectionné pour la SAISIE rapide,
// différent du filtre d'affichage) reste, lui, mémorisé — voir TECH_STORAGE_KEY.
let technicianFilterActive = false;
// Filtre statut : fusionné avec la barre de compteurs (stats-bar) — un seul
// jeu de puces cliquables sert à la fois d'indicateur ET de filtre, plutôt
// que deux contrôles séparés (ancien <select> d'icônes + stats-bar) qui
// faisaient doublon visuellement pour le même concept.
let statusFilter = "";
// Filtre Ramassage (option de bon TNT avec/sans ramassage occasionnel) —
// AXE INDÉPENDANT du statut (voir filterShipments dans shipments.js) : sa
// propre barre de puces, pas fusionné avec stats-bar, pour rester
// combinable avec n'importe quel statut plutôt que de forcer un choix entre
// les deux dimensions.
let pickupFilter = "";
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

// Version du schéma localStorage : chaque payload persisté embarque sa version
// (`v`) ; une version inconnue (app downgradée ou format changé sans bump)
// est ignorée silencieusement plutôt que d'injecter un état corrompu dans l'UI.
const STORAGE_SCHEMA_VERSION = 1;
function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== STORAGE_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeStoredJson(key, value) {
  localStorage.setItem(key, JSON.stringify({ v: STORAGE_SCHEMA_VERSION, ...value }));
}

function saveFiltersToStorage() {
  const state = getActiveFilterState();
  writeStoredJson(
    FILTERS_STORAGE_KEY,
    JSON.stringify({
      search: el("search").value,
      status: state.status,
      pickup: state.pickup,
      groupByMonth: state.groupByMonth,
      sortKey,
      sortDir,
    })
  );
}

function restoreFiltersFromStorage() {
  const state = readStoredJson(FILTERS_STORAGE_KEY);
  if (!state) return;
  if (state.search) el("search").value = state.search;
  if (state.status) statusFilter = state.status;
  if (state.pickup) pickupFilter = state.pickup;
  if (state.groupByMonth) el("group-by-month").checked = true;
  if (state.sortKey) sortKey = state.sortKey;
  if (state.sortDir) sortDir = state.sortDir;
}


/* ---------- Regroupement par mois ---------- */

function currentMonthKey() {
  return todayIso().slice(0, 7);
}

function loadCollapsedMonths() {
  const state = readStoredJson(COLLAPSED_MONTHS_KEY);
  return state && Array.isArray(state.months) ? new Set(state.months) : new Set();
}

function saveCollapsedMonths() {
  writeStoredJson(COLLAPSED_MONTHS_KEY, { months: [...collapsedOverrides] });
}

function toggleMonth(key) {
  collapsedOverrides = toggleMonthOverride(key, currentMonthKey(), collapsedOverrides);
  saveCollapsedMonths();
}

let toastTimer = null;
// Action d'annulation actuellement proposée par le toast visible (statut
// changé ou expédition supprimée) — permet à Ctrl+Z de déclencher la même
// action que le bouton "Annuler" du toast, tant que celui-ci est affiché.
// Effacé dès que le toast disparaît (bouton cliqué, nouvelle action, ou
// délai écoulé) : passé ce délai, Ctrl+Z ne fait plus rien ici.
let pendingUndo = null;
function showToast(message, { error = false, onUndo = null } = {}) {
  const toast = el("toast");
  const undoBtn = el("toast-undo");
  el("toast-message").textContent = message;
  toast.classList.remove("hidden");
  toast.classList.toggle("error", error);

  undoBtn.onclick = null;
  pendingUndo = null;
  if (onUndo) {
    pendingUndo = onUndo;
    undoBtn.classList.remove("hidden");
    undoBtn.onclick = () => {
      toast.classList.add("hidden");
      pendingUndo = null;
      onUndo();
    };
  } else {
    undoBtn.classList.add("hidden");
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
    pendingUndo = null;
  }, error ? 5000 : onUndo ? 4000 : 2500);
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

/**
 * Marque visuellement un champ en erreur (bordure rouge) en plus du toast
 * texte — sans ça, si l'utilisateur ne lit pas le toast avant qu'il
 * disparaisse (5s), rien n'indique QUEL champ pose problème une fois le
 * focus perdu. Retiré automatiquement dès que l'utilisateur retape dedans.
 */
function markFieldInvalid(inputEl) {
  inputEl.classList.add("field-invalid");
  const clear = () => {
    inputEl.classList.remove("field-invalid");
    inputEl.removeEventListener("input", clear);
  };
  inputEl.addEventListener("input", clear);
}

/**
 * Désactive un bouton et remplace son texte par un indicateur "⏳ …" pendant
 * l'exécution de `fn`, puis restaure l'état d'origine dans tous les cas
 * (succès ou erreur) — utilisé pour les opérations qui peuvent prendre plus
 * d'une fraction de seconde (export/import Excel sur un gros volume) : sans
 * ça, rien à l'écran n'indique qu'un clic a été pris en compte, au risque
 * que l'utilisateur reclique plusieurs fois en pensant que ça n'a pas marché.
 */
async function withLoading(button, loadingLabel, fn) {
  const originalLabel = button.textContent;
  const originalDisabled = button.disabled;
  button.disabled = true;
  button.textContent = `⏳ ${loadingLabel}`;
  try {
    return await fn();
  } finally {
    button.disabled = originalDisabled;
    button.textContent = originalLabel;
  }
}

/**
 * Remplace window.confirm() par un <dialog> thémé cohérent avec le reste de
 * l'app (confirm() natif est non thémé, bloquant façon navigateur, et casse
 * la cohérence visuelle dark/light). Retourne une Promise<boolean> comme
 * confirm() le ferait de façon synchrone.
 */
function confirmDialog(message, { title = "Confirmer", confirmLabel = "Confirmer" } = {}) {
  return new Promise((resolve) => {
    const dialog = el("confirm-dialog");
    el("confirm-dialog-title").textContent = title;
    el("confirm-dialog-message").textContent = message;
    el("confirm-dialog-ok").textContent = confirmLabel;

    let settled = false;
    const okBtn = el("confirm-dialog-ok");
    const cancelBtn = el("confirm-dialog-cancel");

    const settle = (result) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      dialog.close();
      resolve(result);
    };
    const onOk = () => settle(true);
    const onCancel = () => settle(false);
    const onClose = () => settle(false); // Échap ou clic hors dialog = annulation

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
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
  refreshDatalists();
  renderTechButtons(); // techniciens dynamiques (knownTechs) : la barre suit les données
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

/**
 * Source de vérité unique pour l'état des filtres, lu directement depuis le
 * DOM + les variables module (jamais dupliqué/recalculé différemment par
 * plusieurs fonctions). Tout code qui a besoin de savoir "quels filtres sont
 * actifs" doit appeler cette fonction plutôt que relire le DOM lui-même —
 * c'est ce qui a permis au bug "Tous et un technicien actifs en même temps"
 * de passer inaperçu : chaque affichage avait sa propre logique.
 */
function getActiveFilterState() {
  return {
    search: el("search").value.trim(),
    status: statusFilter,
    pickup: pickupFilter,
    technicianFilterActive,
    technician: technicianFilterActive ? selectedTech : null,
    groupByMonth: el("group-by-month").checked,
  };
}

function hasActiveFilters() {
  const state = getActiveFilterState();
  return Boolean(state.search) || Boolean(state.status) || Boolean(state.pickup) || state.technicianFilterActive;
}

function updateFilterControls() {
  el("search-clear").classList.toggle("hidden", !getActiveFilterState().search);
  el("btn-reset-filters").classList.toggle("hidden", !hasActiveFilters());
}

let lastFilteredIds = [];
let focusedRowId = null;
let rowClickTimer = null;
let activeInlineEditCleanup = null;

function renderTable() {
  const state = getActiveFilterState();
  updateFilterControls();

  const filtered = filterShipments(allShipments, {
    statusFilter: state.status,
    normalizedSearch: normalizeAccents(state.search),
    normalizeFn: normalizeAccents,
    technicianFilter: state.technician,
    pickupFilter: state.pickup,
  });

  const sorted = sortShipments(filtered, sortKey, sortDir);
  updateSortHeaders();
  lastFilteredIds = sorted.map((s) => s.id);

  // Purge les sélections dont la ligne a disparu (suppression) OU n'est plus
  // visible sous le filtre actuel (statut/recherche/technicien) : sans
  // ça, la barre d'actions groupées pouvait afficher "N sélectionnées" en
  // comptant des lignes masquées, invisibles à l'écran, et un "Supprimer"
  // les aurait affectées sans que l'utilisateur ne les voie jamais.
  const visibleIds = new Set(lastFilteredIds);
  for (const id of selectedIds) {
    if (!visibleIds.has(id)) selectedIds.delete(id);
  }

  el("row-count").textContent = `${filtered.length} / ${allShipments.length}`;
  renderStatsBar();
  renderPickupBar();
  renderBulkBar();
  saveFiltersToStorage();

  const body = el("shipments-body");
  if (sorted.length === 0) {
    body.innerHTML = `<tr><td colspan="11" class="empty">Aucune expédition</td></tr>`;
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
  const checked = selectedIds.has(s.id) ? "checked" : "";
  const cell = (field, value) =>
    `<td data-field="${field}" title="${escapeHtml(value || "Double-clic pour modifier")}">${escapeHtml(value ?? "")}</td>`;
  const dateCell = (field, value) => {
    const display = formatDateFr(value);
    return `<td data-field="${field}" title="${escapeHtml(display || "Double-clic pour modifier")}">${escapeHtml(display)}</td>`;
  };
  const inferredCarrier = inferCarrier(s.carrier, s.tracking_number);
  const carrierCell = s.carrier
    ? `<td data-field="carrier" title="${escapeHtml(s.carrier)}">${escapeHtml(s.carrier)}</td>`
    : inferredCarrier
      ? `<td data-field="carrier" class="carrier-inferred" title="Transporteur déduit du n° de suivi — non renseigné explicitement">${escapeHtml(inferredCarrier)}</td>`
      : `<td data-field="carrier" title="Double-clic pour modifier"></td>`;
  const trackingCell = s.tracking_number
    ? `<td data-field="tracking_number" title="${escapeHtml(s.tracking_number)}"><button type="button" class="tracking-copy-btn" data-copy-id="${s.id}" title="Copier le numéro de suivi">${escapeHtml(s.tracking_number)}</button>${
        isNumericTrackingValue(s.tracking_number)
          ? `<button type="button" class="tracking-link-btn" data-track-id="${s.id}" title="Suivre ce colis (17TRACK)">📦</button>`
          : ""
      }</td>`
    : `<td data-field="tracking_number" class="cell-empty-hint" title="Double-clic pour renseigner le n° de suivi">À éditer</td>`;
  // Même traitement visuel que le n° de suivi vide ("À éditer") : un champ
  // texte vide n'affichait rien du tout auparavant, se confondant avec une
  // cellule effectivement chargée mais vide par erreur de rendu. 78% des
  // lignes réelles n'ont pas de destinataire renseigné (donnée observée en
  // base) — ce n'est pas anormal pour un petit colis, mais ça doit rester
  // visuellement une INVITATION à compléter plutôt qu'un vide silencieux.
  const recipientCell = s.recipient
    ? `<td data-field="recipient" title="${escapeHtml(s.recipient)}">${escapeHtml(s.recipient)}</td>`
    : `<td data-field="recipient" class="cell-empty-hint" title="Double-clic pour renseigner le destinataire">À renseigner</td>`;
  // Non pertinent hors TNT (voir models.rs) : cellule vide et non éditable
  // dès que le transporteur n'est pas TNT, même si une valeur traîne en base
  // (ex: changement de transporteur après coup) — évite d'afficher/proposer
  // une info qui n'a pas de sens pour DPD et les autres transporteurs.
  const effectiveCarrier = s.carrier || inferredCarrier;
  const pickupCell =
    effectiveCarrier === "TNT"
      ? s.pickup_option
        ? `<td data-field="pickup_option" class="pickup-badge pickup-${s.pickup_option}" title="${escapeHtml(PICKUP_LABELS_FULL[s.pickup_option])}">${escapeHtml(PICKUP_LABELS_SHORT[s.pickup_option])}</td>`
        : `<td data-field="pickup_option" class="cell-empty-hint" title="Double-clic pour renseigner l'option de ramassage">À renseigner</td>`
      : `<td class="pickup-cell-na" title="Non pertinent hors TNT"></td>`;
  return `
    <tr data-id="${s.id}">
      <td><input type="checkbox" class="row-checkbox" data-select-id="${s.id}" ${checked} /></td>
      <td><button type="button" class="status-pill status-pill-clickable status-${s.status}" data-cycle-id="${s.id}" title="Cliquer pour changer le statut">${STATUS_LABELS[s.status]}</button></td>
      ${cell("supplier", s.supplier)}
      <td class="material-cell" data-field="material" title="${escapeHtml(s.material)}">${escapeHtml(s.material)}</td>
      ${trackingCell}
      ${carrierCell}
      ${pickupCell}
      ${recipientCell}
      ${dateCell("expected_date", s.expected_date)}
      ${dateCell("received_date", s.received_date)}
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
    html.push(`
      <tr class="month-header-row" data-month-key="${key}">
        <td colspan="11">
          <button type="button" class="month-toggle" data-month-toggle="${key}">
            <span class="month-chevron ${collapsed ? "collapsed" : ""}">▾</span>
            <span class="month-name">${monthLabel(key)}</span>
            <span class="month-count">${items.length}</span>
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
      // Simple clic n'importe où sur la ligne (y compris une cellule éditable
      // inline) ouvre le dialog complet, avec un léger délai pour laisser un
      // éventuel 2e clic (double-clic) annuler l'ouverture et déclencher
      // l'édition inline à la place — voir le listener dblclick ci-dessous,
      // qui appelle clearTimeout(rowClickTimer). Avant ce fix, un simple clic
      // sur une cellule data-field (Agence, Matériel, N° suivi, Transporteur,
      // Destinataire, dates — soit 7 des 9 colonnes) n'ouvrait JAMAIS le
      // dialog : seules les colonnes checkbox/statut/icône crayon (36px de
      // large) fonctionnaient, alors que le tooltip promettait "Cliquer la
      // ligne pour tout modifier".
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
    pickup_option: s.pickup_option,
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
  } else if (field === "pickup_option") {
    input = document.createElement("select");
    input.innerHTML = `<option value="">—</option><option value="with_pickup">${PICKUP_LABELS_FULL.with_pickup}</option><option value="without_pickup">${PICKUP_LABELS_FULL.without_pickup}</option>`;
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
    // Le n° de suivi ne doit jamais être "normalisé contre l'existant" comme
    // les autres champs texte (agence/matériel/destinataire) : ça pourrait
    // réutiliser silencieusement une ancienne valeur de texte libre en base
    // (tnt, dpd...) comme "forme canonique". Sa validation est dédiée
    // (chiffres uniquement / À éditer / Non sécurisé), voir plus bas.
    if (INLINE_TEXT_FIELDS.has(field) && field !== "tracking_number" && nextValue) {
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

    if (field === "tracking_number" && !isValidTrackingValue(nextValue, normalizeAccents)) {
      settled = false; // laisse l'utilisateur corriger sans perdre sa saisie
      showToast('N° de suivi invalide : chiffres uniquement, "À éditer" ou "Non sécurisé"', { error: true });
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
    // Repart de zéro à la prochaine sélection : sans ça, un ancien texte tapé
    // dans "Destinataire" ou une valeur choisie dans "Transporteur" restait
    // affiché (le DOM n'est que masqué, pas recréé), au risque d'être
    // appliqué par erreur à une toute nouvelle sélection sans rapport.
    el("bulk-carrier-select").value = "";
    el("bulk-recipient-input").value = "";
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
  const ok = await confirmDialog(`Passer ${ids.length} expédition(s) au statut "${STATUS_LABELS[status]}" ?`, {
    title: "Changer le statut",
    confirmLabel: "Confirmer",
  });
  if (!ok) return;

  const receivedDate = status === "received" ? todayIso() : null;

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

/**
 * Applique une valeur à un seul champ (carrier ou recipient) sur toute la
 * sélection en cours — même pattern que bulkSetStatus (confirmation, boucle
 * séquentielle, toast récap) mais générique pour éviter de dupliquer la
 * boucle update_shipment pour chaque nouveau champ groupé.
 */
async function bulkApplyField(field, value, fieldLabel) {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  const normalizedValue = value.trim() || null;
  const displayValue = normalizedValue ?? "(vide)";
  const ok = await confirmDialog(
    `Appliquer "${displayValue}" comme ${fieldLabel} à ${ids.length} expédition(s) sélectionnée(s) ?`,
    { title: `Modifier ${fieldLabel}`, confirmLabel: "Appliquer" }
  );
  if (!ok) return;

  let failCount = 0;
  for (const id of ids) {
    const s = allShipments.find((x) => x.id === id);
    if (!s) continue;
    try {
      await invoke("update_shipment", { shipment: buildUpdatePayload(s, { [field]: normalizedValue }) });
    } catch (err) {
      console.error("bulkApplyField", field, id, err);
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
  const ok = await confirmDialog(
    `Supprimer définitivement ${ids.length} expédition(s) ? Cette action est irréversible.`,
    { title: "Supprimer", confirmLabel: "Supprimer" }
  );
  if (!ok) return;

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

/* ---------- Barre de compteurs par statut (sert aussi de filtre) ---------- */

function renderStatsBar() {
  const container = el("stats-bar");

  const allChip = `<button type="button" class="stat-chip stat-chip-all ${!statusFilter ? "active" : ""}" data-stat-status="" title="Afficher tous les statuts">
      <span>Tous</span>
      <span class="stat-count">${allShipments.length}</span>
    </button>`;

  const statusChips = STATUS_ORDER.map((status) => {
    const count = allShipments.filter((s) => s.status === status).length;
    const active = status === statusFilter;
    return `<button type="button" class="stat-chip ${active ? "active" : ""}" data-stat-status="${status}" title="Filtrer sur ${STATUS_LABELS[status]}">
      <span class="stat-dot stat-dot-${status}"></span>
      <span class="stat-count">${count}</span>
      <span>${STATUS_LABELS[status]}</span>
    </button>`;
  }).join("");

  container.innerHTML = allChip + statusChips;

  container.querySelectorAll("[data-stat-status]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const status = chip.dataset.statStatus;
      statusFilter = statusFilter === status ? "" : status;
      visibleCount = PAGE_SIZE;
      renderTable();
    });
  });
}

/**
 * Barre de filtre Ramassage (option de bon TNT, indépendante du statut —
 * voir pickupFilter). Masquée entièrement tant qu'aucune expédition n'a
 * cette info renseignée : inutile d'occuper de l'espace pour un filtre sur
 * un champ encore vide partout (données historiques jamais renseignées,
 * voir demande utilisateur du 2026-09-23).
 */
function renderPickupBar() {
  const container = el("pickup-bar");
  const counts = PICKUP_ORDER.map((value) => ({
    value,
    count: allShipments.filter((s) => s.pickup_option === value).length,
  }));

  if (counts.every((c) => c.count === 0)) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = counts
    .map(({ value, count }) => {
      const active = value === pickupFilter;
      return `<button type="button" class="stat-chip pickup-chip ${active ? "active" : ""}" data-pickup-option="${value}" title="Filtrer sur ${PICKUP_LABELS_FULL[value]}">
      <span class="stat-count">${count}</span>
      <span>${PICKUP_LABELS_FULL[value]}</span>
    </button>`;
    })
    .join("");

  container.querySelectorAll("[data-pickup-option]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const value = chip.dataset.pickupOption;
      pickupFilter = pickupFilter === value ? "" : value;
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
    nextStatus === "received" ? s.received_date || todayIso() : null;

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
  // Si l'utilisateur tape un nom libre dans "Autre…", c'est CE texte qui sera
  // utilisé pour la saisie (voir currentTechnician()), pas le technicien
  // présélectionné par bouton — même si ce dernier reste mémorisé. Sans ça,
  // un bouton pouvait apparaître "présélectionné" alors qu'il ne serait pas
  // réellement utilisé à la prochaine saisie, ce qui trompait l'utilisateur.
  const customOverride = Boolean(el("tech-custom").value.trim());
  const allBtn = `<button type="button" class="tech-btn tech-btn-all ${!technicianFilterActive ? "active filter-active" : ""}" data-tech-all title="Afficher toutes les expéditions, peu importe qui les a traitées">Tous</button>`;
  const techButtons = knownTechs().map((t) => {
    const isSelected = t === selectedTech && !customOverride;
    const isFiltering = t === selectedTech && technicianFilterActive;
    // "active" = c'est CE bouton qui filtre actuellement la vue (fond plein).
    // "preselected" = juste présélectionné pour la saisie rapide, sans filtrer
    // (style discret) : les deux ne doivent jamais se confondre visuellement,
    // sinon "Tous" et un technicien semblent actifs en même temps.
    const stateClass = isFiltering ? "active filter-active" : isSelected ? "preselected" : "";
    return `<button type="button" class="tech-btn ${stateClass}" data-tech="${escapeHtml(t)}" title="Clic : sélectionner pour la saisie et filtrer le tableau">${escapeHtml(t)}</button>`;
  }).join("");
  container.innerHTML = allBtn + techButtons;

  el("tech-buttons")
    .querySelector("[data-tech-all]")
    .addEventListener("click", () => {
      technicianFilterActive = false;
      renderTechButtons();
      visibleCount = PAGE_SIZE;
      renderTable();
    });

  container.querySelectorAll(".tech-btn[data-tech]").forEach((btn) => {
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

/* ---------- Ligne de saisie rapide ---------- */

const QUICK_FIELDS = ["q-supplier", "q-material", "q-tracking", "q-carrier", "q-pickup-option", "q-recipient", "q-expected"];

function resetQuickRow() {
  QUICK_FIELDS.forEach((id) => (el(id).value = ""));
  el("q-expected").value = todayIso();
  el("q-duplicate-warning").classList.add("hidden");
  el("q-supplier-warning").classList.add("hidden");
  updateQuickPickupOptionAvailability();
}

/**
 * L'option de ramassage occasionnel n'a de sens que pour un bon TNT (voir
 * models.rs) — désactive et vide le select dès que Transporteur ≠ TNT,
 * plutôt que de le masquer complètement : reste visible en grisé pour que
 * l'utilisateur comprenne POURQUOI il est indisponible (association avec
 * Transporteur), au lieu d'un champ qui disparaît sans explication.
 */
function updateQuickPickupOptionAvailability() {
  const isTnt = el("q-carrier").value === "TNT";
  const select = el("q-pickup-option");
  select.disabled = !isTnt;
  if (!isTnt) select.value = "";
}

function checkDuplicateTracking(value, { excludeId = null } = {}) {
  return allShipments.some(
    (s) => s.id !== excludeId && s.tracking_number && s.tracking_number.trim() === value
  );
}

/**
 * Rattrape les fautes de frappe humaines sur le champ Agence : si la saisie
 * ressemble fortement (mais n'est pas identique) à une agence déjà connue,
 * affiche un avertissement dismissable "Vouliez-vous dire … ?" — n'empêche
 * jamais de continuer, l'utilisateur garde la main (voir findSimilarValue).
 */
function updateSupplierSimilarWarning(inputEl, warningEl, { excludeId = null } = {}) {
  const value = inputEl.value.trim();
  if (!value) {
    warningEl.classList.add("hidden");
    return;
  }
  const existing = [
    ...new Set(allShipments.filter((s) => s.id !== excludeId).map((s) => s.supplier).filter(Boolean)),
  ];
  const similar = findSimilarValue(value, existing);
  if (similar) {
    warningEl.textContent = `⚠ Vouliez-vous dire "${similar}" ?`;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }
}

function updateQuickDuplicateWarning() {
  const value = el("q-tracking").value.trim();
  const warning = el("q-duplicate-warning");
  if (!value) {
    warning.classList.add("hidden");
    return;
  }
  warning.classList.toggle("hidden", !checkDuplicateTracking(value));
}

async function submitQuickRow({ keepFieldsForNext = false } = {}) {
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
    if (!values.supplier) markFieldInvalid(el("q-supplier"));
    else markFieldInvalid(el("q-material"));
    if (!values.supplier) el("q-supplier").focus();
    else el("q-material").focus();
    showToast(`Champ(s) requis manquant(s) : ${errors.join(", ")}`, { error: true });
    return;
  }

  if (!isValidTrackingValue(el("q-tracking").value, normalizeAccents)) {
    markFieldInvalid(el("q-tracking"));
    showToast('N° de suivi invalide : chiffres uniquement, "À éditer" ou "Non sécurisé"', { error: true });
    el("q-tracking").focus();
    return;
  }

  const tech = currentTechnician();
  const payload = {
    ...values,
    tracking_number: el("q-tracking").value.trim() || null,
    expected_date: el("q-expected").value || null,
    notes: tech ? `Traité par: ${tech}` : null,
    pickup_option: el("q-pickup-option").value || null,
  };

  let created;
  try {
    created = await safeInvoke("create_shipment", { shipment: payload });

    // Toute nouvelle expédition démarre avec le statut "Expédié" par défaut
    // (le backend crée avec "Commandé" par défaut) — son état évoluera
    // ensuite au fil des validations via le badge cliquable dans le tableau.
    await safeInvoke("update_shipment", {
      shipment: {
        id: created.id,
        supplier: created.supplier,
        tracking_number: created.tracking_number,
        carrier: created.carrier,
        recipient: created.recipient,
        material: created.material,
        status: "shipped",
        expected_date: created.expected_date,
        received_date: null,
        notes: created.notes,
        pickup_option: created.pickup_option,
      },
    });
  } catch {
    return; // erreur déjà affichée par safeInvoke
  }

  lastCreated = { ...payload, status: "shipped" };
  if (keepFieldsForNext) {
    // Ctrl+Entrée : garde Agence/Matériel/Transporteur/Destinataire pour la
    // prochaine ligne, ne vide que le n° de suivi et remet la date à
    // aujourd'hui — utile pour saisir plusieurs colis identiques d'affilée
    // sans retaper les mêmes informations à chaque fois.
    el("q-tracking").value = "";
    el("q-expected").value = todayIso();
    el("q-duplicate-warning").classList.add("hidden");
    el("q-supplier-warning").classList.add("hidden");
  } else {
    resetQuickRow();
  }
  await loadShipments();
  showToast(keepFieldsForNext ? "Expédition ajoutée — champs conservés" : "Expédition ajoutée");
  el(keepFieldsForNext ? "q-tracking" : "q-supplier").focus();
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
  el("q-pickup-option").value = lastCreated.pickup_option ?? "";
  updateQuickPickupOptionAvailability();
  el("q-recipient").value = lastCreated.recipient ?? "";
  el("q-expected").value = todayIso();
  el("q-supplier").focus();
}

function setupQuickRowKeyboard() {
  const row = el("quick-add-row");

  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      submitQuickRow({ keepFieldsForNext: true });
    } else if (e.key === "Enter") {
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

  // Ctrl+Z : annule la dernière action annulable (suppression, changement de
  // statut) tant que son toast est affiché — même action que le bouton
  // "Annuler" du toast. Volontairement PAS bloqué par shipment-dialog.open
  // ni par isTypingInFormField() sauf pour ce raccourci précis : si
  // l'utilisateur tape dans un champ texte, Ctrl+Z doit faire l'undo natif
  // du champ (annuler la frappe), jamais notre action métier.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "z" && pendingUndo && !isTypingInFormField()) {
      e.preventDefault();
      const undo = pendingUndo;
      el("toast").classList.add("hidden");
      pendingUndo = null;
      undo();
    }
  });

  el("q-submit").addEventListener("click", submitQuickRow);
}

/* ---------- Colonnes redimensionnables ---------- */

const MIN_COLUMN_WIDTH = 50;

function loadColumnWidths() {
  const state = readStoredJson(COLUMN_WIDTHS_KEY);
  return state && typeof state.widths === "object" && state.widths !== null ? state.widths : {};
}

function saveColumnWidths(widths) {
  writeStoredJson(COLUMN_WIDTHS_KEY, { widths });
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

function updateDialogDuplicateWarning() {
  const value = el("f-tracking").value.trim();
  const warning = el("f-duplicate-warning");
  const currentId = el("f-id").value;
  if (!value) {
    warning.classList.add("hidden");
    return;
  }
  warning.classList.toggle("hidden", !checkDuplicateTracking(value, { excludeId: currentId }));
}

function updateTrackingLinkButton() {
  const btn = el("f-tracking-link");
  const value = el("f-tracking").value;
  // N'affiche le lien de suivi que pour un vrai numéro TNT/DPD — pas pour
  // "Non sécurisé", du texte libre historique ("à programmer", "tnt" tapé
  // en toutes lettres...) qui ouvrirait 17TRACK avec une requête sans sens.
  btn.classList.toggle("hidden", !isNumericTrackingValue(value) || !buildTrackingUrl(value));
}

// Le backend efface silencieusement received_date si le statut n'est pas
// "received" (voir update_shipment_impl côté Rust). Sans ce garde-fou,
// l'utilisateur pouvait saisir une date reçue dans le dialog avec un statut
// "Commandé"/"Expédié", cliquer Enregistrer, et voir sa saisie disparaître
// sans aucun avertissement.
function updateReceivedRowVisibility() {
  const status = el("f-status").value;
  const allowsReceivedDate = status === "received";
  const row = el("received-row");
  const input = el("f-received");
  row.classList.toggle("hidden", !allowsReceivedDate);
  input.disabled = !allowsReceivedDate;
  if (!allowsReceivedDate) input.value = "";
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
  el("f-pickup-option").value = s.pickup_option ?? "";
  el("f-recipient").value = s.recipient ?? "";
  el("f-status").value = s.status;
  el("f-expected").value = s.expected_date ?? "";
  el("f-received").value = s.received_date ?? "";
  el("f-notes").value = s.notes ?? "";
  el("btn-delete").classList.remove("hidden");
  updateTrackingLinkButton();
  updateReceivedRowVisibility();
  updateDialogPickupOptionAvailability();
  updateDialogDuplicateWarning();
  updateSupplierSimilarWarning(el("f-supplier"), el("f-supplier-warning"), { excludeId: s.id });
  el("shipment-dialog").showModal();
}

/** Même logique que updateQuickPickupOptionAvailability, pour le dialog complet. */
function updateDialogPickupOptionAvailability() {
  const isTnt = el("f-carrier").value === "TNT";
  const select = el("f-pickup-option");
  select.disabled = !isTnt;
  if (!isTnt) select.value = "";
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
    if (!values.supplier) markFieldInvalid(el("f-supplier"));
    if (!values.material) markFieldInvalid(el("f-material"));
    showToast(`Champ(s) requis manquant(s) : ${errors.join(", ")}`, { error: true });
    return;
  }

  if (!isValidTrackingValue(el("f-tracking").value, normalizeAccents)) {
    markFieldInvalid(el("f-tracking"));
    showToast('N° de suivi invalide : chiffres uniquement, "À éditer" ou "Non sécurisé"', { error: true });
    el("f-tracking").focus();
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
        pickup_option: el("f-pickup-option").value || null,
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
  const ok = await confirmDialog("Supprimer cette expédition ?", { title: "Supprimer", confirmLabel: "Supprimer" });
  if (!ok) return;
  // Capturé AVANT suppression : toutes les données nécessaires pour une
  // restauration à l'identique (voir restore_shipment côté Rust — même id,
  // mêmes dates, jamais une nouvelle expédition qui ressemble à l'ancienne).
  const deleted = allShipments.find((x) => x.id === id);
  try {
    await safeInvoke("delete_shipment", { id });
  } catch {
    return;
  }
  el("shipment-dialog").close();
  await loadShipments();
  showToast("Expédition supprimée", {
    onUndo: deleted ? () => restoreDeletedShipment(deleted) : null,
  });
}

async function restoreDeletedShipment(shipment) {
  try {
    await safeInvoke("restore_shipment", { shipment });
  } catch {
    return; // erreur déjà affichée par safeInvoke
  }
  await loadShipments();
  showToast("Suppression annulée");
}

async function exportXlsx(shipmentIds = null, triggerButton = null) {
  const path = await save({
    defaultPath: "shiptrack-export.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!path) return;
  const doExport = () => safeInvoke("export_shipments_xlsx", { filePath: path, shipmentIds });
  try {
    if (triggerButton) {
      await withLoading(triggerButton, "Export en cours…", doExport);
    } else {
      await doExport();
    }
  } catch {
    return;
  }
  showToast("Export terminé : " + path);
}

/* ---------- Import PDF en lot (page dédiée) ---------- */

// État de la page — un tableau de "lignes" éditables (voir pdf_batch.js),
// vidé à chaque nouvelle sélection de fichiers. Volontairement en dehors de
// allShipments : ce ne sont pas encore des expéditions tant qu'elles n'ont
// pas été créées via btn-pdf-batch-create.
let pdfBatchRows = [];

function showPdfBatchPage() {
  el("file-menu").classList.add("hidden");
  el("pdf-batch-page").classList.remove("hidden");
  el("main-table-chrome").classList.add("hidden");
  document.querySelector("main").classList.add("hidden");
}

function hidePdfBatchPage() {
  el("pdf-batch-page").classList.add("hidden");
  el("main-table-chrome").classList.remove("hidden");
  document.querySelector("main").classList.remove("hidden");
}

/* ---------- Corbeille (soft-delete cote backend, voir commands.rs) ---------- */
let trashRows = [];
function showTrashPage() {
  el("file-menu").classList.add("hidden");
  el("trash-page").classList.remove("hidden");
  el("main-table-chrome").classList.add("hidden");
  document.querySelector("main").classList.add("hidden");
  loadTrash();
}
function hideTrashPage() {
  el("trash-page").classList.add("hidden");
  el("main-table-chrome").classList.remove("hidden");
  document.querySelector("main").classList.remove("hidden");
}
async function loadTrash() {
  try {
    trashRows = await safeInvoke("list_deleted_shipments", {});
  } catch {
    return;
  }
  renderTrashTable();
}
function renderTrashTable() {
  const body = el("trash-body");
  if (trashRows.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="empty">Corbeille vide.</td></tr>`;
  } else {
    body.innerHTML = trashRows
      .map(
        (t) => `
        <tr data-id="${escapeHtml(t.id)}">
          <td>${escapeHtml((t.deleted_at ?? "").slice(0, 16).replace("T", " "))}</td>
          <td>${escapeHtml(t.supplier)}</td>
          <td>${escapeHtml(t.material)}</td>
          <td>${escapeHtml(t.tracking_number ?? "")}</td>
          <td>${escapeHtml(t.recipient ?? "")}</td>
          <td class="trash-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-trash-restore="${escapeHtml(t.id)}">Restaurer</button>
            <button type="button" class="btn btn-sm btn-danger" data-trash-purge="${escapeHtml(t.id)}">Supprimer définitivement</button>
          </td>
        </tr>`
      )
      .join("");
    body.querySelectorAll("[data-trash-restore]").forEach((btn) =>
      btn.addEventListener("click", () => restoreFromTrash(btn.dataset.trashRestore))
    );
    body.querySelectorAll("[data-trash-purge]").forEach((btn) =>
      btn.addEventListener("click", () => purgeFromTrash(btn.dataset.trashPurge))
    );
  }
  el("trash-summary").textContent =
    trashRows.length > 0 ? `${trashRows.length} expédition(s) supprimée(s)` : "";
  el("btn-trash-restore-all").disabled = trashRows.length === 0;
  el("btn-trash-purge-all").disabled = trashRows.length === 0;
}
async function restoreFromTrash(id) {
  try {
    await safeInvoke("restore_shipment_by_id", { id });
  } catch {
    return;
  }
  showToast("Expédition restaurée");
  await Promise.all([loadTrash(), loadShipments()]);
}
async function restoreAllFromTrash() {
  if (trashRows.length === 0) return;
  for (const t of trashRows) {
    try {
      await invoke("restore_shipment_by_id", { id: t.id });
    } catch (err) {
      console.error("restoreAllFromTrash", t.id, err);
    }
  }
  showToast(`${trashRows.length} expédition(s) restaurée(s)`);
  await Promise.all([loadTrash(), loadShipments()]);
}
async function purgeFromTrash(id) {
  const ok = await confirmDialog(
    "Supprimer définitivement cette expédition ? Cette action est irréversible.",
    { title: "Suppression définitive", confirmLabel: "Supprimer" }
  );
  if (!ok) return;
  try {
    await safeInvoke("purge_shipments", { ids: [id] });
  } catch {
    return;
  }
  showToast("Expédition supprimée définitivement");
  await loadTrash();
}
async function purgeAllFromTrash() {
  if (trashRows.length === 0) return;
  const ok = await confirmDialog(
    `Vider définitivement la corbeille (${trashRows.length} expédition(s)) ? Cette action est irréversible.`,
    { title: "Vider la corbeille", confirmLabel: "Vider" }
  );
  if (!ok) return;
  try {
    await safeInvoke("purge_shipments", { ids: null });
  } catch {
    return;
  }
  showToast("Corbeille vidée");
  await loadTrash();
}

async function selectPdfBatchFiles() {
  const paths = await open({
    multiple: true,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!paths || paths.length === 0) return;

  let results;
  try {
    results = await withLoading(el("btn-pdf-batch-select"), "Lecture…", () =>
      safeInvoke("parse_shipping_notes_pdfs", { filePaths: paths })
    );
  } catch {
    return; // erreur déjà affichée par safeInvoke
  }

  pdfBatchRows = batchResultsToRows(results);
  renderPdfBatchTable();
}

async function scanPdfBatchDirectory() {
  const dir = await open({ directory: true });
  if (!dir) return;
  let paths;
  try {
    paths = await withLoading(el("btn-pdf-batch-scan"), "Scan…", () =>
      safeInvoke("scan_pdfs_in_directory", { directory: dir })
    );
  } catch {
    return; // erreur déjà affichée par safeInvoke
  }
  if (paths.length === 0) {
    showToast("Aucun PDF trouvé dans ce dossier.");
    return;
  }
  let results;
  try {
    results = await withLoading(el("btn-pdf-batch-scan"), "Lecture…", () =>
      safeInvoke("parse_shipping_notes_pdfs", { filePaths: paths })
    );
  } catch {
    return;
  }
  pdfBatchRows = batchResultsToRows(results);
  renderPdfBatchTable();
}

function renderPdfBatchTable() {
  const body = el("pdf-batch-body");
  if (pdfBatchRows.length === 0) {
    body.innerHTML = `<tr><td colspan="9" class="empty">Aucun fichier sélectionné.</td></tr>`;
  } else {
    body.innerHTML = pdfBatchRows
      .map((row, i) => {
        if (row.error) {
          return `
            <tr class="pdf-batch-row-error">
              <td></td>
              <td title="${escapeHtml(row.file_name)}">${escapeHtml(row.file_name)}</td>
              <td colspan="7" class="pdf-batch-error-message">⚠ ${escapeHtml(row.error)}</td>
            </tr>`;
        }
        const missingSupplier = row.included && !row.supplier.trim();
        const warningTitle = row.warnings.length > 0 ? escapeHtml(row.warnings.join(" ")) : "";
        return `
          <tr class="${missingSupplier ? "pdf-batch-row-missing" : ""}">
            <td><input type="checkbox" class="pdf-batch-row-checkbox" data-row-index="${i}" ${row.included ? "checked" : ""} /></td>
            <td title="${escapeHtml(row.file_name)}${warningTitle ? " — " + warningTitle : ""}">${escapeHtml(row.file_name)}${row.warnings.length > 0 ? " ⚠" : ""}</td>
            <td><input type="text" data-row-index="${i}" data-row-field="supplier" list="agences-list" value="${escapeHtml(row.supplier)}" placeholder="Agence (requis)" /></td>
            <td><input type="text" data-row-index="${i}" data-row-field="material" list="materials-list" value="${escapeHtml(row.material)}" placeholder="${DEFAULT_MATERIAL_PLACEHOLDER}" /></td>
            <td><input type="text" data-row-index="${i}" data-row-field="tracking_number" value="${escapeHtml(row.tracking_number)}" /></td>
            <td>
              <select data-row-index="${i}" data-row-field="carrier">
                <option value="" ${row.carrier === "" ? "selected" : ""}>—</option>
                <option value="TNT" ${row.carrier === "TNT" ? "selected" : ""}>TNT</option>
                <option value="DPD" ${row.carrier === "DPD" ? "selected" : ""}>DPD</option>
              </select>
            </td>
            <td><input type="text" data-row-index="${i}" data-row-field="recipient" list="recipients-list" value="${escapeHtml(row.recipient)}" /></td>
            <td><input type="date" data-row-index="${i}" data-row-field="expected_date" value="${escapeHtml(row.expected_date)}" /></td>
            <td><input type="text" data-row-index="${i}" data-row-field="notes" value="${escapeHtml(row.notes)}" placeholder="Préciser le contenu du colis…" /></td>
          </tr>`;
      })
      .join("");
  }
  renderPdfBatchSummary();
}

function renderPdfBatchSummary() {
  const { total, errors, missingSupplier, excluded, ready } = summarizeRows(pdfBatchRows);
  const parts = [];
  if (total > 0) {
    parts.push(`${total} fichier(s)`);
    parts.push(`${ready} prêt(s)`);
    if (errors > 0) parts.push(`${errors} en erreur`);
    if (missingSupplier > 0) parts.push(`${missingSupplier} sans agence`);
    if (excluded > 0) parts.push(`${excluded} décoché(s)`);
  }
  el("pdf-batch-summary").textContent = parts.join(" · ");
  el("btn-pdf-batch-create").disabled = ready === 0;
}

function handlePdfBatchTableInput(e) {
  const index = e.target.dataset.rowIndex;
  if (index === undefined) return;
  const row = pdfBatchRows[Number(index)];
  if (!row) return;

  if (e.target.classList.contains("pdf-batch-row-checkbox")) {
    row.included = e.target.checked;
    renderPdfBatchSummary();
    return;
  }
  const field = e.target.dataset.rowField;
  if (field) {
    row[field] = e.target.value;
    // Champ Agence tapé/corrigé : ré-évalue juste le résumé (compteur "sans
    // agence") sans reconstruire tout le tableau et perdre le focus courant.
    if (field === "supplier") renderPdfBatchSummary();
  }
}

async function createPdfBatchShipments() {
  const rows = includedRows(pdfBatchRows);
  if (rows.length === 0) return;

  const tech = currentTechnician();
  const confirmed = await confirmDialog(
    `Créer ${rows.length} expédition(s) à partir des bons PDF sélectionnés ?`,
    { title: "Créer les expéditions", confirmLabel: "Créer" }
  );
  if (!confirmed) return;

  let successCount = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const payload = rowToNewShipmentPayload(row, { technician: tech });
      const created = await invoke("create_shipment", { shipment: payload });
      // Même défaut que la saisie rapide : toute nouvelle expédition démarre
      // "Expédié" (le backend crée avec "Commandé"), voir submitQuickRow.
      await invoke("update_shipment", {
        shipment: {
          id: created.id,
          supplier: created.supplier,
          tracking_number: created.tracking_number,
          carrier: created.carrier,
          recipient: created.recipient,
          material: created.material,
          status: "shipped",
          expected_date: created.expected_date,
          received_date: null,
          notes: created.notes,
          pickup_option: created.pickup_option,
        },
      });
      successCount++;
    } catch (err) {
      console.error("createPdfBatchShipments", row.file_name, err);
      failures.push(row.file_name);
    }
  }

  if (failures.length > 0) {
    showToast(`${successCount} expédition(s) créée(s), échec pour : ${failures.join(", ")}`, { error: true });
  } else {
    showToast(`${successCount} expédition(s) créée(s)`);
  }

  pdfBatchRows = [];
  renderPdfBatchTable();
  await loadShipments();
  if (failures.length === 0) hidePdfBatchPage();
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

  try {
    const result = await withLoading(el("btn-import-confirm"), "Import en cours…", () =>
      safeInvoke("import_excel_sheet", {
        filePath: pendingImportPath,
        sheetName,
      })
    );
    el("import-dialog").close();
    const parts = [`${result.inserted} expédition(s) importée(s)`];
    if (result.skipped > 0) parts.push(`${result.skipped} ligne(s) vide(s) ignorée(s)`);
    if (result.duplicates > 0) parts.push(`⚠ ${result.duplicates} n° de suivi déjà existant(s) (réimport possible)`);
    showToast(parts.join(", "), { error: result.duplicates > 0 });
    await loadShipments();
  } catch {
    // erreur déjà affichée par safeInvoke
  } finally {
    pendingImportPath = null;
  }
}

/* ---------- Archivage (garder uniquement une année récente active) ---------- */

/**
 * Ouvre le dialog d'archivage, pré-rempli avec l'année en cours, et met à
 * jour l'aperçu du nombre d'expéditions archivables à chaque changement
 * d'année saisie. Seules les expéditions avec une date prévue renseignée ET
 * antérieure à l'année choisie sont archivables — celles sans date restent
 * toujours actives (décision produit explicite : ne jamais risquer de
 * masquer un envoi en cours faute d'une date simplement non saisie).
 */
async function updateArchivePreview() {
  const year = parseInt(el("archive-keep-year").value, 10);
  const hint = el("archive-preview-hint");
  const confirmBtn = el("btn-archive-confirm");
  if (!Number.isInteger(year) || year < 2015 || year > 2035) {
    hint.textContent = "Choisissez une année pour voir combien d'expéditions seraient archivées.";
    confirmBtn.disabled = true;
    return;
  }
  try {
    const count = await safeInvoke("count_archivable", { keepYear: year });
    if (count === 0) {
      hint.textContent = `Aucune expédition à archiver avant ${year}.`;
      confirmBtn.disabled = true;
    } else {
      hint.textContent = `${count} expédition(s) avec une date prévue avant ${year} seront archivées.`;
      confirmBtn.disabled = false;
    }
  } catch {
    // erreur déjà affichée par safeInvoke
    confirmBtn.disabled = true;
  }
}

function startArchive() {
  el("archive-keep-year").value = new Date().getFullYear();
  el("archive-dialog").showModal();
  updateArchivePreview();
}

async function confirmArchive(e) {
  e.preventDefault();
  const year = parseInt(el("archive-keep-year").value, 10);
  if (!Number.isInteger(year)) return;

  const ok = await confirmDialog(
    `Archiver toutes les expéditions datées avant ${year} ? Elles seront retirées de la vue active mais resteront récupérables via "Recharger une archive…".`,
    { title: "Archiver", confirmLabel: "Archiver" }
  );
  if (!ok) return;

  try {
    const result = await withLoading(el("btn-archive-confirm"), "Archivage…", () =>
      safeInvoke("archive_shipments_before", { keepYear: year })
    );
    el("archive-dialog").close();
    showToast(`${result.archived} expédition(s) archivée(s) dans ${result.archive_file_name} — ${result.kept} restent actives`);
    await loadShipments();
  } catch {
    // erreur déjà affichée par safeInvoke
  }
}

/**
 * Ouvre le dialog de rechargement d'archive, liste les archives disponibles
 * (nom de fichier + nombre d'expéditions qu'elle contient, pour aider à
 * distinguer plusieurs archives). Rechargement = remplacement complet du
 * contenu actif (décision produit explicite, plus simple et plus fiable
 * qu'une fusion) — une sauvegarde de sécurité est prise côté backend juste
 * avant, quoi qu'il arrive.
 */
async function startReloadArchive() {
  let archives;
  try {
    archives = await safeInvoke("list_archives");
  } catch {
    return;
  }
  if (!archives || archives.length === 0) {
    showToast("Aucune archive disponible pour l'instant", { error: true });
    return;
  }
  const select = el("reload-archive-select");
  select.innerHTML = archives
    .map((a) => `<option value="${escapeHtml(a.path)}">${escapeHtml(a.file_name)} (${a.count} expédition(s))</option>`)
    .join("");
  el("reload-archive-dialog").showModal();
}

async function confirmReloadArchive(e) {
  e.preventDefault();
  const path = el("reload-archive-select").value;
  if (!path) return;

  const ok = await confirmDialog(
    "Recharger cette archive va REMPLACER tout le contenu actif. Une sauvegarde de sécurité sera prise automatiquement avant. Continuer ?",
    { title: "Recharger l'archive", confirmLabel: "Recharger" }
  );
  if (!ok) return;

  try {
    const count = await withLoading(el("btn-reload-archive-confirm"), "Rechargement…", () =>
      safeInvoke("reload_archive", { archivePath: path })
    );
    el("reload-archive-dialog").close();
    showToast(`${count} expédition(s) rechargée(s) depuis l'archive`);
    await loadShipments();
  } catch {
    // erreur déjà affichée par safeInvoke
  }
}

/* ---------- Init ---------- */

window.addEventListener("DOMContentLoaded", () => {
  restoreFiltersFromStorage();
  updateThemeToggleIcon();
  el("btn-theme-toggle").addEventListener("click", toggleTheme);

  renderTechButtons();
  setupQuickRowKeyboard();
  setupRowKeyboardNavigation();
  applyColumnWidths();
  setupColumnResizing();
  el("q-expected").value = todayIso();
  updateQuickPickupOptionAvailability();

  el("btn-cancel").addEventListener("click", () => el("shipment-dialog").close());
  // Le focus posé par showModal() sur le premier champ (#f-supplier) n'est
  // pas fiablement restauré à la fermeture (Annuler/Enregistrer/Supprimer/
  // Échap) — sans ce blur, isTypingInFormField() resterait bloqué sur ce
  // champ fantôme après coup et empêcherait Ctrl+Z de fonctionner juste
  // après avoir fermé le dialog (ex: juste après une suppression).
  el("shipment-dialog").addEventListener("close", () => {
    document.activeElement?.blur?.();
  });
  el("btn-delete").addEventListener("click", deleteShipment);
  el("shipment-form").addEventListener("submit", saveShipment);

  // Menu Fichier : export (tout / vue filtrée) et import, regroupés en un
  // seul menu déroulant plutôt que 2 boutons séparés dans la topbar.
  el("btn-file-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    el("file-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", () => el("file-menu").classList.add("hidden"));
  el("export-all").addEventListener("click", () => {
    el("file-menu").classList.add("hidden");
    exportXlsx(null, el("btn-file-menu"));
  });
  el("export-filtered").addEventListener("click", () => {
    el("file-menu").classList.add("hidden");
    exportXlsx(lastFilteredIds, el("btn-file-menu"));
  });

  el("q-tracking").addEventListener("input", updateQuickDuplicateWarning);
  el("q-supplier").addEventListener("input", () => {
    updateSupplierSimilarWarning(el("q-supplier"), el("q-supplier-warning"));
  });
  el("q-carrier").addEventListener("change", updateQuickPickupOptionAvailability);
  el("tech-custom").addEventListener("input", renderTechButtons);
  el("f-tracking").addEventListener("input", () => {
    updateTrackingLinkButton();
    updateDialogDuplicateWarning();
  });
  el("f-supplier").addEventListener("input", () => {
    updateSupplierSimilarWarning(el("f-supplier"), el("f-supplier-warning"), { excludeId: el("f-id").value });
  });
  el("f-status").addEventListener("change", updateReceivedRowVisibility);
  el("f-carrier").addEventListener("change", updateDialogPickupOptionAvailability);
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
  el("group-by-month").addEventListener("change", () => {
    renderTable();
  });
  // Décision produit explicite : "Réinitialiser" remet à zéro les FILTRES qui
  // réduisent ce qui est affiché (recherche, statut, technicien), mais
  // PAS le regroupement par mois — c'est une préférence de mise en forme de
  // l'affichage, pas un filtre qui masque des expéditions.
  el("btn-reset-filters").addEventListener("click", () => {
    el("search").value = "";
    statusFilter = "";
    pickupFilter = "";
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
    exportXlsx([...selectedIds], el("bulk-export"));
  });
  document.querySelectorAll("[data-bulk-status]").forEach((btn) => {
    btn.addEventListener("click", () => bulkSetStatus(btn.dataset.bulkStatus));
  });
  el("bulk-carrier-apply").addEventListener("click", () => {
    bulkApplyField("carrier", el("bulk-carrier-select").value, "Transporteur");
  });
  el("bulk-recipient-apply").addEventListener("click", () => {
    bulkApplyField("recipient", el("bulk-recipient-input").value, "Destinataire");
  });

  el("btn-import").addEventListener("click", () => {
    el("file-menu").classList.add("hidden");
    startImport();
  });
  el("btn-import-cancel").addEventListener("click", () => {
    el("import-dialog").close();
    pendingImportPath = null;
  });
  el("import-form").addEventListener("submit", confirmImport);

  el("btn-pdf-batch").addEventListener("click", showPdfBatchPage);
  el("btn-pdf-batch-back").addEventListener("click", hidePdfBatchPage);
  el("btn-pdf-batch-select").addEventListener("click", selectPdfBatchFiles);
  el("btn-pdf-batch-scan").addEventListener("click", scanPdfBatchDirectory);
  el("btn-pdf-batch-create").addEventListener("click", createPdfBatchShipments);
  el("btn-trash").addEventListener("click", showTrashPage);
  el("btn-trash-back").addEventListener("click", hideTrashPage);
  el("btn-trash-restore-all").addEventListener("click", restoreAllFromTrash);
  el("btn-trash-purge-all").addEventListener("click", purgeAllFromTrash);
  el("pdf-batch-body").addEventListener("input", handlePdfBatchTableInput);
  el("pdf-batch-body").addEventListener("change", handlePdfBatchTableInput);

  el("btn-archive").addEventListener("click", () => {
    el("file-menu").classList.add("hidden");
    startArchive();
  });
  el("archive-keep-year").addEventListener("input", updateArchivePreview);
  el("btn-archive-cancel").addEventListener("click", () => el("archive-dialog").close());
  el("archive-form").addEventListener("submit", confirmArchive);

  el("btn-reload-archive").addEventListener("click", () => {
    el("file-menu").classList.add("hidden");
    startReloadArchive();
  });
  el("btn-reload-archive-cancel").addEventListener("click", () => el("reload-archive-dialog").close());
  el("reload-archive-form").addEventListener("submit", confirmReloadArchive);

  loadShipments();
  el("q-supplier").focus();
});
