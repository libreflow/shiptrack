// Tests d'intégration DOM pour main.js : chargent le vrai index.html dans jsdom,
// mockent window.__TAURI__ (invoke/dialog) et testent le rendu + les interactions
// réelles (clic, changement de statut, sélection multiple, saisie rapide).
//
// main.js exécute du code au chargement du module (accès à window.__TAURI__,
// écoute DOMContentLoaded) : chaque test réimporte le module à froid
// (vi.resetModules) après avoir posé le DOM et les mocks, pour repartir d'un état
// propre à chaque fois.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const INDEX_HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf-8"
);
const BODY_HTML = INDEX_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];

function makeShipment(overrides = {}) {
  return {
    id: "id-1",
    supplier: "Vitrolles Aéro",
    material: "Écran Dell 24\"",
    tracking_number: "TRK123",
    carrier: "TNT",
    recipient: "Jean Dupont",
    status: "shipped",
    expected_date: "2026-01-15",
    received_date: null,
    notes: null,
    ...overrides,
  };
}

let invokeMock;

async function loadApp({ shipments = [], lateCount = 0, presetLocalStorage = {} } = {}) {
  // Repart d'un DOM propre à chaque test à partir du vrai fichier index.html.
  document.body.innerHTML = BODY_HTML;

  invokeMock = vi.fn(async (cmd) => {
    if (cmd === "list_shipments") return shipments;
    if (cmd === "count_late_shipments") return lateCount;
    if (cmd === "delete_shipment") return null;
    if (cmd === "update_shipment") return null;
    if (cmd === "create_shipment") return makeShipment({ id: "new-id" });
    return null;
  });

  window.__TAURI__ = {
    core: { invoke: invokeMock },
    dialog: { save: vi.fn(), open: vi.fn() },
    opener: { openUrl: vi.fn(async () => {}) },
  };
  window.matchMedia =
    window.matchMedia ||
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  window.confirm = vi.fn(() => true);
  localStorage.clear();
  for (const [key, value] of Object.entries(presetLocalStorage)) {
    localStorage.setItem(key, value);
  }

  // jsdom ne supporte pas <dialog>.showModal()/close() nativement : polyfill minimal.
  document.querySelectorAll("dialog").forEach((dialog) => {
    if (!dialog.showModal) {
      dialog.showModal = function () {
        this.setAttribute("open", "");
        this.open = true;
      };
    }
    if (!dialog.close) {
      dialog.close = function () {
        this.removeAttribute("open");
        this.open = false;
      };
    }
  });

  vi.resetModules();
  await import("../main.js");
  window.dispatchEvent(new window.Event("DOMContentLoaded"));
  // loadShipments() est asynchrone (await invoke) : laisse le microtask/render se dérouler.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("main.js — rendu du tableau (DOM réel)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("affiche une ligne par expédition chargée", async () => {
    await loadApp({ shipments: [makeShipment(), makeShipment({ id: "id-2", supplier: "Autre Agence" })] });
    const rows = document.querySelectorAll("#shipments-body tr[data-id]");
    expect(rows.length).toBe(2);
    expect(document.getElementById("row-count").textContent).toBe("2 / 2");
  });

  it("affiche un message vide quand aucune expédition", async () => {
    await loadApp({ shipments: [] });
    expect(document.querySelector("#shipments-body .empty")).toBeTruthy();
  });

  it("filtre par recherche texte en direct", async () => {
    await loadApp({
      shipments: [makeShipment({ supplier: "Vitrolles Aéro" }), makeShipment({ id: "id-2", supplier: "Serris" })],
    });
    const search = document.getElementById("search");
    search.value = "vitrolles";
    search.dispatchEvent(new window.Event("input"));
    await new Promise((r) => setTimeout(r, 200)); // debounce 150ms

    const rows = document.querySelectorAll("#shipments-body tr[data-id]");
    expect(rows.length).toBe(1);
    expect(document.getElementById("row-count").textContent).toBe("1 / 2");
  });

  it("affiche le badge retard quand count_late_shipments > 0", async () => {
    await loadApp({ shipments: [makeShipment()], lateCount: 3 });
    const badge = document.getElementById("late-badge");
    expect(badge.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toContain("3");
  });

  it("masque le badge retard quand count_late_shipments = 0", async () => {
    await loadApp({ shipments: [makeShipment()], lateCount: 0 });
    expect(document.getElementById("late-badge").classList.contains("hidden")).toBe(true);
  });
});

describe("main.js — cycle de statut au clic", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cliquer le badge de statut envoie update_shipment avec le statut suivant", async () => {
    await loadApp({ shipments: [makeShipment({ status: "shipped" })] });
    const btn = document.querySelector("[data-cycle-id]");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const updateCall = invokeMock.mock.calls.find((c) => c[0] === "update_shipment");
    expect(updateCall).toBeTruthy();
    expect(updateCall[1].shipment.status).toBe("received"); // shipped -> received (STATUS_CYCLE)
  });

  it("cliquer sur la ligne (hors badge) ouvre le dialog d'édition", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const row = document.querySelector("tr[data-id]");
    row.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250)); // délai anti-conflit avec le double-clic d'édition inline
    expect(document.getElementById("shipment-dialog").open).toBe(true);
    expect(document.getElementById("f-supplier").value).toBe("Vitrolles Aéro");
  });
});

describe("main.js — sélection multiple et actions groupées", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cocher une ligne affiche la barre d'actions groupées avec le bon compte", async () => {
    await loadApp({ shipments: [makeShipment(), makeShipment({ id: "id-2" })] });
    const cb = document.querySelector("[data-select-id]");
    cb.checked = true;
    cb.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(document.getElementById("bulk-bar").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("bulk-count").textContent).toBe("1 sélectionnée");
  });

  it("bulk-delete demande confirmation puis supprime chaque ligne sélectionnée", async () => {
    await loadApp({ shipments: [makeShipment(), makeShipment({ id: "id-2" })] });
    document.querySelectorAll("[data-select-id]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    });

    document.getElementById("bulk-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.confirm).toHaveBeenCalled();
    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === "delete_shipment");
    expect(deleteCalls.length).toBe(2);
  });

  it("bulk-delete n'appelle rien si l'utilisateur annule la confirmation", async () => {
    await loadApp({ shipments: [makeShipment()] });
    window.confirm = vi.fn(() => false);
    const cb = document.querySelector("[data-select-id]");
    cb.checked = true;
    cb.dispatchEvent(new window.Event("change", { bubbles: true }));

    document.getElementById("bulk-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === "delete_shipment");
    expect(deleteCalls.length).toBe(0);
  });
});

describe("main.js — saisie rapide", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refuse la soumission si agence ou matériel manquant", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "";
    document.getElementById("q-material").value = "";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const createCalls = invokeMock.mock.calls.filter((c) => c[0] === "create_shipment");
    expect(createCalls.length).toBe(0);
    expect(document.getElementById("toast").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("toast").classList.contains("error")).toBe(true);
  });

  it("soumet create_shipment avec les champs remplis", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Nouvelle Agence";
    document.getElementById("q-material").value = "Clavier";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const createCall = invokeMock.mock.calls.find((c) => c[0] === "create_shipment");
    expect(createCall).toBeTruthy();
    expect(createCall[1].shipment.supplier).toBe("Nouvelle Agence");
    expect(createCall[1].shipment.material).toBe("Clavier");
  });
});

describe("main.js — édition inline (double-clic cellule)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("double-clic sur une cellule affiche un input pré-rempli", async () => {
    await loadApp({ shipments: [makeShipment({ supplier: "Vitrolles Aéro" })] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));

    const input = cell.querySelector(".inline-edit-input");
    expect(input).toBeTruthy();
    expect(input.value).toBe("Vitrolles Aéro");
  });

  it("Entrée dans l'input inline envoie update_shipment avec la nouvelle valeur", async () => {
    await loadApp({ shipments: [makeShipment({ supplier: "Vitrolles Aéro" })] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "Nouvelle Valeur";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const updateCall = invokeMock.mock.calls.find((c) => c[0] === "update_shipment");
    expect(updateCall).toBeTruthy();
    expect(updateCall[1].shipment.supplier).toBe("Nouvelle Valeur");
  });

  it("Échap annule l'édition sans appeler update_shipment", async () => {
    await loadApp({ shipments: [makeShipment({ supplier: "Vitrolles Aéro" })] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "Autre chose";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const updateCalls = invokeMock.mock.calls.filter((c) => c[0] === "update_shipment");
    expect(updateCalls.length).toBe(0);
    expect(cell.querySelector(".inline-edit-input")).toBeFalsy();
    expect(cell.textContent).toBe("Vitrolles Aéro");
  });

  it("ne rien changer (même valeur) n'appelle pas update_shipment", async () => {
    await loadApp({ shipments: [makeShipment({ supplier: "Vitrolles Aéro" })] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const updateCalls = invokeMock.mock.calls.filter((c) => c[0] === "update_shipment");
    expect(updateCalls.length).toBe(0);
  });
});

describe("main.js — navigation clavier entre lignes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ArrowDown déplace le focus sur la ligne suivante", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1" }), makeShipment({ id: "id-2" })] });
    document.getElementById("q-supplier").blur();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const rows = [...document.querySelectorAll("#shipments-body tr[data-id]")];
    expect(rows[0].classList.contains("row-focused")).toBe(true);
  });

  it("Entrée sur une ligne focalisée ouvre le dialog d'édition", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1" })] });
    document.getElementById("q-supplier").blur();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(document.getElementById("shipment-dialog").open).toBe(true);
  });

  it("n'intercepte pas les flèches quand on tape dans un champ", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1" })] });
    document.getElementById("q-supplier").focus();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const rows = [...document.querySelectorAll("#shipments-body tr[data-id]")];
    expect(rows[0].classList.contains("row-focused")).toBe(false);
  });
});

describe("main.js — colonnes redimensionnables", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("shiptrack.columnWidths");
  });

  it("glisser une poignée de redimensionnement change la largeur de la colonne", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const handle = document.querySelector('th[data-col="supplier"] .col-resize-handle');
    const th = handle.closest("th");
    th.getBoundingClientRect = () => ({ width: 150 });
    if (!handle.setPointerCapture) handle.setPointerCapture = () => {};

    handle.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: 100, bubbles: true, pointerId: 1 }));
    handle.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 160, bubbles: true, pointerId: 1 }));
    handle.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 160, bubbles: true, pointerId: 1 }));

    const col = document.querySelector('#shipments-table col[data-col="supplier"]');
    expect(col.style.width).toBe("210px"); // 150 + (160 - 100)
  });

  it("la largeur redimensionnée est persistée en localStorage", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const handle = document.querySelector('th[data-col="supplier"] .col-resize-handle');
    const th = handle.closest("th");
    th.getBoundingClientRect = () => ({ width: 150 });
    if (!handle.setPointerCapture) handle.setPointerCapture = () => {};

    handle.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: 100, bubbles: true, pointerId: 1 }));
    handle.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 200, bubbles: true, pointerId: 1 }));
    handle.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 200, bubbles: true, pointerId: 1 }));

    const stored = JSON.parse(localStorage.getItem("shiptrack.columnWidths"));
    expect(stored.supplier).toBe(250);
  });

  it("ne descend jamais sous la largeur minimale", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const handle = document.querySelector('th[data-col="supplier"] .col-resize-handle');
    const th = handle.closest("th");
    th.getBoundingClientRect = () => ({ width: 150 });
    if (!handle.setPointerCapture) handle.setPointerCapture = () => {};

    handle.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: 100, bubbles: true, pointerId: 1 }));
    handle.dispatchEvent(new window.PointerEvent("pointermove", { clientX: -500, bubbles: true, pointerId: 1 }));

    const col = document.querySelector('#shipments-table col[data-col="supplier"]');
    expect(parseInt(col.style.width, 10)).toBe(50); // MIN_COLUMN_WIDTH
  });

  it("une largeur stockée est réappliquée au rechargement de l'app", async () => {
    await loadApp({
      shipments: [makeShipment()],
      presetLocalStorage: { "shiptrack.columnWidths": JSON.stringify({ material: 300 }) },
    });

    const col = document.querySelector('#shipments-table col[data-col="material"]');
    expect(col.style.width).toBe("300px");
  });

  it("cliquer sur la poignée ne déclenche pas le tri de la colonne", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const handle = document.querySelector('th[data-col="supplier"] .col-resize-handle');
    const before = document.querySelector('th[data-sort="supplier"]').classList.contains("sort-asc");
    handle.dispatchEvent(new window.Event("click", { bubbles: true }));
    const after = document.querySelector('th[data-sort="supplier"]').classList.contains("sort-asc");
    expect(after).toBe(before);
  });
});

describe("main.js — filtre technicien (barre 'Traité par')", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cliquer un bouton technicien filtre le tableau sur ce technicien", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
      ],
    });
    const btn = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(document.getElementById("row-count").textContent).toBe("1 / 2");
    const rows = [...document.querySelectorAll("#shipments-body tr[data-id]")];
    expect(rows.map((r) => r.dataset.id)).toEqual(["id-1"]);
  });

  it("recliquer sur le même bouton désactive le filtre (mais garde la présélection)", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
      ],
    });
    const findBtn = () => [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    findBtn().dispatchEvent(new window.Event("click", { bubbles: true }));
    findBtn().dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(document.getElementById("row-count").textContent).toBe("2 / 2");
    const btn = findBtn();
    expect(btn.classList.contains("active")).toBe(true); // toujours présélectionné pour la saisie
    expect(btn.classList.contains("filter-active")).toBe(false);
  });

  it("le bouton Réinitialiser désactive aussi le filtre technicien", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
      ],
    });
    const btn = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    document.getElementById("btn-reset-filters").dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(document.getElementById("row-count").textContent).toBe("2 / 2");
  });
});

describe("main.js — lien de suivi 17TRACK", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("affiche un bouton de suivi quand un numéro de suivi est présent", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const btn = document.querySelector("[data-track-id]");
    expect(btn).toBeTruthy();
  });

  it("n'affiche pas de bouton de suivi quand le numéro est vide", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: null })] });
    const btn = document.querySelector("[data-track-id]");
    expect(btn).toBeFalsy();
  });

  it("cliquer le bouton ouvre l'URL 17TRACK correcte sans appeler invoke", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const btn = document.querySelector("[data-track-id]");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.__TAURI__.opener.openUrl).toHaveBeenCalledWith(
      "https://t.17track.net/fr#nums=8117777435649222"
    );
    const invokeCalls = invokeMock.mock.calls.filter((c) => c[0] !== "list_shipments" && c[0] !== "count_late_shipments");
    expect(invokeCalls.length).toBe(0);
  });

  it("cliquer le bouton de suivi n'ouvre pas le dialog d'édition ni l'édition inline", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const btn = document.querySelector("[data-track-id]");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    expect(document.getElementById("shipment-dialog").open).toBe(false);
  });

  it("le dialog d'édition affiche le bouton de suivi quand un numéro est présent", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const row = document.querySelector("tr[data-id]");
    row.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    expect(document.getElementById("f-tracking-link").classList.contains("hidden")).toBe(false);
  });

  it("le dialog masque le bouton de suivi si le numéro est vide", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: null })] });
    const row = document.querySelector("tr[data-id]");
    row.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    expect(document.getElementById("f-tracking-link").classList.contains("hidden")).toBe(true);
  });
});

describe("main.js — thème clair/sombre", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("le bouton bascule data-theme et persiste en localStorage", async () => {
    await loadApp({ shipments: [] });
    const before = document.documentElement.dataset.theme;
    document.getElementById("btn-theme-toggle").dispatchEvent(new window.Event("click", { bubbles: true }));
    const after = document.documentElement.dataset.theme;

    expect(after).not.toBe(before);
    expect(localStorage.getItem("shiptrack.theme")).toBe(after);
  });
});
