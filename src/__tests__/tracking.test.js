import { describe, it, expect } from "vitest";
import { buildTrackingUrl } from "../tracking.js";

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
