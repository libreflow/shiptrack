import { describe, it, expect } from "vitest";
import {
  normalizeAccents,
  normalizeWhitespace,
  titleCaseFr,
  normalizeAgainstExisting,
  buildShipmentIndex,
  normalizeShipmentPayload,
  levenshteinDistance,
  findSimilarValue,
} from "../normalize.js";

describe("normalizeAccents", () => {
  it("retire les accents et met en minuscule", () => {
    expect(normalizeAccents("Reçu")).toBe("recu");
    expect(normalizeAccents("Vitrolles Aéro")).toBe("vitrolles aero");
  });

  it("ne plante pas sur une chaîne vide", () => {
    expect(normalizeAccents("")).toBe("");
  });
});

describe("normalizeWhitespace", () => {
  it("trim et réduit les espaces multiples à un seul", () => {
    expect(normalizeWhitespace("  Voiron   Aéro  ")).toBe("Voiron Aéro");
  });

  it("réduit aussi les tabulations", () => {
    expect(normalizeWhitespace("a\t\tb")).toBe("a b");
  });
});

describe("titleCaseFr", () => {
  it("met chaque mot en Title Case", () => {
    expect(titleCaseFr("vitrolles aero")).toBe("Vitrolles Aero");
  });

  it("garde les mots de liaison en minuscule (sauf en tête)", () => {
    expect(titleCaseFr("adsearch de nantes")).toBe("Adsearch de Nantes");
  });

  it("garde les sigles connus en majuscules", () => {
    expect(titleCaseFr("is manitou ancenis")).toBe("IS Manitou Ancenis");
    expect(titleCaseFr("hub vitrolles")).toBe("HUB Vitrolles");
  });

  it("gère les mots à trait d'union", () => {
    expect(titleCaseFr("saint-jean")).toBe("Saint-Jean");
  });

  it("retourne une chaîne vide pour une entrée vide/espaces", () => {
    expect(titleCaseFr("   ")).toBe("");
  });
});

describe("normalizeAgainstExisting", () => {
  it("réutilise la forme canonique déjà en base (insensible casse/accents)", () => {
    const existing = ["Vitrolles Aéro", "Voiron"];
    expect(normalizeAgainstExisting("vitrolles aero", existing)).toBe("Vitrolles Aéro");
    expect(normalizeAgainstExisting("VITROLLES AÉRO", existing)).toBe("Vitrolles Aéro");
  });

  it("applique le Title Case si aucune correspondance existante", () => {
    expect(normalizeAgainstExisting("nouvelle agence", [], { titleCase: true })).toBe("Nouvelle Agence");
  });

  it("ne force pas le Title Case si titleCase=false", () => {
    expect(normalizeAgainstExisting("tel stock remi", [], { titleCase: false })).toBe("tel stock remi");
  });

  it("retourne une chaîne vide pour une entrée vide", () => {
    expect(normalizeAgainstExisting("   ", ["Voiron"])).toBe("");
  });
});

describe("buildShipmentIndex", () => {
  it("construit un index de valeurs distinctes par champ configuré", () => {
    const shipments = [
      { supplier: "Voiron", material: "PC", carrier: "TNT", recipient: "Jean" },
      { supplier: "Voiron", material: "Écran", carrier: null, recipient: null },
      { supplier: "Vannes", material: "PC", carrier: "DPD", recipient: "Marie" },
    ];
    const index = buildShipmentIndex(shipments);
    expect(index.supplier.sort()).toEqual(["Vannes", "Voiron"]);
    expect(index.material.sort()).toEqual(["PC", "Écran"]);
    expect(index.carrier.sort()).toEqual(["DPD", "TNT"]);
    expect(index.recipient.sort()).toEqual(["Jean", "Marie"]);
  });
});

describe("normalizeShipmentPayload", () => {
  const index = { supplier: ["Voiron"], material: [], carrier: [], recipient: [] };

  it("normalise les champs et ne retourne aucune erreur si les requis sont remplis", () => {
    const { values, errors } = normalizeShipmentPayload(
      { supplier: "voiron", material: "pc portable", carrier: "TNT", recipient: "Jean Dupont" },
      index
    );
    expect(values.supplier).toBe("Voiron"); // réutilise la forme canonique existante
    expect(values.material).toBe("pc portable"); // pas de titleCase pour material
    expect(values.carrier).toBe("TNT");
    expect(values.recipient).toBe("Jean Dupont");
    expect(errors).toEqual([]);
  });

  it("signale les champs requis manquants avec leur libellé", () => {
    const { errors } = normalizeShipmentPayload({ supplier: "", material: "" }, index);
    expect(errors).toContain("Agence");
    expect(errors).toContain("Matériel");
  });

  it("les champs optionnels vides deviennent null sans erreur", () => {
    const { values, errors } = normalizeShipmentPayload(
      { supplier: "voiron", material: "pc", carrier: "", recipient: "" },
      index
    );
    expect(values.carrier).toBeNull();
    expect(values.recipient).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("levenshteinDistance", () => {
  it("retourne 0 pour des chaînes identiques", () => {
    expect(levenshteinDistance("Bollene", "Bollene")).toBe(0);
  });

  it("compte le nombre minimal d'opérations", () => {
    expect(levenshteinDistance("Bollene", "Bolllene")).toBe(1); // insertion
    expect(levenshteinDistance("Dukerque", "Dunkerque")).toBe(1); // substitution
    expect(levenshteinDistance("chat", "chien")).toBeGreaterThan(1);
  });

  it("gère les chaînes vides", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });
});

describe("findSimilarValue", () => {
  it("détecte une faute de frappe probable (distance <= 3, ratio <= 20%)", () => {
    expect(findSimilarValue("Bolllene", ["Bollene", "Voiron"])).toBe("Bollene");
    expect(findSimilarValue("Dukerque", ["Dunkerque", "Paris"])).toBe("Dunkerque");
    expect(findSimilarValue("Asniere sur Seine", ["Asnieres sur Seine"])).toBe("Asnieres sur Seine");
  });

  it("ne signale pas une valeur déjà identique (insensible casse/accents)", () => {
    expect(findSimilarValue("bollene", ["Bollene"])).toBeNull();
    expect(findSimilarValue("BOLLENE", ["Bollene"])).toBeNull();
  });

  it("ne signale rien pour une valeur trop courte (< 6 caractères, trop de faux positifs)", () => {
    expect(findSimilarValue("Agen", ["Agen2", "Anger"])).toBeNull();
  });

  it("ne signale rien quand aucune valeur existante n'est assez proche", () => {
    expect(findSimilarValue("Toute Nouvelle Agence", ["Voiron", "Bollene"])).toBeNull();
  });

  it("retourne null pour une valeur vide", () => {
    expect(findSimilarValue("", ["Voiron"])).toBeNull();
    expect(findSimilarValue(null, ["Voiron"])).toBeNull();
  });

  it("accepte un compromis avec de rares faux positifs sur des mots courts proches (seuil calibré sur les 563 agences réelles)", () => {
    // "Poissy"/"Roissy" sont deux vraies villes différentes mais à distance 1 —
    // le seuil reste volontairement permissif car ce n'est qu'un avertissement
    // dismissable, jamais un blocage (voir doc de findSimilarValue).
    expect(findSimilarValue("Poissy", ["Roissy"])).toBe("Roissy");
  });
});
