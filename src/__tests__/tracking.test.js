import { describe, it, expect } from "vitest";
import { buildTrackingUrl, isValidTrackingValue, inferCarrier, isNumericTrackingValue } from "../tracking.js";

describe("buildTrackingUrl", () => {
  it("construit une URL 17TRACK valide pour un numéro simple", () => {
    expect(buildTrackingUrl("8117777435649222")).toBe(
      "https://t.17track.net/fr#nums=8117777435649222"
    );
  });

  it("nettoie les espaces autour du numéro", () => {
    expect(buildTrackingUrl("  8117777435649222  ")).toBe(
      "https://t.17track.net/fr#nums=8117777435649222"
    );
  });

  it("encode les caractères spéciaux (espaces internes, etc.)", () => {
    expect(buildTrackingUrl("ABC 123")).toBe("https://t.17track.net/fr#nums=ABC%20123");
  });

  it("retourne null pour une valeur vide", () => {
    expect(buildTrackingUrl("")).toBeNull();
  });

  it("retourne null pour une valeur uniquement composée d'espaces", () => {
    expect(buildTrackingUrl("   ")).toBeNull();
  });

  it("retourne null pour null/undefined", () => {
    expect(buildTrackingUrl(null)).toBeNull();
    expect(buildTrackingUrl(undefined)).toBeNull();
  });
});

describe("isValidTrackingValue", () => {
  const identity = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  it("accepte une valeur vide (affichée 'À éditer' dans le tableau)", () => {
    expect(isValidTrackingValue("", identity)).toBe(true);
    expect(isValidTrackingValue("   ", identity)).toBe(true);
    expect(isValidTrackingValue(null, identity)).toBe(true);
    expect(isValidTrackingValue(undefined, identity)).toBe(true);
  });

  it("accepte un numéro TNT/DPD réel (chiffres uniquement, 8 à 20 caractères)", () => {
    expect(isValidTrackingValue("6917777419334322", identity)).toBe(true);
    expect(isValidTrackingValue("117777527997554", identity)).toBe(true);
  });

  it("accepte 'Non sécurisé', insensible à la casse/accents", () => {
    expect(isValidTrackingValue("Non sécurisé", identity)).toBe(true);
    expect(isValidTrackingValue("non securise", identity)).toBe(true);
    expect(isValidTrackingValue("NON SÉCURISÉ", identity)).toBe(true);
  });

  it("accepte 'À éditer', insensible à la casse/accents", () => {
    expect(isValidTrackingValue("à éditer", identity)).toBe(true);
    expect(isValidTrackingValue("A EDITER", identity)).toBe(true);
  });

  it("rejette le texte libre historique (tnt, dpd tapés comme texte)", () => {
    expect(isValidTrackingValue("tnt", identity)).toBe(false);
    expect(isValidTrackingValue("dpd", identity)).toBe(false);
  });

  it("rejette tout autre texte libre", () => {
    expect(isValidTrackingValue("à programmer", identity)).toBe(false);
    expect(isValidTrackingValue("RECU", identity)).toBe(false);
    expect(isValidTrackingValue("63, boulevard Haussmann 75008 Paris", identity)).toBe(false);
  });

  it("accepte plusieurs numéros valides séparés par un espace ou un tiret (envoi multi-colis)", () => {
    expect(isValidTrackingValue("6917777432681151 6917777432681168", identity)).toBe(true);
    expect(isValidTrackingValue("1617777321266412 - 1617777421607702", identity)).toBe(true);
  });

  it("rejette un nombre trop court ou trop long", () => {
    expect(isValidTrackingValue("1234567", identity)).toBe(false); // 7 chiffres
    expect(isValidTrackingValue("123456789012345678901", identity)).toBe(false); // 21 chiffres
  });
});

describe("isNumericTrackingValue", () => {
  it("vrai pour un numéro TNT/DPD conforme", () => {
    expect(isNumericTrackingValue("6917777419334322")).toBe(true);
    expect(isNumericTrackingValue("117777527997554")).toBe(true);
  });

  it("vrai pour plusieurs numéros séparés (multi-colis)", () => {
    expect(isNumericTrackingValue("6917777432681151 6917777432681168")).toBe(true);
    expect(isNumericTrackingValue("1617777321266412 - 1617777421607702")).toBe(true);
  });

  it("faux pour du texte libre historique (tnt, dpd, à programmer...)", () => {
    expect(isNumericTrackingValue("tnt")).toBe(false);
    expect(isNumericTrackingValue("dpd")).toBe(false);
    expect(isNumericTrackingValue("à programmer semaine 07")).toBe(false);
    expect(isNumericTrackingValue("Non sécurisé")).toBe(false);
  });

  it("faux pour une valeur cassée par un artefact d'export (_x000D_)", () => {
    expect(isNumericTrackingValue("6917777526341571_x000D_")).toBe(false);
  });

  it("vrai pour des numéros multi-colis séparés par tabulation (comme espace/tiret)", () => {
    expect(isNumericTrackingValue("6917777420405590\t6917777420405605")).toBe(true);
  });

  it("faux pour un séparateur non reconnu ('+') entre deux numéros réels", () => {
    // Cas réel observé en base : "6917777526800819 + 6917777420405590\t6917777420405605"
    expect(isNumericTrackingValue("6917777526800819 + 6917777420405590")).toBe(false);
  });

  it("faux pour vide/null/undefined", () => {
    expect(isNumericTrackingValue("")).toBe(false);
    expect(isNumericTrackingValue("   ")).toBe(false);
    expect(isNumericTrackingValue(null)).toBe(false);
    expect(isNumericTrackingValue(undefined)).toBe(false);
  });

  it("faux pour un nombre trop court ou trop long", () => {
    expect(isNumericTrackingValue("1234567")).toBe(false);
    expect(isNumericTrackingValue("123456789012345678901")).toBe(false);
  });
});

describe("inferCarrier", () => {
  it("retourne le transporteur explicite s'il existe, sans deviner", () => {
    expect(inferCarrier("DPD", "6917777419334322")).toBe("DPD");
    expect(inferCarrier("TNT", null)).toBe("TNT");
  });

  it("déduit TNT pour un n° de suivi numérique sans transporteur renseigné", () => {
    expect(inferCarrier(null, "6917777327189028")).toBe("TNT");
    expect(inferCarrier("", "117777527997554")).toBe("TNT");
    expect(inferCarrier(null, "6917777432681151 6917777432681168")).toBe("TNT"); // multi-colis
  });

  it("ne devine rien pour 'Non sécurisé' (peut être TNT ou DPD)", () => {
    expect(inferCarrier(null, "Non sécurisé")).toBeNull();
  });

  it("ne devine rien quand le n° de suivi est vide", () => {
    expect(inferCarrier(null, null)).toBeNull();
    expect(inferCarrier(null, "")).toBeNull();
  });

  it("ne devine rien pour 'À éditer'", () => {
    expect(inferCarrier(null, "À éditer")).toBeNull();
  });
});
