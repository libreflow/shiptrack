import { describe, it, expect } from "vitest";
import {
  NO_DATE_KEY,
  monthKey,
  monthLabel,
  isMonthCollapsed,
  toggleMonthOverride,
  groupByMonth,
} from "../months.js";

describe("monthKey", () => {
  it("extrait YYYY-MM d'une date ISO", () => {
    expect(monthKey("2026-01-28")).toBe("2026-01");
  });

  it("retourne la clé spéciale pour une date absente", () => {
    expect(monthKey(null)).toBe(NO_DATE_KEY);
    expect(monthKey(undefined)).toBe(NO_DATE_KEY);
    expect(monthKey("")).toBe(NO_DATE_KEY);
  });
});

describe("monthLabel", () => {
  it("formate un mois en français", () => {
    expect(monthLabel("2026-01")).toBe("Janvier 2026");
    expect(monthLabel("2026-12")).toBe("Décembre 2026");
  });

  it("libellé dédié pour l'absence de date", () => {
    expect(monthLabel(NO_DATE_KEY)).toBe("Sans date prévue");
  });
});

describe("isMonthCollapsed", () => {
  const current = "2026-09";
  const empty = new Set();

  it("replie un mois passé par défaut", () => {
    expect(isMonthCollapsed("2026-07", current, empty)).toBe(true);
  });

  it("laisse ouvert le mois en cours par défaut", () => {
    expect(isMonthCollapsed("2026-09", current, empty)).toBe(false);
  });

  it("laisse ouvert un mois futur par défaut", () => {
    expect(isMonthCollapsed("2026-11", current, empty)).toBe(false);
  });

  it("laisse toujours ouvert le groupe 'sans date'", () => {
    expect(isMonthCollapsed(NO_DATE_KEY, current, empty)).toBe(false);
  });

  it("respecte un override explicite replié", () => {
    const overrides = new Set(["2026-09"]);
    expect(isMonthCollapsed("2026-09", current, overrides)).toBe(true);
  });

  it("respecte un override explicite ouvert sur un mois passé", () => {
    const overrides = new Set(["!2026-07"]);
    expect(isMonthCollapsed("2026-07", current, overrides)).toBe(false);
  });
});

describe("toggleMonthOverride", () => {
  const current = "2026-09";

  it("bascule un mois passé (replié par défaut) vers ouvert explicite", () => {
    const result = toggleMonthOverride("2026-07", current, new Set());
    expect(result.has("!2026-07")).toBe(true);
    expect(isMonthCollapsed("2026-07", current, result)).toBe(false);
  });

  it("bascule un mois courant (ouvert par défaut) vers replié explicite", () => {
    const result = toggleMonthOverride("2026-09", current, new Set());
    expect(result.has("2026-09")).toBe(true);
    expect(isMonthCollapsed("2026-09", current, result)).toBe(true);
  });

  it("ne mute pas le Set d'origine (pureté)", () => {
    const original = new Set();
    toggleMonthOverride("2026-07", current, original);
    expect(original.size).toBe(0);
  });

  it("bascule deux fois de suite revient à l'état par défaut", () => {
    let overrides = new Set();
    overrides = toggleMonthOverride("2026-07", current, overrides);
    overrides = toggleMonthOverride("2026-07", current, overrides);
    expect(isMonthCollapsed("2026-07", current, overrides)).toBe(true); // retour au défaut (passé = replié)
  });
});

describe("groupByMonth", () => {
  it("groupe par mois en préservant l'ordre de première rencontre", () => {
    const shipments = [
      { id: "1", expected_date: "2026-09-05" },
      { id: "2", expected_date: "2026-07-10" },
      { id: "3", expected_date: "2026-09-20" },
      { id: "4", expected_date: null },
      { id: "5", expected_date: "2026-07-01" },
    ];
    const groups = groupByMonth(shipments);
    expect(groups.map((g) => g.key)).toEqual(["2026-09", "2026-07", NO_DATE_KEY]);
    expect(groups[0].items.map((s) => s.id)).toEqual(["1", "3"]);
    expect(groups[1].items.map((s) => s.id)).toEqual(["2", "5"]);
    expect(groups[2].items.map((s) => s.id)).toEqual(["4"]);
  });

  it("retourne un tableau vide pour une liste vide", () => {
    expect(groupByMonth([])).toEqual([]);
  });
});
