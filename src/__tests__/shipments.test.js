import { describe, it, expect } from "vitest";
import { compareValues, sortShipments, filterShipments, matchesTechnician } from "../shipments.js";

describe("compareValues", () => {
  it("compare deux chaînes avec localeCompare", () => {
    expect(compareValues("a", "b")).toBeLessThan(0);
    expect(compareValues("b", "a")).toBeGreaterThan(0);
    expect(compareValues("a", "a")).toBe(0);
  });

  it("place null/undefined avant toute valeur définie", () => {
    expect(compareValues(null, "a")).toBeLessThan(0);
    expect(compareValues("a", null)).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(undefined, "a")).toBeLessThan(0);
  });

  it("compare des dates ISO en tant que chaînes (ordre chronologique préservé)", () => {
    expect(compareValues("2026-01-01", "2026-02-01")).toBeLessThan(0);
  });
});

describe("sortShipments", () => {
  const list = [
    { id: "1", expected_date: "2026-03-01" },
    { id: "2", expected_date: "2026-01-01" },
    { id: "3", expected_date: null },
    { id: "4", expected_date: "2026-02-01" },
  ];

  it("trie par clé croissante, null en premier", () => {
    const sorted = sortShipments(list, "expected_date", "asc");
    expect(sorted.map((s) => s.id)).toEqual(["3", "2", "4", "1"]);
  });

  it("trie par clé décroissante", () => {
    const sorted = sortShipments(list, "expected_date", "desc");
    expect(sorted.map((s) => s.id)).toEqual(["1", "4", "2", "3"]);
  });

  it("ne mute pas le tableau d'origine", () => {
    const original = [...list];
    sortShipments(list, "expected_date", "asc");
    expect(list).toEqual(original);
  });
});

describe("filterShipments", () => {
  const shipments = [
    { id: "1", supplier: "Voiron", material: "Écran", status: "shipped", expected_date: "2026-09-01", tracking_number: "ABC", recipient: null, carrier: null },
    { id: "2", supplier: "Vannes", material: "PC", status: "ordered", expected_date: null, tracking_number: null, recipient: null, carrier: null },
    { id: "3", supplier: "Voiron", material: "Câble HDMI", status: "received", expected_date: "2026-01-01", tracking_number: null, recipient: null, carrier: null },
  ];
  const identity = (s) => s.toLowerCase();

  it("filtre par statut", () => {
    const result = filterShipments(shipments, { statusFilter: "shipped", normalizeFn: identity });
    expect(result.map((s) => s.id)).toEqual(["1"]);
  });

  it("filtre par recherche texte (normalisée par le caller)", () => {
    const result = filterShipments(shipments, { normalizedSearch: "voiron", normalizeFn: identity });
    expect(result.map((s) => s.id).sort()).toEqual(["1", "3"]);
  });

  it("recherche sur le numéro de suivi", () => {
    const result = filterShipments(shipments, { normalizedSearch: "abc", normalizeFn: identity });
    expect(result.map((s) => s.id)).toEqual(["1"]);
  });

  it("sans aucun filtre retourne tout", () => {
    const result = filterShipments(shipments, { normalizeFn: identity });
    expect(result.length).toBe(3);
  });

  it("combine statut + recherche", () => {
    const result = filterShipments(shipments, {
      statusFilter: "received",
      normalizedSearch: "voiron",
      normalizeFn: identity,
    });
    expect(result.map((s) => s.id)).toEqual(["3"]);
  });

  it("filtre par technicien (texte 'Traité par: X' dans les notes)", () => {
    const withNotes = [
      { ...shipments[0], notes: "Traité par: Julie" },
      { ...shipments[1], notes: "Traité par: Amine" },
      { ...shipments[2], notes: null },
    ];
    const result = filterShipments(withNotes, { technicianFilter: "Julie", normalizeFn: identity });
    expect(result.map((s) => s.id)).toEqual(["1"]);
  });

  it("sans technicianFilter ne filtre rien sur les notes", () => {
    const withNotes = [
      { ...shipments[0], notes: "Traité par: Julie" },
      { ...shipments[1], notes: null },
    ];
    const result = filterShipments(withNotes, { normalizeFn: identity });
    expect(result.length).toBe(2);
  });
});

describe("matchesTechnician", () => {
  const identity = (s) => s.toLowerCase();

  it("retourne true si aucun technicien filtré (pas de filtre actif)", () => {
    expect(matchesTechnician({ notes: null }, "", identity)).toBe(true);
    expect(matchesTechnician({ notes: null }, null, identity)).toBe(true);
  });

  it("retourne true quand les notes contiennent 'Traité par: X'", () => {
    expect(matchesTechnician({ notes: "Traité par: Julie" }, "Julie", identity)).toBe(true);
  });

  it("retourne false quand un autre technicien est mentionné", () => {
    expect(matchesTechnician({ notes: "Traité par: Amine" }, "Julie", identity)).toBe(false);
  });

  it("retourne false quand il n'y a pas de notes", () => {
    expect(matchesTechnician({ notes: null }, "Julie", identity)).toBe(false);
    expect(matchesTechnician({}, "Julie", identity)).toBe(false);
  });

  // Régression : "Julie" matchait par simple sous-chaîne, donc filtrer sur
  // "Julie" retournait aussi les lignes traitées par "Julien" (deux personnes
  // différentes). Le nom doit désormais correspondre à un technicien ENTIER.
  it("ne matche pas un préfixe partiel (Julie ne doit pas matcher Julien)", () => {
    expect(matchesTechnician({ notes: "Traité par: Julien" }, "Julie", identity)).toBe(false);
  });

  // Régression : le format "Traité par : X" avec un espace avant les ":"
  // n'était pas reconnu du tout (recherche par égalité de chaîne exacte
  // "traité par: x"), alors que ça reste manifestement la même information.
  it("reconnaît le format avec un espace avant les deux-points", () => {
    expect(matchesTechnician({ notes: "Traité par : Julie" }, "Julie", identity)).toBe(true);
  });

  // Les données réelles contiennent des lignes traitées par plusieurs
  // techniciens séparés par "/" (ex: "jp / julie", "Marie / Julie"). Chacun
  // doit pouvoir retrouver la ligne, peu importe sa position.
  it("matche chaque technicien d'une ligne traitée à plusieurs, séparés par '/'", () => {
    expect(matchesTechnician({ notes: "Traité par: julie/amine" }, "julie", identity)).toBe(true);
    expect(matchesTechnician({ notes: "Traité par: julie/amine" }, "amine", identity)).toBe(true);
    expect(matchesTechnician({ notes: "Traité par: jp / julie" }, "julie", identity)).toBe(true);
  });

  it("s'arrête au séparateur '|' utilisé pour d'autres informations dans les notes", () => {
    expect(matchesTechnician({ notes: "Traité par: Amine | vérifié par Julie" }, "Julie", identity)).toBe(false);
    expect(matchesTechnician({ notes: "Traité par: Amine | vérifié par Julie" }, "Amine", identity)).toBe(true);
  });

  // Contrat entre écriture et lecture : la saisie rapide (main.js) et l'import
  // Excel (import.rs) écrivent tous les deux exactement `Traité par: {nom}`
  // dans les notes. Ce test verrouille explicitement ce format littéral —
  // si un futur changement d'écriture s'en écarte sans mettre à jour
  // matchesTechnician (ou l'inverse), ce test échoue immédiatement au lieu
  // de laisser le filtre casser silencieusement.
  it("reconnaît exactement le format écrit par la saisie rapide et l'import Excel (`Traité par: {nom}`)", () => {
    const noteEcriteParSaisieRapideOuImport = (nom) => `Traité par: ${nom}`;
    expect(
      matchesTechnician({ notes: noteEcriteParSaisieRapideOuImport("julie") }, "julie", identity)
    ).toBe(true);
  });
});
