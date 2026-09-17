import { describe, it, expect } from "vitest";
import { compareValues, sortShipments, isLate, filterShipments, matchesTechnician } from "../shipments.js";

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

describe("isLate", () => {
  const reference = new Date("2026-09-16T10:00:00");

  it("en retard : date prévue passée, statut non reçu/vérifié", () => {
    expect(isLate({ expected_date: "2026-09-01", status: "shipped" }, reference)).toBe(true);
    expect(isLate({ expected_date: "2026-09-01", status: "ordered" }, reference)).toBe(true);
  });

  it("pas en retard si déjà reçu ou vérifié", () => {
    expect(isLate({ expected_date: "2026-09-01", status: "received" }, reference)).toBe(false);
    expect(isLate({ expected_date: "2026-09-01", status: "verified" }, reference)).toBe(false);
  });

  it("pas en retard sans date prévue", () => {
    expect(isLate({ expected_date: null, status: "shipped" }, reference)).toBe(false);
  });

  it("pas en retard si la date prévue est aujourd'hui ou dans le futur", () => {
    expect(isLate({ expected_date: "2026-09-16", status: "shipped" }, reference)).toBe(false);
    expect(isLate({ expected_date: "2026-09-20", status: "shipped" }, reference)).toBe(false);
  });
});

describe("filterShipments", () => {
  const shipments = [
    { id: "1", supplier: "Voiron", material: "Écran", status: "shipped", expected_date: "2026-09-01", tracking_number: "ABC", recipient: null, carrier: null },
    { id: "2", supplier: "Vannes", material: "PC", status: "ordered", expected_date: null, tracking_number: null, recipient: null, carrier: null },
    { id: "3", supplier: "Voiron", material: "Câble HDMI", status: "received", expected_date: "2026-01-01", tracking_number: null, recipient: null, carrier: null },
  ];
  const identity = (s) => s.toLowerCase();
  const reference = new Date("2026-09-16T10:00:00");

  it("filtre par statut", () => {
    const result = filterShipments(shipments, { statusFilter: "shipped", normalizeFn: identity });
    expect(result.map((s) => s.id)).toEqual(["1"]);
  });

  it("filtre 'en retard uniquement'", () => {
    const result = filterShipments(shipments, { lateOnly: true, normalizeFn: identity, referenceDate: reference });
    expect(result.map((s) => s.id)).toEqual(["1"]); // #3 reçu donc pas en retard, #2 sans date
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
});
