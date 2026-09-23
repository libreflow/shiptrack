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
// Chaque test recharge main.js à froid (vi.resetModules + re-import) pour
// repartir d'un état module propre, mais window/document sont partagés par
// TOUT le fichier de test (jsdom n'est recréé qu'une fois par fichier, pas
// par test). Sans nettoyage, les listeners document/window de l'instance de
// module précédente restent attachés et peuvent interférer (leur closure
// référence un ancien `selectedIds`/`allShipments` périmé). On les traque et
// on les retire avant chaque rechargement.
let trackedListeners = [];
function trackListenersOn(target) {
  const original = target.addEventListener.bind(target);
  target.addEventListener = (...args) => {
    trackedListeners.push([target, args]);
    return original(...args);
  };
}
function clearTrackedListeners() {
  for (const [target, args] of trackedListeners) {
    target.removeEventListener(...args);
  }
  trackedListeners = [];
}

async function loadApp({ shipments = [], presetLocalStorage = {} } = {}) {
  clearTrackedListeners();
  // Repart d'un DOM propre à chaque test à partir du vrai fichier index.html.
  document.body.innerHTML = BODY_HTML;
  trackListenersOn(window);
  trackListenersOn(document);

  invokeMock = vi.fn(async (cmd) => {
    if (cmd === "list_shipments") return shipments;
    if (cmd === "delete_shipment") return null;
    if (cmd === "update_shipment") return null;
    if (cmd === "create_shipment") return makeShipment({ id: "new-id" });
    return null;
  });

  window.__TAURI__ = {
    core: { invoke: invokeMock },
    dialog: { save: vi.fn(), open: vi.fn() },
    opener: { openUrl: vi.fn(async () => {}) },
    clipboardManager: { writeText: vi.fn(async () => {}) },
  };
  window.matchMedia =
    window.matchMedia ||
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
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

  // Régression : le bouton "✕ effacer" se basait sur el("search").value brut,
  // mais le filtrage réel applique .trim() (une recherche uniquement composée
  // d'espaces est traitée comme vide). Le bouton apparaissait donc alors
  // qu'aucun filtre n'était réellement actif.
  it("le bouton effacer la recherche reste masqué pour une recherche composée uniquement d'espaces", async () => {
    await loadApp({ shipments: [makeShipment()] });
    document.getElementById("search").value = "   ";
    document.getElementById("search").dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    expect(document.getElementById("search-clear").classList.contains("hidden")).toBe(true);
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

  // Régression : un clic sur une VRAIE cellule de données (data-field —
  // Agence, Matériel, N° suivi, Transporteur, Destinataire, dates, soit 7
  // colonnes sur 9) n'ouvrait JAMAIS le dialog avant ce fix : seules les
  // colonnes checkbox/statut/icône crayon (36px) fonctionnaient, alors que le
  // tooltip promettait "Cliquer la ligne pour tout modifier". Un simple clic
  // (pas un double-clic) sur une cellule data-field doit ouvrir le dialog.
  it("cliquer une seule fois sur une cellule data-field (ex: Agence) ouvre aussi le dialog", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("click", { bubbles: true, detail: 1 }));
    await new Promise((r) => setTimeout(r, 250));
    expect(document.getElementById("shipment-dialog").open).toBe(true);
  });

  // Le double-clic sur une cellule data-field doit toujours déclencher
  // l'édition inline, PAS le dialog — le fix ci-dessus ne doit pas casser ça.
  it("double-cliquer sur une cellule data-field déclenche l'édition inline, pas le dialog", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("click", { bubbles: true, detail: 1 }));
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    expect(document.getElementById("shipment-dialog").open).toBe(false);
    expect(cell.querySelector(".inline-edit-input")).toBeTruthy();
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

  // Régression : "Tout sélectionner" ne cochait que les lignes RENDUES à
  // l'écran (limitées par la pagination PAGE_SIZE=150), pas toutes les lignes
  // qui correspondent au filtre actuel — malgré son nom. Avec plus de lignes
  // filtrées que la page courante, l'utilisateur croyait avoir tout sélectionné
  // (et pouvait supprimer en masse) alors qu'il en restait de côté.
  it("'Tout sélectionner' sélectionne toutes les lignes filtrées, pas seulement celles rendues (pagination)", async () => {
    const shipments = Array.from({ length: 200 }, (_, i) => makeShipment({ id: `id-${i}` }));
    await loadApp({ shipments });

    const selectAll = document.getElementById("select-all-checkbox");
    selectAll.checked = true;
    selectAll.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(document.getElementById("bulk-count").textContent).toBe("200 sélectionnées");
  });

  it("'Tout sélectionner' redevient coché même après pagination (Charger plus)", async () => {
    const shipments = Array.from({ length: 200 }, (_, i) => makeShipment({ id: `id-${i}` }));
    await loadApp({ shipments });

    const selectAll = document.getElementById("select-all-checkbox");
    selectAll.checked = true;
    selectAll.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
  });

  // Régression : la sélection n'était purgée que des lignes SUPPRIMÉES de la
  // base, pas de celles simplement masquées par un changement de filtre.
  // La barre d'actions groupées pouvait donc afficher "N sélectionnées" en
  // comptant des lignes invisibles à l'écran (filtrées hors vue) — un clic
  // sur "Supprimer" les aurait affectées sans que l'utilisateur les voie.
  it("changer le filtre statut retire de la sélection les lignes qui sortent de la vue", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", status: "shipped" }),
        makeShipment({ id: "id-2", status: "ordered" }),
      ],
    });
    document.querySelectorAll("[data-select-id]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(document.getElementById("bulk-count").textContent).toBe("2 sélectionnées");

    document.querySelector('[data-stat-status="shipped"]').dispatchEvent(new window.Event("click", { bubbles: true })); // masque id-2

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

    expect(document.getElementById("confirm-dialog").open).toBe(true);
    document.getElementById("confirm-dialog-ok").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === "delete_shipment");
    expect(deleteCalls.length).toBe(2);
  });

  it("bulk-delete n'appelle rien si l'utilisateur annule la confirmation", async () => {
    await loadApp({ shipments: [makeShipment()] });
    const cb = document.querySelector("[data-select-id]");
    cb.checked = true;
    cb.dispatchEvent(new window.Event("change", { bubbles: true }));

    document.getElementById("bulk-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById("confirm-dialog-cancel").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === "delete_shipment");
    expect(deleteCalls.length).toBe(0);
  });

  // Régression : bulkSetStatus avalait les erreurs individuelles (try/catch
  // silencieux) et affichait toujours "N mise(s) à jour" même en cas d'échec
  // partiel, contrairement à bulkDelete qui compte et signale les échecs.
  it("bulk statut signale les échecs partiels au lieu d'afficher un faux succès", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", status: "shipped" }), makeShipment({ id: "id-2", status: "ordered" })],
    });
    let call = 0;
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "list_shipments")
        return [
          makeShipment({ id: "id-1", status: "shipped" }),
          makeShipment({ id: "id-2", status: "ordered" }),
        ];
      if (cmd === "update_shipment") {
        call++;
        if (call === 2) throw "simulated failure";
        return null;
      }
      return null;
    });

    document.querySelectorAll("[data-select-id]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    document.querySelector('[data-bulk-status="received"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById("confirm-dialog-ok").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById("toast").classList.contains("error")).toBe(true);
    expect(document.getElementById("toast-message").textContent).toContain("échec");
  });

  it("bulk statut affiche un succès normal quand tout réussit", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", status: "shipped" }), makeShipment({ id: "id-2", status: "ordered" })],
    });
    document.querySelectorAll("[data-select-id]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    document.querySelector('[data-bulk-status="received"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById("confirm-dialog-ok").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById("toast").classList.contains("error")).toBe(false);
    expect(document.getElementById("toast-message").textContent).toBe("2 expédition(s) mise(s) à jour");
  });
});

describe("main.js — champ 'Date reçue' du dialog selon le statut", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Régression : le backend (update_shipment_impl côté Rust) efface
  // silencieusement received_date si le statut n'est pas received/verified.
  // Sans garde-fou côté UI, l'utilisateur pouvait saisir une date dans
  // "Date reçue" avec un statut "Commandé"/"Expédié", cliquer Enregistrer,
  // et voir sa saisie disparaître sans aucun message.
  it("le champ Date reçue est masqué/désactivé quand le statut ne l'autorise pas", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", status: "shipped", received_date: null })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    expect(document.getElementById("received-row").classList.contains("hidden")).toBe(true);
    expect(document.getElementById("f-received").disabled).toBe(true);
  });

  it("le champ Date reçue redevient visible/actif dès que le statut passe à Reçu", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", status: "shipped", received_date: null })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    document.getElementById("f-status").value = "received";
    document.getElementById("f-status").dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(document.getElementById("received-row").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("f-received").disabled).toBe(false);
  });

  it("changer le statut vers un état qui n'autorise pas la date reçue vide le champ dans l'UI", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", status: "received", received_date: "2026-01-20" })],
    });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    expect(document.getElementById("f-received").value).toBe("2026-01-20");

    document.getElementById("f-status").value = "shipped";
    document.getElementById("f-status").dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(document.getElementById("f-received").value).toBe("");
  });
});


describe("main.js — avertissement de doublon dans le dialog complet", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Régression : l'avertissement "déjà utilisé" n'existait que sur la saisie
  // rapide (checkDuplicateTracking). Le dialog complet d'édition n'avait
  // aucun avertissement, alors que c'est le même risque de doublon.
  it("affiche l'avertissement quand on tape un n° de suivi déjà utilisé par une autre ligne", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", tracking_number: "TRK1" }),
        makeShipment({ id: "id-2", tracking_number: "TRK2" }),
      ],
    });
    document.querySelector('tr[data-id="id-2"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    document.getElementById("f-tracking").value = "TRK1";
    document.getElementById("f-tracking").dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(document.getElementById("f-duplicate-warning").classList.contains("hidden")).toBe(false);
  });

  it("n'affiche pas l'avertissement pour le propre n° de suivi de la ligne éditée", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", tracking_number: "TRK1" })],
    });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    // Le champ contient déjà TRK1 (sa propre valeur) à l'ouverture : pas de faux positif.
    expect(document.getElementById("f-duplicate-warning").classList.contains("hidden")).toBe(true);
  });

  it("masque l'avertissement une fois le champ vidé", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", tracking_number: "TRK1" }),
        makeShipment({ id: "id-2", tracking_number: "TRK2" }),
      ],
    });
    document.querySelector('tr[data-id="id-2"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    document.getElementById("f-tracking").value = "TRK1";
    document.getElementById("f-tracking").dispatchEvent(new window.Event("input", { bubbles: true }));
    document.getElementById("f-tracking").value = "";
    document.getElementById("f-tracking").dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(document.getElementById("f-duplicate-warning").classList.contains("hidden")).toBe(true);
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

  // Régression : vider un champ requis (Agence/Matériel) via l'édition inline
  // envoyait null directement à update_shipment sans validation côté client,
  // provoquant une erreur SQL brute ("NOT NULL constraint failed...") au lieu
  // du message clair utilisé partout ailleurs dans l'app.
  it("vider le champ Agence refuse la sauvegarde avec un message clair (pas d'appel update_shipment)", async () => {
    await loadApp({ shipments: [makeShipment({ supplier: "Vitrolles Aéro" })] });
    const cell = document.querySelector('[data-field="supplier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const updateCalls = invokeMock.mock.calls.filter((c) => c[0] === "update_shipment");
    expect(updateCalls.length).toBe(0);
    expect(document.getElementById("toast").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("toast").classList.contains("error")).toBe(true);
    expect(document.getElementById("toast-message").textContent).toContain("Agence");
  });

  it("vider le champ Matériel refuse la sauvegarde avec un message clair (pas d'appel update_shipment)", async () => {
    await loadApp({ shipments: [makeShipment({ material: "Écran Dell" })] });
    const cell = document.querySelector('[data-field="material"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "   "; // uniquement des espaces = équivalent vide
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    const updateCalls = invokeMock.mock.calls.filter((c) => c[0] === "update_shipment");
    expect(updateCalls.length).toBe(0);
    expect(document.getElementById("toast-message").textContent).toContain("Matériel");
  });

  it("vider un champ non requis (Destinataire) est accepté normalement", async () => {
    await loadApp({ shipments: [makeShipment({ recipient: "Jean Dupont" })] });
    const cell = document.querySelector('[data-field="recipient"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const updateCall = invokeMock.mock.calls.find((c) => c[0] === "update_shipment");
    expect(updateCall).toBeTruthy();
    expect(updateCall[1].shipment.recipient).toBeNull();
  });

  // Régression : le <select> d'édition inline du transporteur n'avait que les
  // options TNT/DPD/— ; une valeur historique en base (ex: "Colissimo", saisie
  // avant le verrouillage TNT/DPD) tombait silencieusement sur "" à l'ouverture
  // faute d'option correspondante, risquant d'effacer la valeur au premier Entrée.
  it("éditer un transporteur avec une valeur historique hors TNT/DPD la préserve dans le select", async () => {
    await loadApp({ shipments: [makeShipment({ carrier: "Colissimo" })] });
    const cell = document.querySelector('[data-field="carrier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const select = cell.querySelector(".inline-edit-input");

    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("Colissimo");
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
    expect(btn.classList.contains("preselected")).toBe(true); // toujours présélectionné pour la saisie
    expect(btn.classList.contains("active")).toBe(false); // mais plus "actif" comme filtre
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

  it("le bouton 'Tous' est actif par défaut et affiche toutes les expéditions sans filtre technicien", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
        makeShipment({ id: "id-3", notes: null }),
      ],
    });
    const allBtn = document.querySelector("[data-tech-all]");
    expect(allBtn.classList.contains("active")).toBe(true);
    expect(document.getElementById("row-count").textContent).toBe("3 / 3");
  });

  it("cliquer 'Tous' après avoir filtré sur un technicien réaffiche toutes les lignes", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
      ],
    });
    const julieBtn = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    julieBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(document.getElementById("row-count").textContent).toBe("1 / 2");

    document.querySelector("[data-tech-all]").dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(document.getElementById("row-count").textContent).toBe("2 / 2");
    expect(document.querySelector("[data-tech-all]").classList.contains("active")).toBe(true);
    // Le technicien reste présélectionné pour la saisie rapide (classe "active"),
    // mais son filtrage est bien désactivé (pas de "filter-active").
    const julieBtnAfter = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    expect(julieBtnAfter.classList.contains("filter-active")).toBe(false);
  });

  // Régression : julie et "Tous" apparaissaient TOUS LES DEUX avec le style
  // "actif" (fond plein bleu) après être passé de julie à Tous, car "active"
  // servait à la fois pour "c'est le filtre en cours" et "c'est juste
  // présélectionné pour la saisie" — les deux boutons semblaient allumés en
  // même temps, trompeur pour l'utilisateur.
  it("après être passé d'un technicien à 'Tous', un seul bouton a le style de filtre actif à la fois", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
      ],
    });
    const julieBtn = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    julieBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    document.querySelector("[data-tech-all]").dispatchEvent(new window.Event("click", { bubbles: true }));

    const activeButtons = [...document.querySelectorAll(".tech-btn.active")];
    expect(activeButtons).toHaveLength(1);
    expect(activeButtons[0].dataset.techAll).toBeDefined();

    const julieBtnAfter = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    expect(julieBtnAfter.classList.contains("active")).toBe(false);
    expect(julieBtnAfter.classList.contains("preselected")).toBe(true);
  });
});

describe("main.js — copie du numéro de suivi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("affiche le numéro comme un bouton cliquable quand un tracking_number est présent", () => {
    return loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] }).then(() => {
      const btn = document.querySelector("[data-copy-id]");
      expect(btn).toBeTruthy();
      expect(btn.textContent).toBe("8117777435649222");
      expect(btn.tagName).toBe("BUTTON");
    });
  });

  it("n'affiche pas de bouton copier quand le numéro est vide", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: null })] });
    expect(document.querySelector("[data-copy-id]")).toBeFalsy();
  });

  it("cliquer le numéro copie sa valeur dans le presse-papier via writeText", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const btn = document.querySelector("[data-copy-id]");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(window.__TAURI__.clipboardManager.writeText).toHaveBeenCalledWith("8117777435649222");
  });

  it("cliquer le numéro affiche un toast de confirmation", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const btn = document.querySelector("[data-copy-id]");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById("toast").classList.contains("hidden")).toBe(false);
    expect(document.getElementById("toast-message").textContent).toContain("8117777435649222");
  });

  it("cliquer le numéro n'ouvre ni le dialog d'édition ni l'édition inline", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const btn = document.querySelector("[data-copy-id]");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    expect(document.getElementById("shipment-dialog").open).toBe(false);
    expect(document.querySelector(".inline-edit-input")).toBeFalsy();
  });

  it("le bouton copier et le bouton de suivi coexistent sur la même cellule", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "8117777435649222" })] });
    const cell = document.querySelector('[data-field="tracking_number"]');
    expect(cell.querySelector("[data-copy-id]")).toBeTruthy();
    expect(cell.querySelector("[data-track-id]")).toBeTruthy();
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
    const invokeCalls = invokeMock.mock.calls.filter((c) => c[0] !== "list_shipments");
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

  // Régression : le bouton de suivi s'affichait pour N'IMPORTE QUEL texte non
  // vide dans tracking_number, y compris du texte libre historique ("tnt",
  // "à programmer", artefacts d'export "_x000D_") — 207 lignes réelles
  // concernées en base. Cliquer dessus ouvrait 17TRACK avec une requête sans
  // sens. Le bouton ne doit apparaître QUE pour un vrai numéro TNT/DPD.
  it("n'affiche PAS de bouton de suivi pour du texte libre historique (tableau)", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "tnt" })] });
    expect(document.querySelector("[data-track-id]")).toBeFalsy();
    // Le bouton copier, lui, doit rester présent : le texte reste consultable/copiable.
    expect(document.querySelector("[data-copy-id]")).toBeTruthy();
  });

  it("n'affiche PAS de bouton de suivi pour 'Non sécurisé' (tableau)", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: "Non sécurisé" })] });
    expect(document.querySelector("[data-track-id]")).toBeFalsy();
  });

  it("n'affiche PAS de lien de suivi dans le dialog pour du texte libre historique", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", tracking_number: "à programmer" })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    expect(document.getElementById("f-tracking-link").classList.contains("hidden")).toBe(true);
  });
});

describe("main.js — regroupement par mois", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Régression historique (contexte retiré depuis : le concept "en retard" a
  // été supprimé de l'app car devenu du bruit permanent en usage réel) :
  // le regroupement par mois doit continuer à fonctionner sans planter.
  it("activer 'Grouper par mois' regroupe correctement les lignes sans planter", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", expected_date: "2020-01-15", status: "shipped" }),
        makeShipment({ id: "id-2", expected_date: "2020-01-20", status: "ordered" }),
      ],
    });

    document.getElementById("group-by-month").checked = true;
    document.getElementById("group-by-month").dispatchEvent(new window.Event("change", { bubbles: true }));

    const monthHeader = document.querySelector(".month-header-row");
    expect(monthHeader).toBeTruthy();
    expect(document.querySelector(".month-count").textContent).toBe("2");
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

// Suite dédiée : invariants du système de filtres qui doivent rester vrais
// quelle que soit la combinaison de filtres appliquée, pour empêcher la
// classe de bugs découverte pendant l'audit (compteurs incohérents avec
// l'affichage réel, deux boutons "actifs" en même temps, sélection fantôme).
describe("main.js — cohérence du système de filtres (invariants)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function countVisibleRows() {
    return document.querySelectorAll("#shipments-body tr[data-id]").length;
  }

  function rowCountFirstNumber() {
    return parseInt(document.getElementById("row-count").textContent.split("/")[0].trim(), 10);
  }

  it("le premier nombre du compteur correspond toujours au nombre de lignes réellement affichées", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", status: "shipped", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", status: "ordered", notes: "Traité par: Amine" }),
        makeShipment({ id: "id-3", status: "shipped", notes: null }),
      ],
    });

    // Aucun filtre.
    expect(rowCountFirstNumber()).toBe(countVisibleRows());

    // Filtre statut seul.
    document.querySelector('[data-stat-status="shipped"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(rowCountFirstNumber()).toBe(countVisibleRows());

    // Filtre statut + technicien cumulés.
    const julieBtn = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    julieBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(rowCountFirstNumber()).toBe(countVisibleRows());

    // Retour à Tous : le filtre statut reste, le technicien part.
    document.querySelector("[data-tech-all]").dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(rowCountFirstNumber()).toBe(countVisibleRows());

    // Réinitialisation complète.
    document.getElementById("btn-reset-filters").dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(rowCountFirstNumber()).toBe(countVisibleRows());
    expect(rowCountFirstNumber()).toBe(3);
  });

  it("jamais plus d'un bouton technicien n'a le style de filtre actif à la fois, quelle que soit la séquence de clics", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", notes: "Traité par: Amine" }),
      ],
    });

    const clickTech = (name) =>
      [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === name)?.dispatchEvent(
        new window.Event("click", { bubbles: true })
      );
    const clickAll = () =>
      document.querySelector("[data-tech-all]").dispatchEvent(new window.Event("click", { bubbles: true }));

    const sequence = [() => clickTech("julie"), clickAll, () => clickTech("Amine"), () => clickTech("Amine"), clickAll];
    for (const action of sequence) {
      action();
      const activeButtons = document.querySelectorAll(".tech-btn.active");
      expect(activeButtons.length).toBe(1);
    }
  });

  it("le compteur d'actions groupées ne compte jamais une ligne masquée par le filtre actuel", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", status: "shipped" }),
        makeShipment({ id: "id-2", status: "ordered" }),
        makeShipment({ id: "id-3", status: "shipped" }),
      ],
    });

    document.querySelectorAll("[data-select-id]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    });

    document.querySelector('[data-stat-status="shipped"]').dispatchEvent(new window.Event("click", { bubbles: true }));

    const bulkCountText = document.getElementById("bulk-count").textContent;
    const selectedCount = parseInt(bulkCountText, 10);
    expect(selectedCount).toBeLessThanOrEqual(countVisibleRows());
  });

  it("réinitialiser les filtres réaffiche systématiquement 100% des expéditions chargées", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", status: "shipped", notes: "Traité par: julie" }),
        makeShipment({ id: "id-2", status: "ordered", notes: null }),
        makeShipment({ id: "id-3", status: "received", notes: "Traité par: Amine" }),
      ],
    });

    document.getElementById("search").value = "inexistant";
    document.getElementById("search").dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('[data-stat-status="shipped"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    const julieBtn = [...document.querySelectorAll(".tech-btn")].find((b) => b.dataset.tech === "julie");
    julieBtn.dispatchEvent(new window.Event("click", { bubbles: true }));

    document.getElementById("btn-reset-filters").dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(document.getElementById("row-count").textContent).toBe("3 / 3");
    expect(countVisibleRows()).toBe(3);
    expect(document.querySelector("[data-tech-all]").classList.contains("active")).toBe(true);
  });
});

describe("main.js — validation du n° de suivi (texte libre interdit)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("affiche 'À éditer' pour une ligne sans n° de suivi", async () => {
    await loadApp({ shipments: [makeShipment({ tracking_number: null })] });
    const cell = document.querySelector('[data-field="tracking_number"]');
    expect(cell.textContent).toBe("À éditer");
  });

  it("la saisie rapide refuse un texte libre en n° de suivi", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Voiron";
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-tracking").value = "annuler";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).not.toHaveBeenCalledWith("create_shipment", expect.anything());
  });

  it("la saisie rapide accepte 'Non sécurisé'", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Voiron";
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-tracking").value = "Non sécurisé";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith(
      "create_shipment",
      expect.objectContaining({ shipment: expect.objectContaining({ tracking_number: "Non sécurisé" }) })
    );
  });

  it("la saisie rapide accepte un numéro conforme", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Voiron";
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-tracking").value = "6917777419334322";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith(
      "create_shipment",
      expect.objectContaining({ shipment: expect.objectContaining({ tracking_number: "6917777419334322" }) })
    );
  });

  it("le dialog complet refuse un texte libre en n° de suivi", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1" })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    document.getElementById("f-tracking").value = "à programmer";
    document.getElementById("shipment-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(document.getElementById("shipment-dialog").open).toBe(true); // reste ouvert, refusé
  });

  it("l'édition inline refuse un texte libre en n° de suivi", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", tracking_number: "6917777419334322" })] });
    const cell = document.querySelector('[data-field="tracking_number"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "tnt exploit";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).not.toHaveBeenCalledWith("update_shipment", expect.anything());
  });

  it("l'édition inline accepte de vider le champ (À éditer)", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", tracking_number: "6917777419334322" })] });
    const cell = document.querySelector('[data-field="tracking_number"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    input.value = "";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith(
      "update_shipment",
      expect.objectContaining({ shipment: expect.objectContaining({ tracking_number: null }) })
    );
  });
});

describe("main.js — affichage des dates au format français", () => {
  it("affiche les dates prévue/reçue au format JJ/MM/AAAA dans le tableau", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", expected_date: "2026-03-05", received_date: "2026-12-31" })],
    });
    expect(document.querySelector('[data-field="expected_date"]').textContent).toBe("05/03/2026");
    expect(document.querySelector('[data-field="received_date"]').textContent).toBe("31/12/2026");
  });

  it("l'édition inline d'une date affichée en FR envoie toujours l'ISO au backend", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", expected_date: "2026-03-05", received_date: null, status: "shipped" })],
    });
    const cell = document.querySelector('[data-field="expected_date"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const input = cell.querySelector(".inline-edit-input");
    expect(input.type).toBe("date");
    expect(input.value).toBe("2026-03-05"); // toujours ISO, jamais le texte affiché

    input.value = "2026-04-10";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith(
      "update_shipment",
      expect.objectContaining({ shipment: expect.objectContaining({ expected_date: "2026-04-10" }) })
    );
  });
});

describe("main.js — déduction du transporteur (TNT par défaut)", () => {
  it("affiche TNT déduit quand carrier est vide et le n° de suivi est numérique", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", carrier: null, tracking_number: "6917777327189028" })],
    });
    const cell = document.querySelector('[data-field="carrier"]');
    expect(cell.textContent).toBe("TNT");
    expect(cell.classList.contains("carrier-inferred")).toBe(true);
  });

  it("n'affiche rien de déduit pour 'Non sécurisé' (ambigu TNT/DPD)", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", carrier: null, tracking_number: "Non sécurisé" })],
    });
    const cell = document.querySelector('[data-field="carrier"]');
    expect(cell.textContent).toBe("");
  });

  it("le transporteur explicite reste prioritaire sur la déduction", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", carrier: "DPD", tracking_number: "6917777327189028" })],
    });
    const cell = document.querySelector('[data-field="carrier"]');
    expect(cell.textContent).toBe("DPD");
    expect(cell.classList.contains("carrier-inferred")).toBe(false);
  });

  it("l'édition inline d'un transporteur déduit part vide, n'écrase pas silencieusement", async () => {
    await loadApp({
      shipments: [makeShipment({ id: "id-1", carrier: null, tracking_number: "6917777327189028" })],
    });
    const cell = document.querySelector('[data-field="carrier"]');
    cell.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
    const select = cell.querySelector("select");
    expect(select.value).toBe(""); // pas "TNT" — la déduction n'est qu'un affichage
  });
});

describe("main.js — avertissement de faute de frappe probable sur l'agence", () => {
  it("la saisie rapide avertit quand l'agence ressemble à une agence existante", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", supplier: "Bollene" })] });
    const input = document.getElementById("q-supplier");
    const warning = document.getElementById("q-supplier-warning");

    input.value = "Bolllene";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(warning.classList.contains("hidden")).toBe(false);
    expect(warning.textContent).toContain("Bollene");
  });

  it("la saisie rapide n'avertit pas pour une valeur identique ou une agence légitimement nouvelle", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", supplier: "Bollene" })] });
    const input = document.getElementById("q-supplier");
    const warning = document.getElementById("q-supplier-warning");

    input.value = "Bollene";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(warning.classList.contains("hidden")).toBe(true);

    input.value = "Toute Nouvelle Agence";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(warning.classList.contains("hidden")).toBe(true);
  });

  it("le dialog complet avertit aussi sur une faute de frappe probable", async () => {
    await loadApp({
      shipments: [
        makeShipment({ id: "id-1", supplier: "Bollene" }),
        makeShipment({ id: "id-2", supplier: "Voiron" }),
      ],
    });
    document.querySelector('tr[data-id="id-2"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    const input = document.getElementById("f-supplier");
    const warning = document.getElementById("f-supplier-warning");
    input.value = "Bolllene";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(warning.classList.contains("hidden")).toBe(false);
    expect(warning.textContent).toContain("Bollene");
  });

  it("ne se compare jamais à sa propre valeur en édition (pas de faux avertissement sur soi-même)", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", supplier: "Bollene" })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    const warning = document.getElementById("f-supplier-warning");
    expect(warning.classList.contains("hidden")).toBe(true);
  });

  it("l'avertissement se réinitialise après validation de la saisie rapide", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1", supplier: "Bollene" })] });
    const input = document.getElementById("q-supplier");
    const warning = document.getElementById("q-supplier-warning");
    input.value = "Bolllene";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(warning.classList.contains("hidden")).toBe(false);

    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(warning.classList.contains("hidden")).toBe(true);
  });
});

describe("main.js — ligne de saisie rapide : statut simplifié (Expédié par défaut)", () => {
  it("n'affiche plus les 4 boutons de statut, seulement un badge statique 'Expédié'", async () => {
    await loadApp({ shipments: [] });
    expect(document.querySelectorAll(".status-pill-btn").length).toBe(0);
    expect(document.getElementById("quick-status-pills")).toBeNull();

    const badge = document.querySelector("#quick-add-row .status-pill");
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("Expédié");
  });

  it("toute nouvelle expédition est créée avec le statut 'Expédié'", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Voiron";
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith(
      "update_shipment",
      expect.objectContaining({ shipment: expect.objectContaining({ status: "shipped" }) })
    );
  });
});

describe("main.js — dialog de confirmation (remplace window.confirm)", () => {
  it("supprimer une expédition depuis le dialog complet demande confirmation via le nouveau dialog", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1" })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    document.getElementById("btn-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById("confirm-dialog").open).toBe(true);

    document.getElementById("confirm-dialog-ok").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith("delete_shipment", expect.objectContaining({ id: "id-1" }));
  });

  it("annuler la confirmation de suppression n'efface rien", async () => {
    await loadApp({ shipments: [makeShipment({ id: "id-1" })] });
    document.querySelector('tr[data-id="id-1"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    document.getElementById("btn-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById("confirm-dialog-cancel").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).not.toHaveBeenCalledWith("delete_shipment", expect.anything());
    // Le dialog d'édition reste ouvert : l'annulation n'a fermé que la confirmation.
    expect(document.getElementById("shipment-dialog").open).toBe(true);
  });

  it("fermer le dialog de confirmation via l'événement close (Échap) équivaut à annuler", async () => {
    await loadApp({ shipments: [makeShipment(), makeShipment({ id: "id-2" })] });
    document.querySelectorAll("[data-select-id]").forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    document.getElementById("bulk-delete").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    // Simule Échap : le <dialog> émet "close" nativement, pas un clic sur un bouton.
    document.getElementById("confirm-dialog").dispatchEvent(new window.Event("close"));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).not.toHaveBeenCalledWith("delete_shipment", expect.anything());
  });
});

describe("main.js — feedback visuel sur champ en erreur (markFieldInvalid)", () => {
  it("marque le champ Agence en erreur si vide à la soumission de la saisie rapide", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(document.getElementById("q-supplier").classList.contains("field-invalid")).toBe(true);
  });

  it("retire le marquage d'erreur dès que l'utilisateur retape dans le champ", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-submit").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.getElementById("q-supplier").classList.contains("field-invalid")).toBe(true);

    const supplierInput = document.getElementById("q-supplier");
    supplierInput.value = "V";
    supplierInput.dispatchEvent(new window.Event("input", { bubbles: true }));

    expect(supplierInput.classList.contains("field-invalid")).toBe(false);
  });
});

describe("main.js — cohérence visuelle 'Autre…' vs bouton technicien présélectionné", () => {
  it("taper un nom libre dans 'Autre…' retire le style présélectionné du bouton technicien mémorisé", async () => {
    await loadApp({ shipments: [], presetLocalStorage: { "shiptrack.lastTech": "julie" } });

    const julieBtn = () => [...document.querySelectorAll("[data-tech]")].find((b) => b.dataset.tech === "julie");
    expect(julieBtn().classList.contains("preselected")).toBe(true);

    document.getElementById("tech-custom").value = "Quelqu'un d'autre";
    document.getElementById("tech-custom").dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(julieBtn().classList.contains("preselected")).toBe(false);

    document.getElementById("tech-custom").value = "";
    document.getElementById("tech-custom").dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(julieBtn().classList.contains("preselected")).toBe(true);
  });
});

describe("main.js — Ctrl+Entrée valide la saisie rapide en gardant les champs", () => {
  it("garde Agence/Matériel/Transporteur/Destinataire, vide le n° de suivi, remet le focus dessus", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Voiron";
    document.getElementById("q-material").value = "Écran";
    document.getElementById("q-tracking").value = "6917777419334322";
    document.getElementById("q-carrier").value = "TNT";
    document.getElementById("q-recipient").value = "Jean Dupont";

    document
      .getElementById("quick-add-row")
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeMock).toHaveBeenCalledWith("create_shipment", expect.anything());
    expect(document.getElementById("q-supplier").value).toBe("Voiron");
    expect(document.getElementById("q-material").value).toBe("Écran");
    expect(document.getElementById("q-carrier").value).toBe("TNT");
    expect(document.getElementById("q-recipient").value).toBe("Jean Dupont");
    expect(document.getElementById("q-tracking").value).toBe("");
    expect(document.activeElement.id).toBe("q-tracking");
  });

  it("un Entrée simple (sans Ctrl) continue de tout vider comme avant", async () => {
    await loadApp({ shipments: [] });
    document.getElementById("q-supplier").value = "Voiron";
    document.getElementById("q-material").value = "Écran";

    document
      .getElementById("quick-add-row")
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(document.getElementById("q-supplier").value).toBe("");
    expect(document.getElementById("q-material").value).toBe("");
    expect(document.activeElement.id).toBe("q-supplier");
  });
});
